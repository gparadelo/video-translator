"""
The produce half of a job (translate, voice, fit with Claude's rewrites) run by scripts/vt.py itself, against the
fake Claude and ElevenLabs of test/mocks.mjs: the reference the web app's produce steps (web/lib/produce) are
checked against. No paid API calls.

  uv run --no-project --with requests --with anthropic python web/test/produce_fixture.py case DIR --seed N
        [--video SRC.mp4 --size WxH --dur SECONDS --fps FPS] [--broken]
      A fake job in DIR that `vt.py prepare` would have left: script.txt and work/analysis.json (a synthetic
      voiceover: beats of words with times, cuts tied to words, markers in the text). Prints the path of its
      analysis.json as the web app keeps it (vt.portable_analysis).
  ... produce_fixture.py produce DIR LANG --claude URL --eleven URL [--render]
      vt.produce(DIR, [LANG], render=False) against the fakes; prints what it made: script.json, every TTS clip,
      the plan inputs (vt.plan_inputs), the usage events. --render also renders it with the CLI (vt.cmd_render),
      the reference of test/e2e.
  ... produce_fixture.py strings              vt.py's prompts, schema, language names and [claude]/[elevenlabs]
  ... produce_fixture.py calls < CALLS.json   vt.py's answers to single calls (check_script, tts bodies and keys,
                                              json.dumps, round, brief_table, refit prompt)
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import random
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import vt  # noqa: E402
from pipeline_fixture import WORDS, anchor_cuts  # noqa: E402

SOURCE = (1080, 1920)


def make_job(d: Path, seed: int, video: Path | None, size: tuple[int, int], dur: float | None, fps: float | None,
             broken: bool = False) -> dict:
    rnd = random.Random(seed)
    d.mkdir(parents=True, exist_ok=True)
    if video:
        (d / "source.mp4").symlink_to(video.resolve())
    else:
        (d / "source.mp4").write_bytes(b"")
    (d / "job.toml").write_text('[elevenlabs]\nvoice_id = "voice123456789"\n')
    nbeats = rnd.randint(3, 5) if video else rnd.randint(2, 6)
    t = rnd.uniform(0.2, 0.8)
    tokens, beats = [], []
    for bi in range(nbeats):
        idx0 = len(tokens)
        for _ in range(rnd.randint(3, 7)):
            w = rnd.choice(WORDS)
            wd = 0.06 * len(w) + rnd.uniform(0.05, 0.15)
            tokens.append({"beat": bi, "text": w, "cs": 0, "start": round(t, 3), "end": round(t + wd, 3)})
            t += wd + rnd.uniform(0.02, 0.1)
        text = " ".join(x["text"] for x in tokens[idx0:])
        pos = 0
        for tk in tokens[idx0:]:  # character position of each word in its beat (vt.cmd_analyze)
            tk["cs"] = text.index(tk["text"], pos)
            pos = tk["cs"] + len(tk["text"])
        if bi == 0 and seed % 4 == 1:
            text = text.capitalize() + "."  # punctuation and capitals, as transcripts have
        if bi == 0 and broken:
            text += " ALWAYS-BROKEN"  # the fake Claude never gets this one right
        st, en = tokens[idx0]["start"], tokens[-1]["end"]
        t += rnd.uniform(0.2, 0.7)
        beats.append({"id": bi + 1, "text": text, "start": st, "end": en, "dur": round(en - st, 3)})
    for i, b in enumerate(beats):
        b["pause_after"] = round(beats[i + 1]["start"] - b["end"], 3) if i + 1 < len(beats) else 0.0
    s0, s1 = tokens[0]["start"], tokens[-1]["end"]
    vid_dur = dur or round(s1 + rnd.uniform(0.4, 1.5), 3)
    fps = fps or rnd.choice([30.0, 25.0, 30000 / 1001])
    if s1 > vid_dur - 0.5:
        raise SystemExit("the speech doesn't fit the video")
    cuts = sorted({round(rnd.uniform(0.1, vid_dur - 0.1) * fps) / fps for _ in range(rnd.randint(2, 7))})
    anchors = anchor_cuts(tokens, [c for c in cuts if 0.05 < c < vid_dur - 0.05])
    marks_at: dict[int, list[int]] = {}
    for an in anchors:
        if an["kind"] in ("in", "gap"):
            marks_at.setdefault(an["token"], []).append(an["id"])
    for bi, b in enumerate(beats):  # vt.cmd_analyze step 4
        idx = [i for i, tk in enumerate(tokens) if tk["beat"] == bi]
        marked, pos = "", 0
        for i in idx:
            cs = tokens[i]["cs"]
            marked += b["text"][pos:cs] + "".join(f"{{{m}}}" for m in marks_at.get(i, []))
            pos = cs
        b["marked"] = marked + b["text"][pos:]
    A = {"base_lang": "en", "video": {"path": str(d / "source.mp4"), "dur": vid_dur, "fps": fps, "w": size[0], "h": size[1]},
         "speech_start": s0, "speech_end": s1, "beats": beats, "tokens": tokens, "anchors": anchors,
         "base_lufs": round(rnd.uniform(-22, -14), 1), "warnings": [], "transcribed": False}
    (d / "work").mkdir(exist_ok=True)
    (d / "work" / "analysis.json").write_text(json.dumps(A, ensure_ascii=False, indent=1))
    (d / "script.txt").write_text("\n\n".join(b["text"] for b in beats) + "\n")  # not stale: produce won't re-analyze
    pa = d / "analysis_web.json"
    pa.write_text(json.dumps(vt.portable_analysis(A, vt.video_size(Path(A["video"]["path"]))), ensure_ascii=False, indent=1))
    return {"job": str(d), "analysis": str(pa)}


def produce(d: Path, lang: str, claude: str, eleven: str, render: bool) -> dict:
    os.environ["ANTHROPIC_BASE_URL"] = claude
    vt.API = eleven
    vt.use_keys(ELEVENLABS_API_KEY="fake-eleven-key", ANTHROPIC_API_KEY="fake-claude-key")
    usage = []
    vt.set_reporter(lambda ev: ev.get("usage") and usage.append(ev["usage"]))
    try:
        res = vt.produce(d, [lang], render=False)[0]
        error = None
    except vt.VTError as e:
        res, error = None, str(e)
    P = vt.job_paths(d)
    work = P["work"] / lang
    out = {"error": error, "usage": usage,
           "script": json.loads((work / "script.json").read_text()) if (work / "script.json").exists() else None,
           "tts": sorted(p.name for p in (work / "tts").glob("*")) if (work / "tts").exists() else [],
           "tts_dir": str(work / "tts")}
    if res:
        A = vt.load_analysis(P)
        cfg = vt.config(P["job"])
        inputs, _ = vt.plan_inputs(P, A, lang, cfg)
        out.update(flags=res["flags"], seconds=res["seconds"], inputs=inputs)
        (work / "inputs.json").write_text(json.dumps(inputs, ensure_ascii=False, indent=1))
        if render:
            plan = json.loads((work / "plan.json").read_text())
            (work / "plan_web.json").write_text(json.dumps(vt.portable_plan(plan, vt.video_size(P["base"])), indent=1))
            vt.cmd_render(argparse.Namespace(job=str(d), lang=lang))
            out.update(plan=str(work / "plan_web.json"), voice=str(work / "voice.wav"),
                       reference=str(P["out"] / f"{d.name}_{lang}.mp4"), inputs_path=str(work / "inputs.json"))
    return out


def strings() -> dict:
    cfg = vt.config()
    return {"translate_system": vt.TRANSLATE_SYSTEM, "script_schema": vt.SCRIPT_SCHEMA, "lang_names": vt.LANG_NAMES,
            "claude": cfg["claude"], "elevenlabs": {k: v for k, v in cfg["elevenlabs"].items() if k != "stt_model"},
            "fit": {k: cfg["fit"][k] for k in vt.FIT_KEYS}, "key_permissions": list(vt.KEY_PERMISSIONS)}


def tts_call(c: dict) -> dict:
    """vt.tts_beat's request body and cache key for one beat (the request itself is caught, not sent)."""
    cfg = vt.config()
    cfg["elevenlabs"] = {**cfg["elevenlabs"], "voice_id": c["voice"], "model_id": c.get("model_id", cfg["elevenlabs"]["model_id"])}
    sent = {}

    class R:
        status_code = 200

        @staticmethod
        def json():
            return {"audio_base64": base64.b64encode(b"x").decode(), "alignment": None, "normalized_alignment": None}

    def post(url, params=None, headers=None, json=None, timeout=None):
        sent.update(url=url, params=params, body=json)
        return R()

    real, vt.requests.post = vt.requests.post, post
    vt.use_keys(ELEVENLABS_API_KEY="k")
    try:
        texts, i = c["texts"], c["i"]
        with tempfile.TemporaryDirectory() as tmp:
            r = vt.tts_beat(texts[i], texts[i - 1] if i else "", texts[i + 1] if i + 1 < len(texts) else "",
                            c["lang"], float(c["speed"]) if c.get("speed") is not None else None, cfg, Path(tmp))  # floats, as in script.json
            key = Path(r["audio"]).stem
    finally:
        vt.requests.post = real
    return {"key": key, "body": sent["body"], "params": sent["params"], "url": sent["url"], "speed": r["speed"]}


