"""
Parity fixtures for web/lib/pipeline (the timing plan and the voice track in TypeScript), made with ffmpeg and
scripts/vt.py itself: no API calls. Each case is a fake job with a synthetic analysis (beats, words, cuts tied
to words) and synthetic "TTS" clips (a tone burst per word, MP3 made with ffmpeg, with a per-character
alignment like ElevenLabs'), shaped to hit the solver's corners: voices too long and too short, trims,
minimum/maximum clip speeds, dropped and reordered markers, a held last frame, an alignment that doesn't match
the text.

  uv run --no-project --with requests python web/test/pipeline_fixture.py cases OUTDIR [--count 12] [--seed 1]

writes OUTDIR/<case>/ with the job folder, and prints JSON: per case the paths of what vt.py made from it
(plan.json as vt.portable_plan, report.md, voice.wav) and of the plan inputs (vt.plan_inputs) the browser
builds the same from.

  ... pipeline_fixture.py lufs FILE...          integrated loudness per file as ffmpeg's ebur128 has it (3 decimals)
  ... pipeline_fixture.py atempo IN.f32 TEMPO OUT.f32   ffmpeg atempo on raw mono float samples (44.1 kHz)
  ... pipeline_fixture.py limiter IN.f64 OUT.f64        ffmpeg alimiter=limit=0.95:level=0 on raw mono doubles
"""
from __future__ import annotations

import argparse
import json
import random
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import vt  # noqa: E402

SR = 44100
SOURCE = (1080, 1920)
WORDS = ("lumen", "glow", "neon", "the", "light", "turns", "warm", "every", "room", "colour", "bright", "soft",
         "smart", "home", "a", "set", "up", "in", "minutes", "app", "voice", "control", "scenes", "music", "sync")


def anchor_cuts(tokens: list[dict], cuts: list[float]) -> list[dict]:
    """vt.cmd_analyze step 3: tie every cut to the word being spoken."""
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
                anchors.append({"id": cid, "t": t, "kind": "in", "token": i, "frac": min(1.0, (t - tk["start"]) / span)})
            else:
                gap = max(1e-3, tokens[i + 1]["start"] - tk["end"])
                anchors.append({"id": cid, "t": t, "kind": "gap", "token": i + 1, "frac": (t - tk["end"]) / gap})
    return anchors


def tone_clip(path: Path, spans: list[tuple[float, float]], dur: float, freq: float, level_db: float):
    """An MP3 (libmp3lame, like ElevenLabs' files: LAME header with the encoder delay) with a tone during each
    (start, end) span and silence elsewhere."""
    env = "+".join(f"between(t,{a:.4f},{b:.4f})" for a, b in spans) or "0"
    amp = 10 ** (level_db / 20)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                    f"aevalsrc='{amp:.6f}*({env})*sin(2*PI*{freq}*t)':s={SR}:d={dur:.4f}",
                    "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", str(path)], check=True)


