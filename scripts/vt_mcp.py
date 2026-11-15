#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["requests", "mcp>=1.2,<2"]
# ///
"""
MCP server that exposes vt.py's steps as tools for Claude Code.

The plugin starts it with ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID / VT_JOBS_DIR in its environment
(taken from the plugin's settings, the key from the system keychain), so the key never appears in
the chat, in shell commands, or in a file.
"""
from __future__ import annotations

import contextlib
import io
import os
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vt  # noqa: E402
from mcp.server.fastmcp import FastMCP  # noqa: E402

mcp = FastMCP("video-translator")


def _ensure_jobs_dir():
    """Create the jobs folder on first use, so the default works without any setup."""
    jd = vt.jobs_dir()
    if jd and not jd.exists():
        try:
            jd.mkdir(parents=True)
        except OSError:
            pass


def _run(fn, **kw) -> str:
    """Run a vt command, capturing its output (stdout is the MCP channel, so nothing may print there)."""
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            vt.load_env()
            _ensure_jobs_dir()
            vt.check_tools()
            fn(SimpleNamespace(**kw))
    except SystemExit:
        raise RuntimeError(buf.getvalue().strip() or "failed") from None
    return buf.getvalue().strip() or "done"


def _is_set(name: str) -> bool:
    v = os.environ.get(name, "").strip()
    return bool(v) and not v.startswith("${")


@mcp.tool()
def setup_status() -> str:
    """Check the setup: ffmpeg/ffprobe/uv installed, ElevenLabs key and voice configured, jobs folder,
    target languages, and the jobs found. Never reveals the key."""
    vt.load_env()
    _ensure_jobs_dir()
    jd = vt.jobs_dir()
    cfg = vt.config(None)
    lines = [
        f"ffmpeg: {'ok' if shutil.which('ffmpeg') else 'MISSING (brew install ffmpeg)'}",
        f"ffprobe: {'ok' if shutil.which('ffprobe') else 'MISSING (brew install ffmpeg)'}",
        f"ElevenLabs API key: {'set' if _is_set('ELEVENLABS_API_KEY') else 'NOT SET'}",
        f"ElevenLabs voice ID: {'set' if _is_set('ELEVENLABS_VOICE_ID') else 'NOT SET'}",
        f"jobs folder: {jd if jd else 'NOT SET'}{'' if not jd or jd.is_dir() else ' (does not exist and could not be created)'}",
        f"target languages: {', '.join(cfg.get('languages', []))}",
        f"config override: {jd / 'config.toml' if jd and (jd / 'config.toml').exists() else 'none (using defaults)'}",
    ]
    if jd and jd.is_dir():
        jobs = sorted(d.name for d in jd.iterdir() if d.is_dir())
        lines.append(f"jobs: {', '.join(jobs) or 'none yet'}")
    return "\n".join(lines)


@mcp.tool()
def analyze(job: str, base_lang: str = "") -> str:
    """Prepare a job: if there is no script.txt, transcribe the voiceover and write one (detecting the
    language); align the voiceover to the script, detect cuts (writes cuts.txt if missing) and write
    work/analysis.json plus work/translate_brief.md. `job` is a job folder name or path; `base_lang`
    is the original voiceover's language (e.g. "es"), optional when the script is transcribed."""
    return _run(vt.cmd_analyze, job=job, lang=base_lang or None)


@mcp.tool()
def tts(job: str, lang: str) -> str:
    """Generate the ElevenLabs voiceover for work/<lang>/script.json (cached per beat, so re-runs
    only pay for beats whose text or speed changed)."""
    return _run(vt.cmd_tts, job=job, lang=lang)


@mcp.tool()
def plan(job: str, lang: str) -> str:
    """Fit the video clips to the new voiceover and write work/<lang>/report.md. Lines starting
    with '!' are problems to fix in script.json before rendering."""
    return _run(vt.cmd_plan, job=job, lang=lang)


@mcp.tool()
def render(job: str, lang: str) -> str:
    """Render out/<job>_<lang>.mp4 from the last plan. Takes a few minutes for a 4K video."""
    return _run(vt.cmd_render, job=job, lang=lang)


if __name__ == "__main__":
    mcp.run()
