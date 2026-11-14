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
The repository is private: you need to be invited as a collaborator, and git on your machine must be signed in to GitHub (`gh auth login` is the easiest way).

Claude Code then asks for your **ElevenLabs API key** (stored in your system keychain, never in a file), your **voice ID**, and your **jobs folder** (where your videos live). You can change them later in `/plugin` → video-translator → Configure.

Run `/video-translator:setup` to check everything is in place.

## Per video
1. Make a folder `<jobs folder>/<name>/` with the exported video (`base.mp4`, or any single .mp4/.mov) and `script.txt`: the exact voiceover text, one beat per paragraph (blank line between beats).
2. In Claude Code: `/video-translator:translate <name>` (optionally followed by languages, e.g. `de fr`).
3. Results go to `<name>/out/`: one `.mp4` plus a `_report.md` per language.

## How it works
- **analyze:** aligns your voiceover to the script (word timings), detects cuts (`cuts.txt`, editable), and ties every cut to the word being spoken.
- **translate:** Claude translates each beat to fit the original timing and keeps the `{n}` cut markers on the matching words.
- **tts:** ElevenLabs generates each beat with timestamps (cached, so re-runs only pay for changed beats).
- **plan:** fits each clip between its cuts. In order it uses: the pauses between beats, a small voice tempo change (up to 7%), clip speed (90 to 110%), and trimming the end of a clip. Anything that still doesn't fit is flagged, and Claude rewrites those beats and tries again.
- **render:** FFmpeg re-times each clip, adds the new voice at the base loudness, and outputs 4K HEVC.

If a cut is detected wrong, or you want a sync point inside a clip (e.g. the moment a light changes colour), edit `<name>/cuts.txt` and run the translation again.

## Settings
- **Languages, ElevenLabs model, fitting limits, encoder:** copy [config.default.toml](config.default.toml) to `config.toml` in your jobs folder and keep only the keys you change.
- **A different voice for one language:** add `ELEVENLABS_VOICE_ID_DE=...` (etc.) to a `.env` file in your jobs folder.
- Rendering uses `hevc_videotoolbox` (macOS). On other systems set `video_codec = "libx265"` under `[render]`.

## Without Claude Code
`scripts/vt.py` also runs on its own (`uv run scripts/vt.py --help`), reading the key from a `.env` file (see [.env.example](.env.example)). You then write `work/<lang>/script.json` yourself.