def make_case(d: Path, rnd: random.Random, kind: str) -> dict:
    d.mkdir(parents=True, exist_ok=True)
    (d / "source.mp4").write_bytes(b"")  # vt.job_paths wants a video; plan_inputs' size comes from SOURCE
    work = d / "work"
    lang = "xx"
    tts = work / lang / "tts"
    tts.mkdir(parents=True, exist_ok=True)

    # the original: beats of words with times
    nbeats = rnd.randint(2, 6)
    t = rnd.uniform(0.2, 1.2)
    tokens, beats = [], []
    for bi in range(nbeats):
        nw = rnd.randint(2, 9)
        idx0 = len(tokens)
        for _ in range(nw):
            w = rnd.choice(WORDS)
            wd = 0.06 * len(w) + rnd.uniform(0.05, 0.2)
            tokens.append({"beat": bi, "text": w, "start": round(t, 3), "end": round(t + wd, 3)})
            t += wd + rnd.uniform(0.02, 0.15)
        st, en = tokens[idx0]["start"], tokens[-1]["end"]
        t += rnd.uniform(0.15, 0.9)
        beats.append({"id": bi + 1, "text": " ".join(x["text"] for x in tokens[idx0:]), "start": st, "end": en,
                      "dur": round(en - st, 3)})
    for i, b in enumerate(beats):
        b["pause_after"] = round(beats[i + 1]["start"] - b["end"], 3) if i + 1 < len(beats) else 0.0
    s0, s1 = tokens[0]["start"], tokens[-1]["end"]
    vid_dur = round(s1 + rnd.uniform(0.3, 2.5), 3)
    fps = rnd.choice([30.0, 25.0, 30000 / 1001, 24.0, 60.0])
    ncuts = rnd.randint(2, 9)
    cuts = sorted({round(rnd.uniform(0.1, vid_dur - 0.1) * fps) / fps for _ in range(ncuts)})
    if kind == "lead_tail":
        cuts = sorted(set(cuts) | {round(s0 * 0.5 * fps) / fps, round((s1 + 0.2) * fps) / fps})
    cuts = [c for c in cuts if 0.05 < c < vid_dur - 0.05]
    anchors = anchor_cuts(tokens, cuts)
    A = {"base_lang": "en", "video": {"path": str(d / "source.mp4"), "dur": vid_dur, "fps": fps, "w": 1080, "h": 1920},
         "speech_start": s0, "speech_end": s1, "beats": beats, "tokens": tokens, "anchors": anchors,
         "base_lufs": round(rnd.uniform(-22, -14), 1), "warnings": [], "transcribed": False}
    (work / "analysis.json").write_text(json.dumps(A, indent=1))

    # the translation: as many words, more (too long) or fewer (too short), markers moved along
    factor = {"long": rnd.uniform(1.3, 1.8), "short": rnd.uniform(0.4, 0.7)}.get(kind, rnd.uniform(0.8, 1.25))
    marks_at: dict[int, list[int]] = {}
    for an in anchors:
        if an["kind"] in ("in", "gap"):
            marks_at.setdefault(an["token"], []).append(an["id"])
    script, index = [], []
    for bi, b in enumerate(beats):
        btoks = [i for i, tk in enumerate(tokens) if tk["beat"] == bi]
        nw = max(1, round(len(btoks) * factor))
        words = [rnd.choice(WORDS) for _ in range(nw)]
        # markers: on the word at the same relative place
        place: dict[int, list[int]] = {}
        for k, ti in enumerate(btoks):
            for m in marks_at.get(ti, []):
                if kind == "dropped" and rnd.random() < 0.4:
                    continue
                pos = min(nw - 1, int(k * nw / len(btoks)))
                if kind == "reordered" and rnd.random() < 0.5:
                    pos = rnd.randrange(nw)
                place.setdefault(pos, []).append(m)
        text = " ".join("".join(f"{{{m}}}" for m in place.get(k, [])) + w for k, w in enumerate(words))
        speed = rnd.choice([None, None, 0.9, 1.1])
        sb = {"id": b["id"], "text": text}
        if speed:
            sb["speed"] = speed
        script.append(sb)

        # the clip: a tone burst per word, an alignment per character
        clean = vt.strip_markers(text)[0]
        rate = rnd.uniform(0.055, 0.085) * (1.0 if speed is None else 1 / speed)
        lead = rnd.choice([0.0, 0.02, rnd.uniform(0.03, 0.3)])
        ct, chars, cst, cen, spans = lead, [], [], [], []
        for k, w in enumerate(clean.split(" ")):
            if k:
                gap = rnd.uniform(0.03, 0.12)
                chars.append(" "); cst.append(round(ct, 3)); cen.append(round(ct + gap, 3)); ct += gap
            ws = ct
            for c in w:
                chars.append(c); cst.append(round(ct, 3)); cen.append(round(ct + rate, 3)); ct += rate
            spans.append((ws, ct))
        tail = rnd.choice([0.02, 0.05, rnd.uniform(0.1, 0.4)])  # sometimes shorter than the 0.1 s clip tail
        dur = ct + tail
        key = f"{bi:02d}{rnd.getrandbits(40):010x}"
        mp3 = tts / f"{key}.mp3"
        tone_clip(mp3, spans, dur, rnd.choice([220, 330, 440, 523, 660]), rnd.uniform(-20, -2))
        al = {"characters": chars, "character_start_times_seconds": cst, "character_end_times_seconds": cen}
        if kind == "misaligned":  # the API's characters don't match the text 1:1
            al = {k: v[::2] for k, v in al.items()}
        tts_speed = max(0.7, min(1.2, speed or 1.0))
        (tts / f"{key}.json").write_text(json.dumps({"text": clean, "speed": tts_speed, "alignment": al,
                                                     "normalized_alignment": None}))
        index.append({"beat": b["id"], "audio": str(mp3), "speed": tts_speed})
    (work / lang / "script.json").write_text(json.dumps({"lang": lang, "beats": script}, indent=1))
    (work / lang / "tts_index.json").write_text(json.dumps(index, indent=1))

    fit = {}
    if kind == "tight":
        fit = {"video_speed_min": 0.97, "video_speed_max": 1.03, "trim_keep_min": 0.8, "sync_tolerance": 0.1}
    elif kind == "loose":
        fit = {"video_speed_min": 0.8, "video_speed_max": 1.25, "trim_keep_min": 0.2, "audio_tempo_min": 0.9,
               "audio_tempo_max": 1.12, "sync_tolerance": 0.35, "pause_max_extra": 0.8}
    lines = ['[elevenlabs]', 'voice_id = "test-voice"']
    if fit:
        lines += ["[fit]"] + [f"{k} = {v}" for k, v in fit.items()]
    (d / "job.toml").write_text("\n".join(lines) + "\n")

    P = vt.job_paths(d)
    cfg = vt.config(P["job"])
    plan = vt.build_plan(P, A, lang, cfg)
    (work / lang / "plan.json").write_text(json.dumps(plan, indent=1))
    report = vt.write_report(P, plan)
    portable = work / lang / "plan_web.json"
    portable.write_text(json.dumps(vt.portable_plan(plan, SOURCE), indent=1))
    voice = vt.build_voice_track(P, A, plan)
    inputs, files = vt.plan_inputs(P, A, lang, cfg)
    ip = work / lang / "inputs.json"
    ip.write_text(json.dumps(inputs, indent=1))
    return {"name": d.name, "kind": kind, "inputs": str(ip), "tts": str(tts), "plan": str(portable),
            "report": str(report), "voice": str(voice), "job_name": d.name,
            "durations": {Path(f).name: vt.media_duration(f) for f in files if f.suffix == ".mp3"},
            "flags": len(plan["flags"]), "tempos": sorted({b["tempo"] for b in plan["beats"]}),
            "trimmed": sum(1 for s in plan["segments"] if s["trimmed"] > 0.02),
            "speeds": [min(s["speed"] for s in plan["segments"]), max(s["speed"] for s in plan["segments"])]}


