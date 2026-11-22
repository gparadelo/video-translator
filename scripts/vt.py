#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["requests", "anthropic"]
# ///
"""
vt.py - translate a short-form product video into other languages.

  uv run vt.py run       jobs/<name> [de fr]      # prepare + produce, translation by the Claude API
  uv run vt.py prepare   jobs/<name>              # transcribe, fix names, analyze - then check script.txt
  uv run vt.py produce   jobs/<name> [de fr]      # translate, voice, fit, render every language
  uv run vt.py analyze   jobs/<name> --lang es    # base voiceover + cuts -> anchors, translation brief
  uv run vt.py translate jobs/<name> fr           # Claude API writes work/fr/script.json
  uv run vt.py tts       jobs/<name> fr           # ElevenLabs voiceover with timestamps (cached)
  uv run vt.py plan      jobs/<name> fr           # fit video to voiceover, write report (no render)
  uv run vt.py render    jobs/<name> fr           # render jobs/<name>/out/<name>_fr.mp4

In the Claude Code plugin, Claude Code itself does the translate step (no API key needed).
A worker can import this file and call prepare() / produce() directly (see set_reporter()).
<job> is a folder path, or just a name when VT_JOBS_DIR points at the folder that holds the jobs.
Settings: ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID (and ANTHROPIC_API_KEY for translate/run) come from
the environment (the plugin sets the ElevenLabs ones), or from a .env file in the jobs folder or the
current folder. config.default.toml holds the defaults; a config.toml in the jobs folder overrides any of them.
"""
from __future__ import annotations

import argparse
import array
import base64
import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
import unicodedata
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent  # plugin / repo root
API = "https://api.elevenlabs.io"
MARK = re.compile(r"\{(\d+)\}")
SR = 44100


# ----------------------------------------------------------------------------- helpers

class VTError(Exception):
    """Something the user has to fix (missing key, bad script, failed API call). The message says what."""


def die(msg: str):
    raise VTError(msg)


# Progress goes through one reporter, so the CLI can print it and a worker can forward it to the web app.
# Every event has "msg" (text for a person, may be None) and optionally: "stage" (transcribe, align, cuts,
# analyze, translate, rewrite, tts, plan, render, preview, done), "lang", "done"/"total" (counts within the stage),
# "level" ("info" / "warning") and "usage" (API usage to bill: {"service", ...amounts}).
_reporter = None


def set_reporter(fn):
    """fn(event: dict) receives every progress event; None restores printing."""
    global _reporter
    _reporter = fn


def log(msg: str | None, **event):
    event = {"msg": msg, "level": "info", **event}
    if _reporter:
        _reporter(event)
    elif msg is not None:
        print(msg, flush=True)
    elif event.get("done") is not None and event.get("total"):
        print(f"\r  {event['stage']} {event['done']}/{event['total']}", end="\n" if event["done"] == event["total"] else "",
              flush=True)


def warn(msg: str, **event):
    log(f"WARNING: {msg}", level="warning", **event)


DEFAULT_JOBS_DIR = "~/Documents/Video Translations"


def jobs_dir() -> Path | None:
    """The folder that holds the jobs. `~` is expanded, and a relative path counts from the home
    folder, so it means the same thing whichever folder Claude Code was started in."""
    v = os.environ.get("VT_JOBS_DIR", "").strip().strip('"').strip("'")
    if not v or v.startswith("${"):
        v = DEFAULT_JOBS_DIR
    p = Path(v).expanduser()
    return p if p.is_absolute() else Path.home() / p


def load_env():
    """Values already in the environment win; .env files only fill gaps (standalone use)."""
    for d in [jobs_dir(), Path.cwd(), ROOT]:
        p = d / ".env" if d else None
        if not p or not p.exists():
            continue
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            cur = os.environ.get(k, "").strip()
            if v and (not cur or cur.startswith("${")):  # empty or unfilled plugin setting
                os.environ[k] = v


# Keys for the job being run, set by the web app's worker (each person's own keys). They win over the
# environment; KEYS_WHERE is where error messages tell people to fix a key.
_job_keys: dict[str, str] = {}
KEYS_WHERE = "/plugin -> video-translator -> Configure (standalone: the .env file)"


def use_keys(**keys: str):
    """use_keys(ELEVENLABS_API_KEY=..., ANTHROPIC_API_KEY=...) for the next job; use_keys() clears them."""
    _job_keys.clear()
    _job_keys.update({k: v for k, v in keys.items() if v})


def env(name: str) -> str:
    if _job_keys.get(name):
        return _job_keys[name]
    v = os.environ.get(name, "").strip()
    if not v or v.startswith("${"):
        die(f"{name} is not set. Set it in {KEYS_WHERE}.")
    return v


def voice_for(lang: str, cfg: dict) -> str:
    """Voice for one language: the job's settings first (job.toml), then the environment / .env."""
    el = cfg.get("elevenlabs", {})
    return ((el.get("voice_ids") or {}).get(lang) or el.get("voice_id")
            or os.environ.get(f"ELEVENLABS_VOICE_ID_{lang.upper()}", "").strip() or env("ELEVENLABS_VOICE_ID"))


def _merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in over.items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def config(job: Path | None = None) -> dict:
    """Shipped defaults, overridden by a config.toml in the jobs folder (if any), overridden in turn by
    the job's own job.toml (written by the web app's worker: languages, voice, anything per job)."""
    cfg = tomllib.loads((ROOT / "config.default.toml").read_text())
    for d in [jobs_dir(), job.parent if job else None]:
        p = d / "config.toml" if d else None
        if p and p.exists():
            cfg = _merge(cfg, tomllib.loads(p.read_text()))
            break
    if job and (job / "job.toml").exists():
        cfg = _merge(cfg, tomllib.loads((job / "job.toml").read_text()))
    return cfg


def check_tools():
    for t in ("ffmpeg", "ffprobe"):
        if not shutil.which(t):
            die(f"{t} not found - install it with `brew install ffmpeg`")


def resolve_job(job: str) -> Path:
    p = Path(job).expanduser()
    if p.is_dir():
        return p
    jd = jobs_dir()
    if jd and (jd / job).is_dir():
        return jd / job
    known = sorted(d.name for d in jd.iterdir() if d.is_dir()) if jd and jd.is_dir() else []
    die(f"job folder '{job}' not found" + (f" in {jd}. Jobs there: {', '.join(known) or 'none'}" if jd else ""))


# ElevenLabs API key permissions this tool needs (everything else can be "No access").
KEY_PERMISSIONS = ("Text to Speech", "Speech to Text", "Forced Alignment")


def api_error(what: str, r, permission: str):
    if r.status_code in (401, 403) and ("permission" in r.text.lower() or "scope" in r.text.lower()):
        die(f"{what} failed: your ElevenLabs API key is missing the '{permission}' permission. "
            f"Edit the key at elevenlabs.io (Developers -> API keys) and enable: {', '.join(KEY_PERMISSIONS)}.")
    if r.status_code == 401:
        die(f"{what} failed: ElevenLabs rejected the API key (401). Check it in {KEYS_WHERE}. "
            f"It needs these permissions: {', '.join(KEY_PERMISSIONS)}.\n{r.text[:300]}")
    die(f"{what} failed ({r.status_code}): {r.text[:500]}")


def sh(cmd: list[str], binary=False) -> subprocess.CompletedProcess:
    r = subprocess.run(cmd, capture_output=True, text=not binary)
    if r.returncode != 0:
        err = r.stderr if not binary else r.stderr.decode(errors="replace")
        die(f"command failed: {' '.join(map(str, cmd))[:300]}\n{err[-2000:]}")
    return r


def probe(path: Path) -> dict:
    r = sh(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)])
    return json.loads(r.stdout)


def video_size(path: Path) -> tuple[int, int]:
    """The size the video is shown at (width, height), with phone rotation applied, as ffmpeg decodes it."""
    vs = next(s for s in probe(path)["streams"] if s["codec_type"] == "video")
    w, h = int(vs["width"]), int(vs["height"])
    rot = vs.get("tags", {}).get("rotate")
    for sd in vs.get("side_data_list", []):
        if "rotation" in sd:
            rot = sd["rotation"]
    if rot is not None and abs(int(float(rot))) % 180 == 90:
        w, h = h, w
    return w, h