def calls(items: list[dict]) -> list:
    out = []
    for c in items:
        k = c["call"]
        if k == "check":
            out.append(vt.check_script({"beats": c["base"]}, c["beats"]))
        elif k == "tts":
            out.append(tts_call(c))
        elif k == "dumps":
            out.append(json.dumps(c["value"], sort_keys=True))
        elif k == "repr":
            out.append([repr(float(x)) for x in c["values"]])
        elif k == "round2":
            out.append([round(max(0.7, min(1.2, float(x))), 2) for x in c["values"]])
        elif k == "brief":
            out.append(vt.brief_table({"beats": c["beats"]}))
        elif k == "script":
            with tempfile.TemporaryDirectory() as tmp:
                p = vt.write_lang_script({"work": Path(tmp)}, "xx", c["beats"])
                out.append(json.loads(p.read_text())["beats"])
        elif k == "refit":  # the prompt vt.refit_lang sends for this script and plan
            seen = []

            def fake(cfg, messages, _seen=seen):
                _seen.append(messages[0]["content"])
                return [{"id": b["id"], "text": b["marked"], "speed": None} for b in c["base"]], {}

            real, vt.claude_script = vt.claude_script, fake
            try:
                with tempfile.TemporaryDirectory() as tmp:
                    (Path(tmp) / c["lang"]).mkdir()
                    script = [{**b, "speed": float(b["speed"])} if b.get("speed") is not None else b
                              for b in c["script"]]  # floats, as vt.write_lang_script writes them
                    (Path(tmp) / c["lang"] / "script.json").write_text(json.dumps({"lang": c["lang"], "beats": script}))
                    vt.refit_lang({"work": Path(tmp)}, {"beats": c["base"], "base_lang": c["base_lang"]}, c["lang"], {},
                                  c["plan"])
            finally:
                vt.claude_script = real
            out.append(seen[0])
        else:
            raise SystemExit(f"unknown call {k}")
    return out


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("case"); p.add_argument("dir"); p.add_argument("--seed", type=int, default=1)
    p.add_argument("--video"); p.add_argument("--size", default="1080x1920"); p.add_argument("--dur", type=float)
    p.add_argument("--fps", type=float); p.add_argument("--broken", action="store_true")
    p = sub.add_parser("produce"); p.add_argument("dir"); p.add_argument("lang"); p.add_argument("--claude", required=True)
    p.add_argument("--eleven", required=True); p.add_argument("--render", action="store_true")
    sub.add_parser("strings")
    sub.add_parser("calls")
    a = ap.parse_args()
    vt.set_reporter(lambda ev: None)  # stdout is for the JSON
    if a.cmd == "case":
        size = tuple(int(x) for x in a.size.split("x"))
        if not a.video:
            vt.video_size = lambda path: SOURCE  # no real video: the size is made up
        print(json.dumps(make_job(Path(a.dir), a.seed, Path(a.video) if a.video else None, size, a.dur, a.fps, a.broken)))
    elif a.cmd == "produce":
        if not a.render:
            vt.video_size = lambda path: SOURCE
        print(json.dumps(produce(Path(a.dir), a.lang, a.claude, a.eleven, a.render), ensure_ascii=False))
    elif a.cmd == "strings":
        print(json.dumps(strings(), ensure_ascii=False))
    else:
        print(json.dumps(calls(json.load(sys.stdin)), ensure_ascii=False))


if __name__ == "__main__":
    main()
