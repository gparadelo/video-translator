"""
The prepare half of a job (analyze a video, transcribe, fix names, time every word) run by scripts/vt.py itself,
against the fake ElevenLabs and Claude of test/mocks.mjs: the reference the web app's analysis (web/lib/prepare)
is checked against. No paid API calls.

  uv run --no-project --with requests --with anthropic python web/test/prepare_fixture.py media VIDEO
      What vt.cmd_analyze measures of the video itself: ffprobe's duration and frame rate, the shown size
      (vt.video_size), the cuts (vt.detect_cuts with the default threshold) and the loudness (vt.lufs).
  ... prepare_fixture.py scores VIDEO
      ffmpeg's scene score of every frame (scale=270:-2, select, metadata=print), with its pts_time.
  ... prepare_fixture.py prepare DIR VIDEO --eleven URL --claude URL [--reference TEXT]
      vt.prepare on a job folder DIR with that video, as the worker ran it; prints the analysis as the web app
      keeps it (vt.portable_analysis), the transcript, names_fixed, warnings, the usage events, and the path of the
      audio vt.py sent to ElevenLabs (work/base_vo.m4a).
  ... prepare_fixture.py align DIR --eleven URL --script TEXT [--warnings JSON]
      what the worker's align did with an edited transcript (worker.Job.align): the new analysis, the transcript
      as split, the warnings and ok.
  ... prepare_fixture.py calls < CALLS.json   vt.py's answers to single calls (split_beats, script_from_words,
                                              norm, SequenceMatcher, fix_names' prompt)
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import vt  # noqa: E402


def media(video: Path) -> dict:
    meta = vt.probe(video)
    vs = next(s for s in meta["streams"] if s["codec_type"] == "video")
    num, den = vs["r_frame_rate"].split("/")
    fps = float(num) / float(den)
    dur = float(meta["format"]["duration"])
    cfg = vt.config()
    w, h = vt.video_size(video)
    return {"dur": dur, "fps": fps, "r_frame_rate": vs["r_frame_rate"], "width": w, "height": h,
            "cuts": vt.detect_cuts(video, cfg["fit"]["scene_threshold"], dur, fps), "base_lufs": vt.lufs(video)}


def scores(video: Path) -> list:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(video), "-an", "-vf",
                        "scale=270:-2,select='gte(scene,0)',metadata=print", "-f", "null", "-"],
                       capture_output=True, text=True)
    out = []
    for m in re.finditer(r"pts_time:([0-9.e+-]+)\s*\n.*?lavfi\.scene_score=([0-9.]+)", r.stderr, re.S):
        out.append([m.group(1), m.group(2)])
    return out


def use_fakes(eleven: str, claude: str | None):
    vt.API = eleven
    if claude:
        os.environ["ANTHROPIC_BASE_URL"] = claude
    vt.use_keys(ELEVENLABS_API_KEY="fake-eleven-key", ANTHROPIC_API_KEY="fake-claude-key")


def prepare(d: Path, video: Path, eleven: str, claude: str, reference: str | None) -> dict:
    d.mkdir(parents=True, exist_ok=True)
    src = d / "source.mp4"
    if not src.exists():
        shutil.copyfile(video, src)
    (d / "job.toml").write_text('languages = ["de"]\n[elevenlabs]\nvoice_id = "voice123456789"\n')  # produce_fixture can go on with it
    if reference:
        (d / "reference.txt").write_text(reference)  # what the worker wrote from jobs.reference
    use_fakes(eleven, claude)
    usage = []
    vt.set_reporter(lambda ev: ev.get("usage") and usage.append(ev["usage"]))
    try:
        r = vt.prepare(d)
        error = None
    except vt.VTError as e:
        r, error = None, str(e)
    P = vt.job_paths(d)
    out = {"error": error, "usage": usage, "audio": str(P["work"] / "base_vo.m4a")}
    if r:
        A = vt.load_analysis(P)
        out.update(analysis=vt.portable_analysis(A, vt.video_size(P["base"])), script="\n\n".join(r["beats"]),
                   base_lang=r["base_lang"], names_fixed=r["names_fixed"], warnings=r["warnings"],
                   cuts_file=P["cuts"].read_text())
    return out


def align(d: Path, eleven: str, script: str, warnings: list[str]) -> dict:
    """worker.Job.align, without the database and storage."""
    use_fakes(eleven, None)
    usage = []
    vt.set_reporter(lambda ev: ev.get("usage") and usage.append(ev["usage"]))
    P = vt.job_paths(d)
    wanted = vt.split_beats(script or "")
    if not wanted:
        return {"error": "the transcript is empty"}
    if not P["script"].exists() or vt.split_beats(P["script"].read_text()) != wanted:
        P["script"].write_text("\n\n".join(wanted) + "\n")
    had_warnings = bool(warnings)
    A = vt.load_analysis(P)
    had_warnings = had_warnings or bool(A.get("warnings"))
    stale = vt.analysis_stale(P, A)
    if stale:
        A = vt.cmd_analyze(argparse.Namespace(job=str(P["job"]), lang=A["base_lang"]))
    ok = not (A["warnings"] and not had_warnings)
    warns = A["warnings"] if ok else [
        "After your edits, the transcript no longer matches the voiceover: " + " ".join(A["warnings"]) +
        " Only fix spelling; the words have to stay as spoken."]
    return {"error": None, "usage": usage, "stale": stale, "ok": ok, "warnings": warns,
            "script": "\n\n".join(b["text"] for b in A["beats"]),
            "analysis": vt.portable_analysis(A, vt.video_size(P["base"]))}


def calls(items: list[dict]) -> list:
    out = []
    for c in items:
        k = c["call"]
        if k == "split":
            out.append(vt.split_beats(c["text"]))
        elif k == "words":
            out.append(vt.script_from_words(c["words"], c.get("pause", 1.0)))
        elif k == "norm":
            out.append([vt.norm(w) for w in c["words"]])
        elif k == "blocks":
            sm = difflib.SequenceMatcher(None, c["a"], c["b"], autojunk=False)
            out.append([list(b) for b in sm.get_matching_blocks()])
        elif k == "ratio":
            out.append(difflib.SequenceMatcher(None, c["a"].lower(), c["b"].lower()).ratio())
        elif k == "names_prompt":  # the message vt.fix_names sends for these beats and reference
            seen = {}

            def fake(cfg, system, schema, messages, _seen=seen):
                _seen.update(system=system, schema=schema, prompt=messages[0]["content"])
                return {"beats": list(c["beats"]), "changes": []}, {}

            real, vt.claude_json = vt.claude_json, fake
            try:
                import tempfile
                with tempfile.TemporaryDirectory() as tmp:
                    if c.get("reference") is not None:
                        (Path(tmp) / "reference.txt").write_text(c["reference"])
                    vt.fix_names({"job": Path(tmp), "script": Path(tmp) / "script.txt"},
                                 {"beats": [{"text": b} for b in c["beats"]], "base_lang": c["base_lang"]}, {})
            finally:
                vt.claude_json = real
            out.append(seen)
        else:
            raise SystemExit(f"unknown call {k}")
    return out


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("media"); p.add_argument("video")
    p = sub.add_parser("scores"); p.add_argument("video")
    p = sub.add_parser("prepare"); p.add_argument("dir"); p.add_argument("video"); p.add_argument("--eleven", required=True)
    p.add_argument("--claude", required=True); p.add_argument("--reference")
    p = sub.add_parser("align"); p.add_argument("dir"); p.add_argument("--eleven", required=True)
    p.add_argument("--script", required=True); p.add_argument("--warnings", default="[]")
    sub.add_parser("calls")
    a = ap.parse_args()
    vt.set_reporter(lambda ev: None)  # stdout is for the JSON
    if a.cmd == "media":
        res = media(Path(a.video))
    elif a.cmd == "scores":
        res = scores(Path(a.video))
    elif a.cmd == "prepare":
        res = prepare(Path(a.dir), Path(a.video), a.eleven, a.claude, a.reference)
    elif a.cmd == "align":
        res = align(Path(a.dir), a.eleven, a.script, json.loads(a.warnings))
    else:
        res = calls(json.load(sys.stdin))
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