def render_size(src_w: int, src_h: int) -> tuple[int, int]:
    """Output size: the source's own size (never upscaled), rounded down to even numbers for the encoder."""
    return max(2, src_w - src_w % 2), max(2, src_h - src_h % 2)


def scaled_bitrate(bitrate: str, w: int, h: int) -> str:
    """`bitrate` is for 4K (3840x2160); smaller videos get less, a bit more than in proportion to pixels."""
    m = re.fullmatch(r"([\d.]+)([kKmM]?)", bitrate.strip())
    if not m:
        return bitrate
    bps = float(m[1]) * {"": 1, "k": 1e3, "m": 1e6}[m[2].lower()]
    bps *= (w * h / (3840 * 2160)) ** 0.75
    return f"{max(bps, 1e6) / 1e3:.0f}k"


def media_duration(path: Path) -> float:
    return float(probe(path)["format"]["duration"])


def lufs(path: Path) -> float:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-vn", "-af",
                        "ebur128=framelog=quiet", "-f", "null", "-"], capture_output=True, text=True)
    m = re.findall(r"I:\s+(-?[\d.]+) LUFS", r.stderr)
    return float(m[-1]) if m else -16.0


def norm(w: str) -> str:
    w = unicodedata.normalize("NFKD", w.lower())
    w = "".join(c for c in w if not unicodedata.combining(c))
    return re.sub(r"[^\w]", "", w)


def split_beats(text: str) -> list[str]:
    text = text.replace("\r", "")
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if len(paras) == 1:
        lines = [l.strip() for l in paras[0].split("\n") if l.strip()]
        paras = lines if len(lines) > 1 else [
            s.strip() for s in re.split(r"(?<=[.!?…])\s+", paras[0]) if s.strip()]
    return [re.sub(r"\s+", " ", p) for p in paras]


def strip_markers(s: str) -> tuple[str, dict[int, int]]:
    """Remove {n} markers; return clean text and marker -> char index in clean text."""
    out, marks, pos = "", {}, 0
    for m in MARK.finditer(s):
        out += s[pos:m.start()]
        marks[int(m.group(1))] = len(out)
        pos = m.end()
    out += s[pos:]
    return out, marks


def job_paths(job) -> dict:
    job = resolve_job(str(job)).resolve()
    vids = [p for p in job.iterdir() if p.suffix.lower() in (".mp4", ".mov", ".m4v")]
    base = job / "base.mp4" if (job / "base.mp4").exists() else (vids[0] if vids else None)
    if base is None:
        die(f"no video found in {job}")
    return {"job": job, "base": base, "script": job / "script.txt", "cuts": job / "cuts.txt",
            "work": job / "work", "out": job / "out", "analysis": job / "work" / "analysis.json"}


def load_analysis(P) -> dict:
    if not P["analysis"].exists():
        die("run `analyze` first")
    return json.loads(P["analysis"].read_text())


# ----------------------------------------------------------------------------- analyze

def detect_cuts(video: Path, threshold: float, dur: float, fps: float) -> list[float]:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(video), "-an", "-vf",
                        f"scale=270:-2,select='gt(scene,{threshold})',metadata=print",
                        "-f", "null", "-"], capture_output=True, text=True)
    ts = sorted({round(float(t) * fps) / fps for t in re.findall(r"pts_time:([0-9.]+)", r.stderr)})
    return [t for t in ts if 0.05 < t < dur - 0.05]


def forced_align(audio: Path, text: str) -> dict:
    with open(audio, "rb") as f:
        r = requests.post(f"{API}/v1/forced-alignment", headers={"xi-api-key": env("ELEVENLABS_API_KEY")},
                          files={"file": (audio.name, f, "audio/mp4")}, data={"text": text}, timeout=600)
    if r.status_code != 200:
        api_error("forced alignment", r, "Forced Alignment")
    return r.json()


# ElevenLabs speech-to-text reports ISO 639-3 codes; the rest of the tool uses the 2-letter ones.
ISO3_TO_2 = {"spa": "es", "eng": "en", "deu": "de", "ger": "de", "fra": "fr", "fre": "fr", "ita": "it",
             "nld": "nl", "dut": "nl", "por": "pt", "pol": "pl", "swe": "sv", "dan": "da", "nor": "no",
             "nob": "no", "fin": "fi", "tur": "tr", "jpn": "ja", "kor": "ko", "zho": "zh", "chi": "zh",
             "cmn": "zh", "ara": "ar", "hin": "hi", "rus": "ru", "ukr": "uk", "ces": "cs", "cze": "cs",
             "ron": "ro", "rum": "ro", "ell": "el", "gre": "el", "hun": "hu", "cat": "ca", "glg": "gl"}


def transcribe(audio: Path, cfg: dict) -> dict:
    with open(audio, "rb") as f:
        r = requests.post(f"{API}/v1/speech-to-text", headers={"xi-api-key": env("ELEVENLABS_API_KEY")},
                          files={"file": (audio.name, f, "audio/mp4")},
                          data={"model_id": cfg["elevenlabs"].get("stt_model", "scribe_v2"),
                                "tag_audio_events": "false", "timestamps_granularity": "word"},
                          timeout=600)
    if r.status_code != 200:
        api_error("transcription", r, "Speech to Text")
    return r.json()


def script_from_words(words: list[dict], pause: float) -> str:
    """Join transcribed words into beats: one sentence per beat, and a long silence mid-sentence also
    starts a new beat. (Speakers in short-form videos barely pause between sentences, so pauses alone
    give beats that are far too long.)"""
    beats, cur, last_end = [], "", None
    for w in words:
        t = (w.get("text") or "").strip()
        if w.get("type", "word") != "word" or not t:
            continue
        if cur and last_end is not None:
            gap = w["start"] - last_end
            if re.search(r"[.!?…]$", cur) or gap >= pause:
                beats.append(cur)
                cur = ""
        cur = f"{cur} {t}".strip()
        last_end = w["end"]
    if cur:
        beats.append(cur)
    return "\n\n".join(beats) + "\n"


