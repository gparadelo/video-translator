# Video Translator

A Claude Code plugin that turns one finished short-form video (voiceover only) into versions in other languages, spoken in your ElevenLabs voice, with the clips re-timed so each cut still lands on the right word.

## What you need
- [Claude Code](https://claude.com/claude-code) with a Claude subscription
- An [ElevenLabs](https://elevenlabs.io) account: the ID of the voice to use, and an API key with these permissions:

  | Permission | Used for |
  |---|---|
  | Text to Speech | voicing the translations |
  | Speech to Text | transcribing the original voiceover when there's no `script.txt` |
  | Forced Alignment | timing each word of the original voiceover |

  Everything else can be left at No access. If you plan to always write `script.txt` yourself, Speech to Text isn't used.
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
- Rendering uses `video_codec` under `[render]` (default `hevc_videotoolbox`, macOS). If it can't run on the machine, the first working one of `hevc_nvenc`, `hevc_qsv`, `hevc_amf`, `libx265`, `libx264` is used instead.

## Without Claude Code
`scripts/vt.py` also runs on its own, with the Claude API doing the translation instead of Claude Code. It reads the keys from a `.env` file in your jobs folder (see [.env.example](.env.example)): `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` and `ANTHROPIC_API_KEY`.

```
uv run scripts/vt.py run <job>            # all default languages
uv run scripts/vt.py run <job> de fr      # just these
```
This analyzes the video (transcribing it if there's no `script.txt`, then letting Claude fix misspelled names), translates each language, voices it, lets Claude rewrite beats that don't fit (up to 3 rounds), and renders. An existing `work/<lang>/script.json` is reused; `--retranslate` makes a fresh one, `--no-render` stops before rendering so you can check the reports. Model and effort are under `[claude]` in [config.default.toml](config.default.toml).

To check the transcript before paying for voices, run it in two halves:
```
uv run scripts/vt.py prepare <job>        # transcribe, fix names, analyze; then check script.txt / cuts.txt
uv run scripts/vt.py produce <job> de fr  # translate, voice, fit, render (re-analyzes if you edited them)
```
For the name check, a `reference.txt` (or `script_*.txt`) in the job folder gives Claude the right spelling. A `job.toml` in the job folder overrides settings for that job only, e.g. `languages`, or `voice_id` under `[elevenlabs]`. `uv run scripts/vt.py --help` lists the single steps.
