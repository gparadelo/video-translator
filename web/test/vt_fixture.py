"""
Test fixtures made with ffmpeg and scripts/vt.py itself (no API calls). Used by the tests in web/test/.

  uv run --no-project --with requests python web/test/vt_fixture.py video OUT.mp4 [--rate 30] [--timescale N] [--seconds 12]
      A synthetic video: testsrc2 with the frame number written as 16 black/white blocks across the top ninth
      (block i is white when bit i of the frame number is set), plus a sine tone.
  ... vt_fixture.py segments SOURCE.mp4 CASES.json
      Renders each plan segment in CASES.json with vt.segment_cmd (lossless, so the blocks survive) and prints,
      as JSON, the source frame number shown in every output frame.
  ... vt_fixture.py codes VIDEO  /  compare VIDEO REFERENCE
      The frame numbers in a video, or how a (browser) render compares with the CLI's: frames, size, voice.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import vt  # noqa: E402

W, H, BITS = 640, 360, 16
BAND = 1 / 9  # the frame number band is the top ninth of the picture


def make_video(out: Path, rate: str, seconds: float, timescale: int | None, size: tuple[int, int] = (W, H)):
    w, h = size
    band = round(h * BAND)
    code = f"if(mod(floor(N/pow(2\\,floor(X*{BITS}/{w})))\\,2)\\,255\\,0)"
    cmd = ["ffmpeg", "-v", "error", "-y",
           "-f", "lavfi", "-i", f"testsrc2=s={w}x{h}:r={rate}:d={seconds}",
           "-f", "lavfi", "-i", f"color=black:s={w}x{band}:r={rate}:d={seconds},format=gray,geq=lum='{code}'",
           "-f", "lavfi", "-i", f"sine=f=440:d={seconds}",
           "-filter_complex", "[1]format=yuv420p[b];[0][b]overlay=0:0",
           "-c:v", "libx264", "-g", "30", "-bf", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]
    if timescale:
        cmd += ["-video_track_timescale", str(timescale)]
    subprocess.run(cmd + [str(out)], check=True)


def frame_codes(video: Path) -> list[int]:
    """The frame number written in each frame of `video` (any size: the band is scaled back to 16 blocks)."""
    d = subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-vf",
                        f"crop=iw:ih/9:0:0,scale={BITS}:1:flags=area,format=gray", "-f", "rawvideo", "-"],
                       capture_output=True, check=True).stdout
    return [sum(1 << i for i in range(BITS) if d[k * BITS + i] > 127) for k in range(len(d) // BITS)]


def fps_of(video: Path) -> float:
    s = next(s for s in vt.probe(video)["streams"] if s["codec_type"] == "video")
    num, den = s["r_frame_rate"].split("/")
    return float(num) / float(den)


def render_segments(src: Path, cases: list[dict], tmp: Path) -> list[list[int]]:
    fps = fps_of(src)
    out = []
    for i, s in enumerate(cases):
        f = tmp / f"seg{i}.mp4"
        cmd = vt.segment_cmd(str(src), s, fps, W, H, ["-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p"], str(f))
        subprocess.run(cmd, check=True)
        out.append(frame_codes(f))
        f.unlink()
    return out


def pcm(video: Path) -> list[float]:
    import array
    d = subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-map", "0:a", "-ac", "1", "-f", "f32le", "-"],
                       capture_output=True, check=True).stdout
    return array.array("f", d).tolist()


def compare(video: Path, ref: Path) -> dict:
    """A browser render against the CLI's (vt.cmd_render) render of the same plan: frame numbers shown in every
    frame, size, and how well the voice lines up."""
    vs = next(s for s in vt.probe(video)["streams"] if s["codec_type"] == "video")
    got, want = frame_codes(video), frame_codes(ref)
    a, b = pcm(video), pcm(ref)
    n = min(len(a), len(b))
    best = min(range(-300, 301), key=lambda off: sum(abs(a[i] - b[i + off]) for i in range(4096, n - 4096, 97)))
    err = sum((a[i] - b[i]) ** 2 for i in range(n)) / max(1, sum(x * x for x in b[:n]))
    return {"width": vs["width"], "height": vs["height"], "codec": vs["codec_name"], "frames": len(got),
            "ref_frames": len(want), "same": got == want,
            "first_mismatch": next((i for i, (x, y) in enumerate(zip(got, want)) if x != y),
                                   None if len(got) == len(want) else min(len(got), len(want))),
            "audio_samples": len(a), "ref_audio_samples": len(b), "audio_offset": best, "audio_rel_error": err,
            "duration": float(vt.probe(video)["format"]["duration"])}


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("video"); p.add_argument("out"); p.add_argument("--rate", default="30")
    p.add_argument("--seconds", type=float, default=12); p.add_argument("--timescale", type=int)
    p = sub.add_parser("segments"); p.add_argument("source"); p.add_argument("cases")
    p = sub.add_parser("codes"); p.add_argument("video")
    p = sub.add_parser("compare"); p.add_argument("video"); p.add_argument("reference")
    a = ap.parse_args()
    if a.cmd == "video":
        make_video(Path(a.out), a.rate, a.seconds, a.timescale)
    elif a.cmd == "segments":
        src = Path(a.source)
        print(json.dumps(render_segments(src, json.loads(Path(a.cases).read_text()), src.parent)))
    elif a.cmd == "codes":
        print(json.dumps(frame_codes(Path(a.video))))
    else:
        print(json.dumps(compare(Path(a.video), Path(a.reference))))


if __name__ == "__main__":
    main()
