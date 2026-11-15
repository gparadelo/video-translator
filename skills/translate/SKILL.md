---
name: translate
description: Translate a finished short-form voiceover video into other languages with the user's ElevenLabs voice, re-timing clips so each cut still lands on its word. Use when the user asks to translate, dub or localise a video, or runs /video-translator:translate <job>.
argument-hint: <job> [languages]
---

# Translate a video

The user gave: `$ARGUMENTS` — a job name (a subfolder of the jobs folder) and optionally the target languages.
All work goes through the `vt` MCP tools of this plugin (`setup_status`, `analyze`, `tts`, `plan`, `render`).
Never ask the user for their ElevenLabs key and never run vt.py through Bash with a key: the tools already have it.

## 0. Check the setup
Call `setup_status`. If anything says MISSING or NOT SET, stop and tell the user exactly what to fix
(see the `setup` skill), then continue once it is fixed. If no job was given, list the jobs and ask which one.

A job folder holds the finished video (`base.mp4`, or any single .mp4/.mov). `script.txt` (the voiceover text,
one beat per paragraph) is optional: without it, `analyze` transcribes the voiceover and writes it.

## 1. Analyze
- **No `script.txt`:** call `analyze(job)`. It transcribes the voiceover, writes `script.txt`, and detects the
  language. Then read `script.txt` and fix only obvious transcription mistakes in names (brands, products),
  using any written script in the folder (e.g. `script_original.txt`) or what the user told you as the reference
  for spelling. Never change the wording to match a written script: the text must say what the voiceover says.
  If you changed anything, call `analyze(job)` again.
- **`script.txt` exists:** work out its language and call `analyze(job, base_lang)`.
- Pass on any WARNING it prints (script doesn't match the voiceover, few words matched). Fix those in
  `script.txt` first; translating on top of a bad alignment wastes TTS credits. If the user wrote the script
  themselves and it doesn't match, suggest deleting `script.txt` so it's transcribed from the audio instead.
- The first time, it writes `cuts.txt` (auto-detected cuts). Tell the user they can edit it (delete false cuts,
  add missed ones or sync points inside a clip) and re-run analyze; carry on unless they want to review.

Then read `<job>/work/translate_brief.md` (and `work/analysis.json` if you need more detail).

## 2. Translate (you do this step)
Target languages: the ones the user named, otherwise `target languages` from `setup_status`, skipping the base
language. Use 2-letter codes (`nl` Dutch, `pt` Portuguese, `pl` Polish…); any language the ElevenLabs model
speaks works. For each language write `<job>/work/<lang>/script.json`:

```json
{
  "lang": "fr",
  "beats": [
    { "id": 1, "text": "Tu veux intégrer la luminothérapie {1}LED à ta {2}routine visage ?" },
    { "id": 2, "speed": 1.1, "text": "Avec {5}ce masque {6}LED {7}Nanoleaf, c'est possible." }
  ]
}
```

Rules:
- Exactly the same beats, same `id`s and order as the brief.
- Keep **every** `{n}` marker, each once, directly in front of the word that carries the same meaning as in the
  original. Each marker is a video cut that has to land on that word. Keep markers in increasing order when the
  grammar allows it.
- Fit the timing: each beat should take about as long to say as the original (the brief gives seconds and
  characters per beat, and the base speaking rate). Prefer natural, spoken, short-form-video phrasing over a literal
  translation; shorten when a language runs long (German, French usually do).
- Match the register of the original (informal "tú" → "tu"/"du"; formal → formal). Never translate brand or
  product names.
- `speed` is optional (0.7–1.2, default from config). Only add it when a beat can't be shortened without losing meaning.

## 3. Voice, fit, fix — up to 3 rounds per language
1. `tts(job, lang)`, then `plan(job, lang)`.
2. Every line starting with `!` is a problem, e.g. "beat 3 … ~0.40s too long – shorten the text or raise its speed".
   Fix it in `script.json`: rewrite the beat shorter/longer first; use `speed` only for the last bit.
   "marker {n} is missing" means you dropped a marker – put it back.
3. Repeat. TTS is cached per beat, so only edited beats cost credits. After 3 rounds, stop and report what's left.

## 4. Render
`render(job, lang)` for each language (a few minutes each for 4K). Output: `<job>/out/<job>_<lang>.mp4`.
The fitting details stay in `<job>/work/<lang>/report.md`.

## 5. Report
Per language: the output path, its length vs the original, and anything still flagged (with the time in the
video, so the user can jump to it). If nothing is flagged, say so in one line. Don't paste the report's tables.
