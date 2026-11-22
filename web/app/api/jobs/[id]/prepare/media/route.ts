import type { NextRequest } from "next/server";
import { ProduceError } from "@/lib/produce/errors";
import { intIn } from "@/lib/produce/server";
import { AUDIO_FILES, type AudioFile } from "@/lib/prepare/media";
import { prepareStep, r2Links } from "@/lib/prepare/server";
import { mediaStep } from "@/lib/prepare/steps";

// Signed links and a few object sizes: quick.
export const maxDuration = 60;

// POST /api/jobs/<id>/prepare/media
//   {phase: "start"}                                   -> {ready: true} | {ready: false, measure, source}: the browser
//                                                         measures the video (from its own file, or from `source`)
//   {phase: "upload", audio, audio_bytes, media_bytes?} -> {uploads: {audio, media}}: signed PUT links
//   {phase: "done", audio, audio_bytes}                 -> {ready: true} once both arrived and media.json checks out
// `audio`: "audio.m4a" or "audio.wav". Errors: {error, retry?, after?, code?}. See lib/prepare/steps.ts.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/prepare/media">) {
  return prepareStep(request, ctx.params, ["preparing", "aligning"], null, ({ job }, body) => {
    if (body.phase === "start") return mediaStep(job, r2Links, { phase: "start" });
    if (body.phase !== "upload" && body.phase !== "done") throw new ProduceError("say which phase (start, upload or done)", { status: 400 });
    if (typeof body.audio !== "string" || !(body.audio in AUDIO_FILES)) throw new ProduceError("unknown voiceover file", { status: 400 });
    const audio = body.audio as AudioFile;
    const audioBytes = intIn(body.audio_bytes, 1, 100_000_000, "the voiceover's size");
    if (body.phase === "done") return mediaStep(job, r2Links, { phase: "done", audio, audio_bytes: audioBytes });
    const mediaBytes = body.media_bytes === undefined ? undefined : intIn(body.media_bytes, 1, 1_000_000, "the measurements' size");
    return mediaStep(job, r2Links, { phase: "upload", audio, audio_bytes: audioBytes, media_bytes: mediaBytes });
  });
}
