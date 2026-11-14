---
name: setup
description: Check and fix the Video Translator setup (ffmpeg, uv, ElevenLabs key and voice, jobs folder). Use when the user runs /video-translator:setup, installs the plugin for the first time, or a vt tool reports something missing.
---

# Video Translator setup

1. Call the `setup_status` tool of the `vt` MCP server.
   - If the tool isn't available at all, the MCP server didn't start. The usual cause is that `uv` is missing or
     not on Claude Code's PATH: run `which uv`. If missing, tell the user to install it
     (`curl -LsSf https://astral.sh/uv/install.sh | sh`, or `brew install uv`) and restart Claude Code.
2. For each line that isn't ok:
   - **ffmpeg / ffprobe MISSING** → `brew install ffmpeg` (offer to run it).
   - **API key / voice ID NOT SET, or jobs folder NOT SET** → the user sets these in Claude Code: `/plugin` →
     Installed → video-translator → Configure (or `/config`). The key is stored in the system keychain.
     Never ask them to paste the key into the chat.
   - **jobs folder does not exist** → offer to create it.
3. Optional, explain only if relevant:
   - A different voice for one language: add `ELEVENLABS_VOICE_ID_DE=...` (etc.) to a `.env` file in the jobs folder.
   - Different target languages, ElevenLabs model or fitting limits: copy `config.default.toml` from
     `${CLAUDE_PLUGIN_ROOT}` to `config.toml` in the jobs folder and edit only the keys to change.
4. Finish by telling the user how to start: put a video and its `script.txt` in `<jobs folder>/<name>/`, then run
   `/video-translator:translate <name>`.
