# Video Translator

A Claude Code plugin that turns one finished short-form video (voiceover only) into versions in other languages, spoken in your ElevenLabs voice, with the clips re-timed so each cut still lands on the right word.

## What you need
- [Claude Code](https://claude.com/claude-code) with a Claude subscription
- An [ElevenLabs](https://elevenlabs.io) account: an API key and the ID of the voice to use
- `ffmpeg` and `uv`: `brew install ffmpeg uv`

## Install
In Claude Code:
```
/plugin marketplace add gparadelo/video-translator
/plugin install video-translator@video-translator
```
Claude Code then asks for your **ElevenLabs API key** (stored in your system keychain, never in a file), your **voice ID**, and your **jobs folder**: where your videos live. The jobs folder defaults to `~/Documents/Video Translations` and is created on first use. Any other folder needs a full path such as `~/Movies/Translations`; a relative path counts from your home folder. You can change all three later in `/plugin` → video-translator → Configure.

A step-by-step guide to share with new users is in [docs/setup-guide.html](docs/setup-guide.html).

Run `/video-translator:setup` to check everything is in place.

## Per video
1. Make a folder `<jobs folder>/<name>/` and put the exported video in it (`base.mp4`, or any single .mp4/.mov).
2. In Claude Code: `/video-translator:translate <name>`, optionally followed by language codes, e.g. `de fr`.
3. Results go to `<name>/out/`: one `.mp4` per language.

The voiceover is transcribed into `<name>/script.txt` (one beat per paragraph), and its language is detected. You can also write `script.txt` yourself, but it must say exactly what the voiceover says. If it doesn't match, delete it and let it be transcribed. If a written script is in the folder (e.g. `script_original.txt`), Claude uses it only to fix the spelling of names.

## How it works
- **analyze:** transcribes the voiceover if there's no `script.txt`, aligns it to the script (word timings), detects cuts (`cuts.txt`, editable), and ties every cut to the word being spoken.
- **translate:** Claude translates each beat to fit the original timing and keeps the `{n}` cut markers on the matching words.
- **tts:** ElevenLabs generates each beat with timestamps (cached, so re-runs only pay for changed beats).
- **plan:** fits each clip between its cuts. In order it uses: the pauses between beats, a small voice tempo change (up to 7%), clip speed (90 to 110%), and trimming the end of a clip. Anything that still doesn't fit is flagged, and Claude rewrites those beats and tries again. The details go to `<name>/work/<lang>/report.md`.
- **render:** FFmpeg re-times each clip, adds the new voice at the base loudness, and outputs 4K HEVC.

If a cut is detected wrong, or you want a sync point inside a clip (e.g. the moment a light changes colour), edit `<name>/cuts.txt` and run the translation again.

## Settings
- **One extra language for one video:** name it in the command, e.g. `/video-translator:translate <name> pt` for Portuguese. Use the 2-letter code. Any language the ElevenLabs model speaks works.
- **Change the default languages:** create `config.toml` in your jobs folder with one line, e.g. `languages = ["en", "es", "fr", "pt"]`.
- **ElevenLabs model, fitting limits, encoder:** copy [config.default.toml](config.default.toml) to `config.toml` in your jobs folder and keep only the keys you change.
- **A different voice for one language:** add `ELEVENLABS_VOICE_ID_DE=...` (etc.) to a `.env` file in your jobs folder.
- Rendering uses `hevc_videotoolbox` (macOS). On other systems set `video_codec = "libx265"` under `[render]`.

## Without Claude Code
`scripts/vt.py` also runs on its own (`uv run scripts/vt.py --help`), reading the key from a `.env` file (see [.env.example](.env.example)). You then write `work/<lang>/script.json` yourself.