def cmd_analyze(a):
    P = job_paths(a.job)
    cfg = config(P["job"])
    P["work"].mkdir(exist_ok=True)
    meta = probe(P["base"])
    vs = next(s for s in meta["streams"] if s["codec_type"] == "video")
    num, den = vs["r_frame_rate"].split("/")
    fps = float(num) / float(den)
    dur = float(meta["format"]["duration"])

    audio = P["work"] / "base_vo.m4a"
    if not audio.exists():
        sh(["ffmpeg", "-y", "-v", "error", "-i", str(P["base"]), "-vn", "-ac", "1", "-c:a", "aac",
            "-b:a", "128k", str(audio)])

    # 0. no script.txt: write it from what is actually said in the voiceover
    tr_path = P["work"] / "transcript.json"
    transcribed = not P["script"].exists()
    if transcribed:
        log("no script.txt - transcribing the voiceover (ElevenLabs speech-to-text)...", stage="transcribe")
        tr = transcribe(audio, cfg)
        log(None, usage={"service": "elevenlabs_stt", "seconds": round(dur, 1)})
        tr_path.write_text(json.dumps(tr, ensure_ascii=False, indent=1))
        P["script"].write_text(script_from_words(tr.get("words", []), cfg["fit"].get("beat_pause", 1.0)))
        lc = ISO3_TO_2.get(tr.get("language_code", ""), tr.get("language_code", ""))
        log(f"wrote {P['script']} ({len(split_beats(P['script'].read_text()))} beats, language: {lc}). "
              f"Check it: fix spelling of names if needed, but keep the words as spoken.")
    if not a.lang:
        tr = json.loads(tr_path.read_text()) if tr_path.exists() else {}
        a.lang = ISO3_TO_2.get(tr.get("language_code", ""), tr.get("language_code", ""))
        if not a.lang:
            die("couldn't tell the voiceover's language - pass it (e.g. --lang es)")

    beats = split_beats(P["script"].read_text())
    warnings = []
    tokens = []  # {beat, text, cs, ce}
    for bi, bt in enumerate(beats):
        for m in re.finditer(r"\S+", bt):
            tokens.append({"beat": bi, "text": m.group(), "cs": m.start()})

    # 1. align base voiceover to the script
    align_path = P["work"] / "base_alignment.json"
    text = "\n\n".join(beats)
    if align_path.exists() and json.loads(align_path.read_text()).get("_text") == text:
        al = json.loads(align_path.read_text())
    else:
        log("aligning base voiceover to script (ElevenLabs forced alignment)...", stage="align")
        al = forced_align(audio, text)
        log(None, usage={"service": "elevenlabs_alignment", "seconds": round(dur, 1)})
        al["_text"] = text
        align_path.write_text(json.dumps(al, ensure_ascii=False, indent=1))
    words = [w for w in al["words"] if norm(w["text"])]
    sm = difflib.SequenceMatcher(None, [norm(t["text"]) for t in tokens], [norm(w["text"]) for w in words],
                                 autojunk=False)
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            w = words[blk.b + k]
            tokens[blk.a + k].update(start=w["start"], end=w["end"])
    matched = sum(1 for t in tokens if "start" in t)
    # interpolate tokens the aligner did not match
    for i, t in enumerate(tokens):
        if "start" in t:
            continue
        prev_end = next((tokens[j]["end"] for j in range(i - 1, -1, -1) if "end" in tokens[j]), 0.0)
        nxt = next((j for j in range(i + 1, len(tokens)) if "start" in tokens[j]), None)
        nxt_start = tokens[nxt]["start"] if nxt is not None else dur
        n_missing = (nxt if nxt is not None else len(tokens)) - i
        step = (nxt_start - prev_end) / (n_missing + 1)
        t["start"], t["end"], t["interp"] = prev_end + step * 0.5, prev_end + step, True
    if matched < 0.8 * len(tokens):
        warnings.append(f"only {matched}/{len(tokens)} script words matched the audio - "
                        f"is script.txt the exact voiceover text?")

    # 2. cuts (editable list)
    if P["cuts"].exists():
        cuts = sorted(float(l.split("#")[0]) for l in P["cuts"].read_text().splitlines()
                      if l.split("#")[0].strip())
        log(f"using {len(cuts)} cuts/sync points from cuts.txt")
    else:
        cuts = detect_cuts(P["base"], cfg["fit"]["scene_threshold"], dur, fps)
        P["cuts"].write_text("# Cut / sync-point times in seconds (one per line). Auto-detected; edit freely:\n"
                             "# delete false cuts, add missed ones, or add sync points inside a clip\n"
                             "# (e.g. the moment a light changes colour). Re-run `analyze` after editing.\n"
                             + "\n".join(f"{t:.3f}" for t in cuts) + "\n")
        log(f"detected {len(cuts)} cuts -> {P['cuts']}")

    # 3. anchor every cut to the word being spoken
    s0, s1 = tokens[0]["start"], tokens[-1]["end"]
    anchors = []
    for cid, t in enumerate(cuts, 1):
        if t < s0:
            anchors.append({"id": cid, "t": t, "kind": "lead", "frac": t / s0 if s0 > 0 else 0})
        elif t >= s1:
            anchors.append({"id": cid, "t": t, "kind": "tail", "off": t - s1})
        else:
            i = max(k for k in range(len(tokens)) if tokens[k]["start"] <= t)
            tk = tokens[i]
            if t <= tk["end"] or i == len(tokens) - 1:
                span = max(1e-3, tk["end"] - tk["start"])
                anchors.append({"id": cid, "t": t, "kind": "in", "token": i,
                                "frac": min(1.0, (t - tk["start"]) / span)})
            else:
                gap = max(1e-3, tokens[i + 1]["start"] - tk["end"])
                anchors.append({"id": cid, "t": t, "kind": "gap", "token": i + 1,
                                "frac": (t - tk["end"]) / gap})

    # 4. beats with marker text
    marks_at: dict[int, list[int]] = {}
    for an in anchors:
        if an["kind"] in ("in", "gap"):
            marks_at.setdefault(an["token"], []).append(an["id"])
    out_beats = []
    for bi, bt in enumerate(beats):
        idx = [i for i, t in enumerate(tokens) if t["beat"] == bi]
        marked, pos = "", 0
        for i in idx:
            cs = tokens[i]["cs"]
            marked += bt[pos:cs] + "".join(f"{{{m}}}" for m in marks_at.get(i, []))
            pos = cs
        marked += bt[pos:]
        st, en = tokens[idx[0]]["start"], tokens[idx[-1]]["end"]
        nxt = tokens[idx[-1] + 1]["start"] if idx[-1] + 1 < len(tokens) else None
        out_beats.append({"id": bi + 1, "text": bt, "marked": marked, "start": round(st, 3), "end": round(en, 3),
                          "dur": round(en - st, 3), "pause_after": round(nxt - en, 3) if nxt else 0.0})

    # sanity check: a beat spoken impossibly fast/slow means the script doesn't match the voiceover
    rates = sorted(len(b["text"]) / max(0.05, b["dur"]) for b in out_beats)
    med = rates[len(rates) // 2]
    odd = [b["id"] for b in out_beats if not (med / 2.5 < len(b["text"]) / max(0.05, b["dur"]) < med * 2.5)]
    if odd or al.get("loss", 0) > 1.5:
        warnings.append(f"script.txt does not seem to match the voiceover (alignment loss {al.get('loss', 0):.2f}; "
                        f"suspicious beats: {odd or 'none'}). Check that the beats are in the order they are "
                        f"spoken and the wording matches, then re-run analyze.")
    for w in warnings:
        warn(w, stage="analyze")

    analysis = {"base_lang": a.lang, "video": {"path": str(P["base"]), "dur": dur, "fps": fps,
                                               "w": vs["width"], "h": vs["height"]},
                "speech_start": s0, "speech_end": s1, "beats": out_beats, "tokens": tokens,
                "anchors": anchors, "base_lufs": lufs(P["base"]), "warnings": warnings, "transcribed": transcribed}
    P["analysis"].write_text(json.dumps(analysis, ensure_ascii=False, indent=1))

    # 5. translation brief for Claude Code
    rate = sum(len(b["text"]) for b in out_beats) / sum(b["dur"] for b in out_beats)
    lines = [f"# Translation brief - {P['job'].name} (base: {a.lang})", "",
             f"Base voiceover speaking rate: {rate:.1f} characters/second. "
             "Each translated beat should take about the same time as the base beat when read aloud.",
             "Keep every {n} marker in front of the word that means the same thing - each one is a video cut "
             "that has to land on that word.", "",
             "| beat | seconds | chars | text with markers |", "|---|---|---|---|"]
    for b in out_beats:
        lines.append(f"| {b['id']} | {b['dur']:.2f} | {len(b['text'])} | {b['marked']} |")
    (P["work"] / "translate_brief.md").write_text("\n".join(lines) + "\n")
    log(f"{len(out_beats)} beats, {len(anchors)} cuts anchored, base speech {s0:.2f}-{s1:.2f}s "
          f"of {dur:.2f}s. Brief: {P['work'] / 'translate_brief.md'}")
    return analysis


# ----------------------------------------------------------------------------- translate (Claude API)

TRANSLATE_SYSTEM = """You translate the voiceover of short-form product videos (Instagram/TikTok style) so it can be \
re-voiced in another language and the video re-timed to it.

The voiceover is split into beats. Some words carry markers like {3}: each marker is a video cut that has to land \
on that word.

Rules:
- Return exactly the same beats, with the same ids and in the same order.
- Keep every {n} marker exactly once, directly in front of the word that carries the same meaning as in the \
original. Never put a marker in a different beat than the original. Keep markers in increasing order when the \
grammar allows it. Markers that are adjacent in the original (like {14}{15}) stay adjacent.
- Fit the timing: each beat should take about as long to say as the original. You get the seconds and character \
count of each original beat and the original speaking rate. Prefer natural, spoken, short-form-video phrasing \
over a literal translation; shorten when the target language runs long (German and French usually do).
- Match the register of the original (informal stays informal, formal stays formal). Never translate brand or \
product names.
- speed is the voice speed for a beat (0.7 to 1.2, null = default). Use it only when a beat can't be shortened \
or lengthened without losing meaning; rewriting the text comes first."""

LANG_NAMES = {"en": "English", "es": "Spanish", "de": "German", "fr": "French", "it": "Italian", "nl": "Dutch",
              "pt": "Portuguese", "pl": "Polish", "sv": "Swedish", "da": "Danish", "no": "Norwegian",
              "fi": "Finnish", "tr": "Turkish", "ja": "Japanese", "ko": "Korean", "zh": "Chinese",
              "ar": "Arabic", "hi": "Hindi", "ru": "Russian", "uk": "Ukrainian", "cs": "Czech", "ro": "Romanian",
              "el": "Greek", "hu": "Hungarian", "ca": "Catalan", "gl": "Galician"}

SCRIPT_SCHEMA = {
    "type": "object",
    "properties": {"beats": {"type": "array", "items": {
        "type": "object",
        "properties": {"id": {"type": "integer"}, "text": {"type": "string"},
                       "speed": {"anyOf": [{"type": "number"}, {"type": "null"}]}},
        "required": ["id", "text", "speed"], "additionalProperties": False}}},
    "required": ["beats"], "additionalProperties": False,
}


def lang_name(code: str) -> str:
    return f"{LANG_NAMES.get(code, code)} ({code})"


def brief_table(A) -> str:
    rate = sum(len(b["text"]) for b in A["beats"]) / sum(b["dur"] for b in A["beats"])
    rows = [f"Original speaking rate: {rate:.1f} characters/second.", "",
            "| beat | seconds | chars | text with markers |", "|---|---|---|---|"]
    rows += [f"| {b['id']} | {b['dur']:.2f} | {len(b['text'])} | {b['marked']} |" for b in A["beats"]]
    return "\n".join(rows)


def check_script(A, beats: list[dict]) -> list[str]:
    """Problems that make a translation unusable: wrong beats, or markers lost, duplicated or moved."""
    errs = []
    if [b["id"] for b in beats] != [b["id"] for b in A["beats"]]:
        return [f"the beats must have ids {[b['id'] for b in A['beats']]}, in that order"]
    for base, b in zip(A["beats"], beats):
        want = [int(m) for m in MARK.findall(base["marked"])]
        got = [int(m) for m in MARK.findall(b["text"])]
        lost = [m for m in want if m not in got]
        extra = sorted({m for m in got if got.count(m) > 1 or m not in want})
        if lost:
            errs.append(f"beat {b['id']} is missing marker(s) {', '.join('{%d}' % m for m in lost)}")
        if extra:
            errs.append(f"beat {b['id']} has marker(s) {', '.join('{%d}' % m for m in extra)} that don't belong "
                        f"there or appear more than once")
        if not strip_markers(b["text"])[0].strip():
            errs.append(f"beat {b['id']} is empty")
    return errs


def claude_json(cfg, system: str, schema: dict, messages: list[dict]) -> tuple[dict, dict]:
    """One Claude call whose answer is JSON matching `schema`. Returns (data, assistant message to append)."""
    import anthropic  # only needed for this step; the plugin's MCP server never calls it

    C = cfg.get("claude", {})
    model = C.get("model", "claude-opus-5-5")
    if not _job_keys.get("ANTHROPIC_API_KEY") and not os.environ.get("ANTHROPIC_API_KEY", "").strip():
        die("ANTHROPIC_API_KEY is not set - put it in the .env file in your jobs folder (see .env.example). "
            "Create one at platform.claude.com -> API keys.")
    client = anthropic.Anthropic(api_key=env("ANTHROPIC_API_KEY"))
    try:
        r = client.beta.messages.create(
            model=model, max_tokens=16000, system=system, messages=messages,
            output_config={"effort": C.get("effort", "medium"),
                           "format": {"type": "json_schema", "schema": schema}},
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        )
    except anthropic.AuthenticationError:
        die(f"the Claude API rejected the Claude API key (401) - check it in {KEYS_WHERE}")
    except anthropic.APIStatusError as e:
        die(f"Claude API error ({e.status_code}): {e.message}")
    except anthropic.APIConnectionError:
        die("couldn't reach the Claude API - check the internet connection")
    if r.stop_reason == "refusal":
        die(f"Claude declined this request ({getattr(r.stop_details, 'category', None)})")
    if r.stop_reason == "max_tokens":
        die("Claude's answer was cut off (max_tokens) - the script may be too long for one call")
    text = next(b.text for b in r.content if b.type == "text")
    u = r.usage
    log(f"  (Claude {r.model}: {u.input_tokens} in / {u.output_tokens} out tokens)",
        usage={"service": "claude", "model": r.model, "input_tokens": u.input_tokens,
               "output_tokens": u.output_tokens})
    return json.loads(text), {"role": "assistant", "content": text}


def claude_script(cfg, messages: list[dict]) -> tuple[list[dict], dict]:
    """A translation call: returns (beats, assistant message to append)."""
    data, reply = claude_json(cfg, TRANSLATE_SYSTEM, SCRIPT_SCHEMA, messages)
    return data["beats"], reply


def write_lang_script(P, lang, beats: list[dict]) -> Path:
    out = []
    for b in beats:
        d = {"id": b["id"], "text": b["text"].strip()}
        if b.get("speed") is not None:
            d["speed"] = round(max(0.7, min(1.2, float(b["speed"]))), 2)
        out.append(d)
    p = P["work"] / lang / "script.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"lang": lang, "beats": out}, ensure_ascii=False, indent=1))
    return p


def ask_until_valid(P, A, lang, cfg, messages) -> Path:
    """Ask Claude, and if markers got lost, tell it what's wrong and ask again (twice at most)."""
    for attempt in range(3):
        beats, reply = claude_script(cfg, messages)
        errs = check_script(A, beats)
        if not errs:
            return write_lang_script(P, lang, beats)
        log(f"  translation problems, asking again: {'; '.join(errs)}")
        messages += [reply, {"role": "user", "content": "Fix these problems and return all beats again:\n- "
                                                         + "\n- ".join(errs)}]
    die(f"Claude's {lang} translation still has problems after 3 tries: {'; '.join(errs)}")


def translate_lang(P, A, lang, cfg) -> Path:
    """First translation of the whole script into `lang` -> work/<lang>/script.json."""
    log(f"{lang}: translating with Claude...", stage="translate", lang=lang)
    prompt = (f"Translate this {lang_name(A['base_lang'])} voiceover into {lang_name(lang)}.\n\n{brief_table(A)}")
    return ask_until_valid(P, A, lang, cfg, [{"role": "user", "content": prompt}])


def refit_lang(P, A, lang, cfg, plan) -> Path:
    """Rewrite the beats the fitting step flagged as too long/short (or with a missing marker)."""
    S = json.loads((P["work"] / lang / "script.json").read_text())
    flagged = sorted({f["beat"] for f in plan["flags"] if f["beat"] is not None})
    rows = ["| beat | original s | voiced s | speed | text |", "|---|---|---|---|---|"]
    for sb, pb in zip(S["beats"], plan["beats"]):
        rows.append(f"| {sb['id']} | {pb['base_dur']:.2f} | {pb['dur']:.2f} | {sb.get('speed') or 'default'} | "
                    f"{sb['text']} |")
    prompt = (f"Here is the original {lang_name(A['base_lang'])} voiceover:\n\n{brief_table(A)}\n\n"
              f"and its {lang_name(lang)} translation after voicing it (seconds as spoken):\n\n" + "\n".join(rows) +
              "\n\nFitting the video to this voice left these problems:\n- " +
              "\n- ".join(f["msg"] for f in plan["flags"]) +
              f"\n\nRewrite beat(s) {', '.join(map(str, flagged)) or 'as needed'} to fix them: shorter or longer "
              "text first, speed only for the last bit. Return all beats; leave the others exactly as they are.")
    log(f"{lang}: asking Claude to rewrite beat(s) {', '.join(map(str, flagged))}...")
    return ask_until_valid(P, A, lang, cfg, [{"role": "user", "content": prompt}])


NAMES_SYSTEM = """You proofread automatic transcripts of short product-video voiceovers. Fix only the spelling \
of names the speech-to-text got wrong: brands, products, models, people, places (e.g. "Nano Leaf" -> "Nanoleaf"). \
Use the reference text when there is one; otherwise fix only names you are sure of. Never change any other word, \
the wording, the word order, the punctuation or the beats: the text has to keep saying exactly what was spoken."""

NAMES_SCHEMA = {"type": "object", "properties": {"beats": {"type": "array", "items": {"type": "string"}},
                                                 "changes": {"type": "array", "items": {"type": "string"}}},
                "required": ["beats", "changes"], "additionalProperties": False}


def fix_names(P, A, cfg) -> list[str]:
    """After transcription: let Claude fix misspelled names in script.txt. A reference text (reference.txt
    or script_*.txt in the job folder, e.g. the written script) helps. Returns the changes made."""
    refs = [p for p in sorted(P["job"].glob("*.txt")) if p.name == "reference.txt" or p.name.startswith("script_")]
    ref = "\n\n".join(p.read_text() for p in refs).strip()
    beats = [b["text"] for b in A["beats"]]
    prompt = (f"Transcript ({lang_name(A['base_lang'])}), one beat per line:\n\n" +
              "\n".join(f"{i + 1}. {b}" for i, b in enumerate(beats)) +
              (f"\n\nReference text (spelling of names):\n\n{ref}" if ref else "\n\nNo reference text.") +
              "\n\nReturn every beat (without the numbers), corrected or not, and a short list of what you changed "
              "(e.g. \"Nano Leaf -> Nanoleaf\").")
    log("checking the spelling of names...", stage="analyze")
    out, _ = claude_json(cfg, NAMES_SYSTEM, NAMES_SCHEMA, [{"role": "user", "content": prompt}])
    new = [re.sub(r"\s+", " ", b).strip() for b in out["beats"]]
    if len(new) != len(beats) or any(
            difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio() < 0.8 for a, b in zip(beats, new)):
        warn("the name check changed more than names - kept the transcript as it was", stage="analyze")
        return []
    if new == beats:
        return []
    P["script"].write_text("\n\n".join(new) + "\n")
    for c in out["changes"]:
        log(f"  fixed: {c}", stage="analyze")
    return out["changes"] or ["names corrected"]


def cmd_translate(a):
    P = job_paths(a.job)
    cfg = config(P["job"])
    A = load_analysis(P)
    log(f"wrote {translate_lang(P, A, a.lang, cfg)}")


# ----------------------------------------------------------------------------- tts

def load_lang_script(P, A, lang) -> dict:
    p = P["work"] / lang / "script.json"
    if not p.exists():
        die(f"missing {p} - translate first (translate-video skill)")
    S = json.loads(p.read_text())
    if len(S["beats"]) != len(A["beats"]):
        die(f"{p} has {len(S['beats'])} beats, base has {len(A['beats'])}")
    return S


def tts_beat(text, prev, nxt, lang, speed, cfg, outdir: Path) -> dict:
    el = cfg["elevenlabs"]
    settings = dict(el["voice_settings"])
    settings["speed"] = max(0.7, min(1.2, speed if speed else settings.get("speed", 1.0)))
    voice = voice_for(lang, cfg)
    body = {"text": text, "model_id": el["model_id"], "voice_settings": settings}
    if prev:
        body["previous_text"] = prev
    if nxt:
        body["next_text"] = nxt
    if not el["model_id"].startswith("eleven_multilingual_v2"):
        body["language_code"] = lang
    key = hashlib.sha1(json.dumps([voice, el["output_format"], body], sort_keys=True).encode()).hexdigest()[:12]
    mp3, js = outdir / f"{key}.mp3", outdir / f"{key}.json"
    if mp3.exists() and js.exists():
        return {"audio": str(mp3), **json.loads(js.read_text()), "cached": True}
    r = requests.post(f"{API}/v1/text-to-speech/{voice}/with-timestamps",
                      params={"output_format": el["output_format"]},
                      headers={"xi-api-key": env("ELEVENLABS_API_KEY")}, json=body, timeout=300)
    if r.status_code != 200:
        api_error("TTS", r, "Text to Speech")
    d = r.json()
    mp3.write_bytes(base64.b64decode(d["audio_base64"]))
    log(None, usage={"service": "elevenlabs_tts", "characters": len(text)})
    meta = {"text": text, "speed": settings["speed"], "alignment": d.get("alignment"),
            "normalized_alignment": d.get("normalized_alignment")}
    js.write_text(json.dumps(meta, ensure_ascii=False))
    return {"audio": str(mp3), **meta, "cached": False}


def beat_timing(text_marked: str, tts: dict) -> dict:
    """Token times (local to the TTS file) and marker -> token index."""
    clean, marks = strip_markers(text_marked)
    al = tts.get("alignment") or {}
    chars = al.get("characters") or []
    st, en = al.get("character_start_times_seconds") or [], al.get("character_end_times_seconds") or []
    adur = media_duration(Path(tts["audio"]))
    toks = []
    for m in re.finditer(r"\S+", clean):
        cs, ce = m.start(), m.end() - 1
        if len(chars) == len(clean) and chars:
            s, e = st[cs], en[ce]
        else:  # alignment did not match the text 1:1 - map proportionally
            n = max(1, len(st))
            s, e = st[min(n - 1, cs * n // len(clean))], en[min(n - 1, ce * n // len(clean))]
        toks.append({"cs": m.start(), "start": s, "end": e})
    tok_of_mark = {}
    for mid, idx in marks.items():
        k = next((i for i, t in enumerate(toks) if t["cs"] >= idx), len(toks) - 1)
        tok_of_mark[mid] = k
    clip_in = max(0.0, toks[0]["start"] - 0.04)
    clip_out = min(adur, toks[-1]["end"] + 0.10)
    return {"tokens": toks, "marks": tok_of_mark, "clip_in": clip_in, "clip_out": clip_out}


def cmd_tts(a, quiet=False):
    P = job_paths(a.job)
    cfg = config(P["job"])
    A = load_analysis(P)
    S = load_lang_script(P, A, a.lang)
    outdir = P["work"] / a.lang / "tts"
    outdir.mkdir(parents=True, exist_ok=True)
    clean = [strip_markers(b["text"])[0].strip() for b in S["beats"]]
    res = []
    for i, b in enumerate(S["beats"]):
        r = tts_beat(clean[i], clean[i - 1] if i else "", clean[i + 1] if i + 1 < len(clean) else "",
                     a.lang, b.get("speed"), cfg, outdir)
        res.append({"beat": b["id"], "audio": r["audio"], "speed": r["speed"]})
        log(None if quiet else f"  beat {b['id']}: {'cached' if r['cached'] else 'generated'} (speed {r['speed']})",
            stage="tts", lang=a.lang, done=i + 1, total=len(S["beats"]))
    (P["work"] / a.lang / "tts_index.json").write_text(json.dumps(res, indent=1))
    return res


# ----------------------------------------------------------------------------- plan (fit)

def build_plan(P, A, lang, cfg) -> dict:
    F = cfg["fit"]
    S = load_lang_script(P, A, lang)
    idx_path = P["work"] / lang / "tts_index.json"
    if not idx_path.exists():
        die("run `tts` first")
    index = json.loads(idx_path.read_text())
    B = len(S["beats"])
    beats = []
    for b, ix in zip(S["beats"], index):
        meta = json.loads(Path(ix["audio"]).with_suffix(".json").read_text())
        bt = beat_timing(b["text"], {"audio": ix["audio"], **meta})
        bt["audio"], bt["speed"] = ix["audio"], ix["speed"]
        beats.append(bt)

    # which beat/token does every base token map to? (for anchors without a marker in the translation)
    mark_loc = {}
    for bi, bt in enumerate(beats):
        for mid, k in bt["marks"].items():
            mark_loc[mid] = (bi, k)

    base_tokens = A["tokens"]
    tempo = [1.0] * B
    base_pause = [b["pause_after"] for b in A["beats"]]
    pause = [max(F["pause_min"], base_pause[i] - 0.14) for i in range(B)]
    pause[-1] = 0.0
    pause_hi = [p + F["pause_max_extra"] for p in pause]
    pause_hi[-1] = 0.0
    lead = max(0.0, A["speech_start"] - 0.04)
    vid_dur, fps = A["video"]["dur"], A["video"]["fps"]
    base_tail = vid_dur - A["speech_end"]
    anchors = A["anchors"]
    base_t = [0.0] + [an["t"] for an in anchors] + [vid_dur]
    vmin, vmax, keep = F["video_speed_min"], F["video_speed_max"], F["trim_keep_min"]
    tol = F["sync_tolerance"]

    def timeline():
        O, t = [], lead
        for i, bt in enumerate(beats):
            O.append(t)
            t += (bt["clip_out"] - bt["clip_in"]) / tempo[i] + pause[i]
        return O, t

    def gtime(O, bi, local):
        return O[bi] + (local - beats[bi]["clip_in"]) / tempo[bi]

    def targets(O, audio_end):
        first = gtime(O, 0, beats[0]["tokens"][0]["start"])
        last = gtime(O, B - 1, beats[-1]["tokens"][-1]["end"])
        T, owner, missing = [0.0], [None], []
        for an in anchors:
            if an["kind"] == "lead":
                T.append(an["frac"] * first); owner.append(0)
            elif an["kind"] == "tail":
                T.append(last + an["off"]); owner.append(B - 1)
            elif an["id"] in mark_loc:
                bi, k = mark_loc[an["id"]]
                tk = beats[bi]["tokens"][k]
                s, e = gtime(O, bi, tk["start"]), gtime(O, bi, tk["end"])
                if an["kind"] == "in":
                    T.append(s + an["frac"] * (e - s))
                else:
                    if k > 0:
                        pe = gtime(O, bi, beats[bi]["tokens"][k - 1]["end"])
                    elif bi > 0:
                        pe = gtime(O, bi - 1, beats[bi - 1]["tokens"][-1]["end"])
                    else:
                        pe = lead
                    T.append(pe + an["frac"] * (s - pe))
                owner.append(bi)
            else:
                T.append(None); owner.append(base_tokens[an["token"]]["beat"]); missing.append(an["id"])
        T.append(audio_end + base_tail); owner.append(B - 1)
        # fill anchors whose marker was dropped: interpolate on base time
        for j, t in enumerate(T):
            if t is None:
                p = max(k for k in range(j) if T[k] is not None)
                n = min(k for k in range(j + 1, len(T)) if T[k] is not None)
                T[j] = T[p] + (T[n] - T[p]) * (base_t[j] - base_t[p]) / max(1e-6, base_t[n] - base_t[p])
        return T, owner, missing

    seg_lo = [(base_t[j + 1] - base_t[j]) * keep / vmax for j in range(len(base_t) - 1)]
    seg_hi = [(base_t[j + 1] - base_t[j]) / vmin for j in range(len(base_t) - 1)]

    def solve(T):
        """Place every cut C[j] within +-tol of its word T[j], honouring each clip's min/max length.
        Forward pass: reachable window per cut. Backward pass: pick the spot closest to the word.
        Returns cut times and the list of cuts that cannot be placed (index, sign: -1 voice too long)."""
        n = len(base_t)
        R, conflicts = [(0.0, 0.0)], []
        for j in range(1, n):
            a, b = R[j - 1][0] + seg_lo[j - 1], R[j - 1][1] + seg_hi[j - 1]
            w = tol if j < n - 1 else 30.0  # the video end is free: it holds/trims the last clip
            lo_, hi_ = max(a, T[j] - w), min(b, T[j] + w)
            if lo_ > hi_ + 1e-9:
                conflicts.append((j, -1 if b < T[j] - w else 1))
                lo_ = hi_ = b if b < T[j] - w else a
            R.append((lo_, hi_))
        C = [0.0] * n
        C[-1] = min(R[-1][1], max(R[-1][0], T[-1]))
        for j in range(n - 2, 0, -1):
            lo_ = max(R[j][0], C[j + 1] - seg_hi[j])
            hi_ = min(R[j][1], C[j + 1] - seg_lo[j])
            if lo_ > hi_:
                lo_, hi_ = R[j]
            C[j] = min(hi_, max(lo_, T[j]))
        return C, conflicts

    def state():
        O, audio_end = timeline()
        T, owner, missing = targets(O, audio_end)
        for j in range(1, len(T)):  # translation may reorder markers - keep targets increasing
            T[j] = max(T[j], T[j - 1] + 1.0 / fps)
        return O, audio_end, T, owner, missing

    # Only touch the voice where a cut can't be placed, and only in the beats around that cut.
    unresolved = set()
    for _ in range(3000):
        O, audio_end, T, owner, missing = state()
        C, conflicts = solve(T)
        todo = [c for c in conflicts if c[0] not in unresolved]
        if not todo:
            break
        j, sign = todo[0]
        changed = False
        for back in (1, 2, 3):  # widen the window a little if the nearest beats are maxed out
            blo = owner[max(0, j - back)] if owner[max(0, j - back)] is not None else 0
            bhi = owner[j]
            if sign < 0:  # voice too long for the footage -> tighten
                cand = [("pause", i) for i in range(blo, bhi) if pause[i] > F["pause_min"] + 1e-6]
                cand += sorted((("tempo", i) for i in range(blo, bhi + 1) if tempo[i] < F["audio_tempo_max"] - 1e-6),
                               key=lambda c: tempo[c[1]])
            else:         # footage too long even after trimming -> loosen
                cand = [("pause", i) for i in range(blo, bhi) if pause[i] < pause_hi[i] - 1e-6]
                cand += sorted((("tempo", i) for i in range(blo, bhi + 1) if tempo[i] > F["audio_tempo_min"] + 1e-6),
                               key=lambda c: -tempo[c[1]])
            if cand:
                kind, i = cand[0]
                if kind == "pause":
                    pause[i] = (max(F["pause_min"], pause[i] - 0.02) if sign < 0 else min(pause_hi[i], pause[i] + 0.02))
                else:
                    tempo[i] = (min(F["audio_tempo_max"], tempo[i] + 0.005) if sign < 0
                                else max(F["audio_tempo_min"], tempo[i] - 0.005))
                changed = True
                break
        if not changed:
            unresolved.add(j)

    O, audio_end, T, owner, missing = state()
    C, _ = solve(T)
    Cf = [round(c * fps) for c in C]
    for j in range(1, len(Cf)):
        Cf[j] = max(Cf[j], Cf[j - 1] + 1)
    total_frames = max(Cf[-1], int(round((audio_end + min(0.15, base_tail)) * fps)))
    hold = (total_frames - Cf[-1]) / fps  # last frame held because the voice runs past the footage
    Cf[-1] = total_frames

    segments = []
    for j in range(len(base_t) - 1):
        L = base_t[j + 1] - base_t[j]
        out = (Cf[j + 1] - Cf[j]) / fps
        v = min(vmax, max(vmin, L / out))
        src = min(L, out * v)
        segments.append({"seg": j, "src_start": base_t[j], "src_len": src, "base_len": L, "frames": Cf[j + 1] - Cf[j],
                         "out_start": Cf[j] / fps, "speed": v, "trimmed": max(0.0, L - src)})

    flags = []
    for j in range(1, len(T) - 1):
        err = Cf[j] / fps - T[j]
        if abs(err) > tol + 0.5 / fps:
            bi = owner[j]
            if err < 0:
                flags.append({"cut": anchors[j - 1]["id"], "beat": S["beats"][bi]["id"], "error": err,
                              "msg": f"cut {anchors[j - 1]['id']} (at {Cf[j] / fps:.1f}s) lands {-err:.2f}s before its word: beat "
                                     f"{S['beats'][bi]['id']} (or the beats before it) is ~{-err - tol + 0.05:.2f}s "
                                     f"too long - shorten the text or raise its speed"})
            else:
                flags.append({"cut": anchors[j - 1]["id"], "beat": S["beats"][bi]["id"], "error": err,
                              "msg": f"cut {anchors[j - 1]['id']} (at {Cf[j] / fps:.1f}s) lands {err:.2f}s after its word: beat "
                                     f"{S['beats'][bi]['id']} is ~{err - tol + 0.05:.2f}s too short - "
                                     f"lengthen the text or lower its speed"})
    if hold > 0.3:
        flags.append({"cut": None, "beat": S["beats"][-1]["id"], "error": -hold,
                      "msg": f"the voice runs {hold:.2f}s past the last clip (last frame is held) - "
                             f"shorten beat {S['beats'][-1]['id']} or raise its speed"})
    for mid in missing:
        flags.append({"cut": mid, "beat": None, "error": 0.0,
                      "msg": f"marker {{{mid}}} is missing in the translation - cut placed by interpolation"})

    beat_rows = []
    for i, (b, bt) in enumerate(zip(S["beats"], beats)):
        base_b = A["beats"][i]
        dur = (bt["clip_out"] - bt["clip_in"]) / tempo[i]
        beat_rows.append({"beat": b["id"], "offset": O[i], "clip_in": bt["clip_in"], "clip_out": bt["clip_out"],
                          "tempo": tempo[i], "tts_speed": bt["speed"], "dur": dur, "base_dur": base_b["dur"],
                          "pause_after": pause[i], "audio": bt["audio"]})
    return {"lang": lang, "fps": fps, "total_frames": total_frames, "segments": segments, "beats": beat_rows,
            "anchors": [{"id": an["id"], "base": an["t"], "target": T[j + 1], "placed": Cf[j + 1] / fps}
                        for j, an in enumerate(anchors)],
            "flags": flags, "audio_end": audio_end}


def write_report(P, plan) -> Path:
    name = P["job"].name
    lang = plan["lang"]
    total = plan["total_frames"] / plan["fps"]
    L = [f"# {name} - {lang.upper()}", "",
         f"Length: {total:.2f}s (base {sum(s['base_len'] for s in plan['segments']):.2f}s)", ""]
    if plan["flags"]:
        L += ["## Needs attention", ""] + [f"- {f['msg']}" for f in plan["flags"]] + [""]
    else:
        L += ["All cuts land on their words within tolerance.", ""]
    L += ["## Voiceover beats", "", "| beat | base s | new s | TTS speed | tempo | pause after |", "|---|---|---|---|---|---|"]
    for b in plan["beats"]:
        L.append(f"| {b['beat']} | {b['base_dur']:.2f} | {b['dur']:.2f} | {b['tts_speed']:.2f} | "
                 f"{b['tempo']:.3f} | {b['pause_after']:.2f} |")
    L += ["", "## Clips", "", "| clip | source in | base s | new s | speed | trimmed s | cut error s |",
          "|---|---|---|---|---|---|---|"]
    for s in plan["segments"]:
        an = plan["anchors"][s["seg"]] if s["seg"] < len(plan["anchors"]) else None
        err = f"{an['placed'] - an['target']:+.2f}" if an else ""
        L.append(f"| {s['seg'] + 1} | {s['src_start']:.2f} | {s['base_len']:.2f} | {s['frames'] / plan['fps']:.2f} | "
                 f"{s['speed']:.2f} | {s['trimmed']:.2f} | {err} |")
    p = P["work"] / lang / "report.md"
    p.write_text("\n".join(L) + "\n")
    return p


def cmd_plan(a, quiet=False):
    P = job_paths(a.job)
    cfg = config(P["job"])
    A = load_analysis(P)
    plan = build_plan(P, A, a.lang, cfg)
    (P["work"] / a.lang / "plan.json").write_text(json.dumps(plan, indent=1))
    rep = write_report(P, plan)
    sp = [s["speed"] for s in plan["segments"]]
    log(f"{a.lang}: {plan['total_frames'] / plan['fps']:.2f}s, clip speed {min(sp):.2f}-{max(sp):.2f}, "
          f"{sum(1 for s in plan['segments'] if s['trimmed'] > 0.02)} clips trimmed, "
          f"voice tempo {min(b['tempo'] for b in plan['beats']):.3f}-{max(b['tempo'] for b in plan['beats']):.3f}", stage="plan", lang=a.lang)
    for f in plan["flags"]:
        log(f"  ! {f['msg']}", stage="plan", lang=a.lang, level="warning")
    log(f"report: {rep}")
    return plan


# ----------------------------------------------------------------------------- render

def atempo_chain(t: float) -> str:
    return f"atempo={t:.4f}"


def cmd_render(a):
    P = job_paths(a.job)
    cfg = config(P["job"])
    R = cfg["render"]
    A = load_analysis(P)
    pp = P["work"] / a.lang / "plan.json"
    if not pp.exists():
        die("run `plan` first")
    plan = json.loads(pp.read_text())
    fps = plan["fps"]
    wd = P["work"] / a.lang
    seg_dir = wd / "segments"
    if seg_dir.exists():
        shutil.rmtree(seg_dir)
    seg_dir.mkdir(parents=True)

    # voice track
    total = plan["total_frames"] / fps
    pcm = array.array("h", bytes(2 * int(round(total * SR))))
    for b in plan["beats"]:
        r = sh(["ffmpeg", "-v", "error", "-ss", f"{b['clip_in']:.4f}", "-t", f"{b['clip_out'] - b['clip_in']:.4f}",
                "-i", b["audio"], "-af", atempo_chain(b["tempo"]), "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
               binary=True)
        clip = array.array("h", r.stdout)
        start = int(round(b["offset"] * SR))
        n = min(len(clip), len(pcm) - start)
        pcm[start:start + n] = clip[:n]
    raw = wd / "voice.raw"
    raw.write_bytes(pcm.tobytes())
    voice = wd / "voice.wav"
    sh(["ffmpeg", "-y", "-v", "error", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", str(raw), str(voice)])
    raw.unlink()
    gain = A["base_lufs"] - lufs(voice)

    # video segments
    base = A["video"]["path"]
    vcodec = R["video_codec"]
    W, H = render_size(*video_size(Path(base)))  # same size as the source: 1080p stays 1080p, 4K stays 4K
    vbr = scaled_bitrate(R["video_bitrate"], W, H)
    log(f"{a.lang}: rendering at {W}x{H}, {vbr}", stage="render", lang=a.lang)
    venc = ["-c:v", vcodec, "-b:v", vbr, "-tag:v", "hvc1"] if "hevc" in vcodec else ["-c:v", vcodec, "-b:v", vbr]
    if "hevc" in vcodec:
        venc += ["-profile:v", "main10", "-pix_fmt", "p010le"]
    venc += ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
    lst = []
    for s in plan["segments"]:
        f = seg_dir / f"{s['seg']:03d}.mp4"
        vf = f"setpts=(PTS-STARTPTS)/{s['speed']:.5f},fps={fps},scale={W}:{H},tpad=stop_mode=clone:stop_duration=1"
        sh(["ffmpeg", "-y", "-v", "error", "-ss", f"{s['src_start']:.4f}", "-t", f"{s['src_len'] + 0.1:.4f}",
            "-i", base, "-an", "-vf", vf, "-frames:v", str(s["frames"]), *venc, str(f)])
        lst.append(f"file '{f}'")
        log(None, stage="render", lang=a.lang, done=s["seg"] + 1, total=len(plan["segments"]))
    (seg_dir / "list.txt").write_text("\n".join(lst) + "\n")
    P["out"].mkdir(exist_ok=True)
    out = P["out"] / f"{P['job'].name}_{a.lang}.mp4"
    sh(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(seg_dir / "list.txt"),
        "-i", str(voice), "-map", "0:v", "-map", "1:a", "-c:v", "copy",
        "-af", f"volume={gain:.2f}dB,alimiter=limit=0.95:level=0", "-ac", "2",
        "-c:a", "aac", "-b:a", R["audio_bitrate"], "-movflags", "+faststart", "-t", f"{total:.4f}", str(out)])
    log(f"done: {out} ({media_duration(out):.2f}s)")


def make_preview(video: Path, out: Path) -> Path:
    """A small H.264 copy (long side 1280) that every browser plays; the full-size HEVC output (the source's resolution) is for downloading."""
    scale = "scale='if(gt(iw,ih),1280,-2)':'if(gt(iw,ih),-2,1280)'"
    sh(["ffmpeg", "-y", "-v", "error", "-i", str(video), "-vf", scale, "-c:v", "libx264", "-preset", "veryfast",
        "-crf", "24", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(out)])
    return out


# ----------------------------------------------------------------------------- whole jobs (CLI and worker)
#
# A job runs in two halves so a person can check the transcript in between:
#   prepare(job)  -> transcribe if needed, fix the spelling of names, align, detect cuts
#   produce(job)  -> per language: translate, voice, fit (Claude rewrites what doesn't fit), render
# Both raise VTError with a readable message when something has to be fixed, and report progress through
# set_reporter(). A job folder may hold a job.toml with per-job settings (languages, voice, ...).

def analysis_stale(P, A) -> bool:
    """True when script.txt or cuts.txt were edited after the last analyze (e.g. in the review step)."""
    if [b["text"] for b in A["beats"]] != split_beats(P["script"].read_text()):
        return True
    if P["cuts"].exists():
        cuts = sorted(float(l.split("#")[0]) for l in P["cuts"].read_text().splitlines() if l.split("#")[0].strip())
        if [round(c, 3) for c in cuts] != [round(an["t"], 3) for an in A["anchors"]]:
            return True
    return False


def prepare(job, base_lang: str | None = None) -> dict:
    """First half of a job. Returns {"base_lang", "beats": [text], "warnings", "names_fixed": [...]}."""
    check_tools()
    P = job_paths(job)
    cfg = config(P["job"])
    log("analyzing the voiceover...", stage="analyze")
    A = cmd_analyze(argparse.Namespace(job=str(P["job"]), lang=base_lang))
    fixed = []
    if A["transcribed"] and cfg.get("claude", {}).get("fix_names", True):
        fixed = fix_names(P, A, cfg)
        if fixed:
            A = cmd_analyze(argparse.Namespace(job=str(P["job"]), lang=A["base_lang"]))
    log("ready for review", stage="prepared")
    return {"base_lang": A["base_lang"], "beats": [b["text"] for b in A["beats"]], "warnings": A["warnings"],
            "names_fixed": fixed}


def produce(job, langs: list[str] | None = None, retranslate: bool = False, render: bool = True,
            preview: bool = False) -> list[dict]:
    """Second half of a job. Returns one {"lang", "seconds", "flags", "report", "output", "preview"} per
    language. `preview` also makes a small H.264 copy of each output for playing in a browser."""
    check_tools()
    P = job_paths(job)
    cfg = config(P["job"])
    A = load_analysis(P)
    if analysis_stale(P, A):
        log("script.txt or cuts.txt changed - analyzing again", stage="analyze")
        had_warnings = bool(A.get("warnings"))
        A = cmd_analyze(argparse.Namespace(job=str(P["job"]), lang=A["base_lang"]))
        if A["warnings"] and not had_warnings:  # stop before paying for voices on a bad alignment
            die("after your edits, script.txt no longer matches the voiceover: " + " ".join(A["warnings"]) +
                " Only fix spelling; the words have to stay as spoken.")
        retranslate = True  # translations of the old text don't fit the new one
    langs = [l for l in (langs or cfg.get("languages", [])) if l != A["base_lang"]]
    if not langs:
        die("no target languages - name them (e.g. `run <job> de fr`) or set `languages` in config.toml")
    rounds = int(cfg.get("claude", {}).get("fix_rounds", 3))
    results = []
    for lang in langs:
        if retranslate or not (P["work"] / lang / "script.json").exists():
            translate_lang(P, A, lang, cfg)
        else:
            log(f"{lang}: using the existing work/{lang}/script.json", stage="translate", lang=lang)
        for rnd in range(rounds + 1):
            log(f"{lang}: voiceover...", stage="tts", lang=lang)
            cmd_tts(argparse.Namespace(job=str(P["job"]), lang=lang), quiet=True)
            plan = cmd_plan(argparse.Namespace(job=str(P["job"]), lang=lang))
            if not plan["flags"] or rnd == rounds:
                break
            refit_lang(P, A, lang, cfg, plan)
        out = None
        if render:
            log(f"{lang}: rendering...", stage="render", lang=lang)
            cmd_render(argparse.Namespace(job=str(P["job"]), lang=lang))
            out = P["out"] / f"{P['job'].name}_{lang}.mp4"
        prev = None
        if out and preview:
            log(f"{lang}: making the preview...", stage="preview", lang=lang)
            prev = make_preview(out, P["work"] / lang / "preview.mp4")
        res = {"lang": lang, "seconds": round(plan["total_frames"] / plan["fps"], 2),
               "flags": [f["msg"] for f in plan["flags"]], "report": str(P["work"] / lang / "report.md"),
               "output": str(out) if out else None, "preview": str(prev) if prev else None}
        log(f"{lang}: finished", stage="done", lang=lang, result=res)
        results.append(res)
    return results


def print_summary(results):
    print("\nsummary:")
    for r in results:
        state = f"{len(r['flags'])} thing(s) still flagged, see {r['report']}" if r["flags"] else "all cuts in sync"
        print(f"  {r['lang']}: {r['seconds']:.1f}s, {state}" + (f" -> {r['output']}" if r["output"] else ""))


def cmd_prepare(a):
    r = prepare(a.job, a.base_lang)
    for n in r["names_fixed"]:
        print(f"  fixed: {n}")
    print(f"\nscript.txt is ready ({len(r['beats'])} beats, {r['base_lang']}). Check it, then run `produce`.")


def cmd_produce(a):
    print_summary(produce(a.job, a.langs, a.retranslate, not a.no_render))


def cmd_run(a):
    """The whole job, no Claude Code needed (and no review stop)."""
    P = job_paths(a.job)
    if a.base_lang or not P["analysis"].exists():
        prepare(a.job, a.base_lang)
    print_summary(produce(a.job, a.langs, a.retranslate, not a.no_render))


def main():
    load_env()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("analyze"); p.add_argument("job"); p.add_argument("--lang", help="language of the original voiceover; detected when the script is transcribed")
    p.set_defaults(fn=cmd_analyze)
    for name, fn in (("translate", cmd_translate), ("tts", cmd_tts), ("plan", cmd_plan), ("render", cmd_render)):
        p = sub.add_parser(name); p.add_argument("job"); p.add_argument("lang"); p.set_defaults(fn=fn)
    p = sub.add_parser("prepare", help="first half: transcribe, fix names, align, detect cuts - then check script.txt")
    p.add_argument("job"); p.add_argument("--base-lang", help="language of the original voiceover (detected if transcribed)")
    p.set_defaults(fn=cmd_prepare)
    for name, fn, hlp in (("produce", cmd_produce, "second half: translate, voice, fit, render"),
                          ("run", cmd_run, "the whole job: prepare (if not done yet) + produce")):
        p = sub.add_parser(name, help=hlp)
        p.add_argument("job"); p.add_argument("langs", nargs="*", help="target languages (default: `languages` in config)")
        if name == "run":
            p.add_argument("--base-lang", help="language of the original voiceover; re-runs prepare")
        p.add_argument("--retranslate", action="store_true", help="translate again even if script.json exists")
        p.add_argument("--no-render", action="store_true", help="stop after fitting (check the reports first)")
        p.set_defaults(fn=fn)
    a = ap.parse_args()
    try:
        check_tools()
        a.fn(a)
    except VTError as e:
        print(f"\nERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