KINDS = ("plain", "long", "short", "dropped", "reordered", "lead_tail", "misaligned", "tight", "loose")


def lufs3(path: str) -> float | None:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-af",
                        "ebur128=metadata=1,ametadata=print:key=lavfi.r128.I:file=-", "-f", "null", "-"],
                       capture_output=True, text=True)
    m = re.findall(r"lavfi\.r128\.I=(-?[\d.]+)", r.stdout)
    return float(m[-1]) if m else None


def main():
    vt.video_size = lambda path: SOURCE  # the fixtures have no real video
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("cases"); p.add_argument("out"); p.add_argument("--count", type=int, default=len(KINDS) * 2)
    p.add_argument("--seed", type=int, default=1)
    p = sub.add_parser("lufs"); p.add_argument("files", nargs="+")
    p = sub.add_parser("atempo"); p.add_argument("input"); p.add_argument("tempo", type=float); p.add_argument("output")
    p = sub.add_parser("limiter"); p.add_argument("input"); p.add_argument("output")
    a = ap.parse_args()
    if a.cmd == "cases":
        out = Path(a.out)
        cases = [make_case(out / f"case{i:02d}", random.Random(a.seed * 1000 + i), KINDS[i % len(KINDS)])
                 for i in range(a.count)]
        print(json.dumps(cases))
    elif a.cmd == "lufs":
        print(json.dumps({f: lufs3(f) for f in a.files}))
    elif a.cmd == "atempo":
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", a.input,
                        "-af", f"atempo={a.tempo:.4f}", "-f", "f32le", a.output], check=True)
    else:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f64le", "-ar", str(SR), "-ac", "1", "-i", a.input,
                        "-af", "alimiter=limit=0.95:level=0", "-f", "f64le", a.output], check=True)


if __name__ == "__main__":
    main()
