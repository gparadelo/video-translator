// Runs in a real browser (test/e2e/run.mjs): renders the fixture job with the same code the job page uses,
// reading the source with range requests from the test server, and posts the MP4 back to it.

import { BufferTarget, StreamTarget, type Target } from "mediabunny";
import { parsePlan } from "../../lib/render/plan";
import { previewQuality, qualityOptions, type QualityId } from "../../lib/render/quality";
import { canEncodeVoice, findEncoder, measureSpeed, missingApis, openSource, renderPlan } from "../../lib/render/render";
import { chooseSaveTarget, cleanUpTemporaryFiles } from "../../lib/render/save";
import { parseWav } from "../../lib/render/wav";

type Mode = "preview" | QualityId;

/** A target like a file on disk: positioned writes (moov at the end), collected here and posted as one file. */
function fileLikeTarget() {
  const chunks: { data: Uint8Array; position: number }[] = [];
  const stream = new WritableStream<{ type: "write"; data: Uint8Array; position: number }>({
    write: (c) => void chunks.push({ data: c.data.slice(), position: c.position }),
  });
  const target = new StreamTarget(stream, { chunked: true });
  const bytes = () => {
    const size = Math.max(...chunks.map((c) => c.position + c.data.length));
    const out = new Uint8Array(size);
    for (const c of chunks) out.set(c.data, c.position);
    return out;
  };
  return { target, bytes };
}

async function run(mode: Mode) {
  const missing = missingApis();
  if (missing) throw new Error(`missing ${missing}`);
  if (!(await canEncodeVoice())) throw new Error("no AAC encoder");
  const plan = parsePlan(await (await fetch("/files/plan.json")).json());
  const voice = parseWav(await (await fetch("/files/voice.wav")).arrayBuffer());
  const source = await openSource(new URL("/files/source.mp4", location.href).href);
  try {
    const q = mode === "preview" ? previewQuality(source.width, source.height) : qualityOptions(source.width, source.height).find((o) => o.id === mode);
    if (!q) throw new Error(`no ${mode} option for ${source.width}x${source.height}`);
    const encoder = await findEncoder(q, mode === "preview" ? ["avc"] : undefined);
    if (!encoder) throw new Error(`no encoder for ${mode}`);
    const speed = await measureSpeed(source, [encoder], 0.5);

    let target: Target;
    let bytes: () => Uint8Array<ArrayBuffer>;
    if (mode === "preview") {
      const t = new BufferTarget();
      target = t;
      bytes = () => new Uint8Array(t.buffer!);
    } else {
      ({ target, bytes } = fileLikeTarget());
    }
    const heap: number[] = [];
    const mem = () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    const sampler = setInterval(() => heap.push(mem()), 200);
    const t0 = performance.now();
    let progressCalls = 0;
    const r = await renderPlan({
      source, plan, voice, encoder, target, fastStart: mode === "preview" ? "in-memory" : false,
      onProgress: () => void progressCalls++,
    });
    const ms = performance.now() - t0;
    clearInterval(sampler);
    const out = bytes();
    await fetch(`/save/${mode}.mp4`, { method: "POST", body: out });
    return {
      mode, ...r, ms, bytes: out.length, encoder, size: [source.width, source.height], progressCalls,
      estimatedMs: speed[0] * plan.total_frames * 1000, peakHeapMB: Math.max(0, ...heap) / 1e6,
    };
  } finally {
    source.dispose();
  }
}

/**
 * The download path of the job page (save.ts) without the "Save as" window, which can't be automated: the
 * fallback through the browser's private storage, ending in a normal download. With `stopAfterMs` the render
 * is stopped part way, and nothing may be left behind.
 */
async function runSave(stopAfterMs?: number) {
  delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  const plan = parsePlan(await (await fetch("/files/plan.json")).json());
  const voice = parseWav(await (await fetch("/files/voice.wav")).arrayBuffer());
  const source = await openSource(new URL("/files/source.mp4", location.href).href);
  const leftovers = async () => {
    const names: string[] = [];
    const root = await navigator.storage.getDirectory();
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    return names;
  };
  try {
    await cleanUpTemporaryFiles();
    const encoder = (await findEncoder(qualityOptions(source.width, source.height)[0]))!;
    const save = (await chooseSaveTarget("e2e.mp4"))!;
    const ac = new AbortController();
    if (stopAfterMs) setTimeout(() => ac.abort(), stopAfterMs);
    let stopped = false;
    try {
      await renderPlan({ source, plan, voice, encoder, target: save.target, fastStart: false, signal: ac.signal, beforeFinalize: save.allowCommit });
      await save.finish();
    } catch (e) {
      await save.discard();
      if (!stopAfterMs || (e as Error).name !== "AbortError") throw e;
      stopped = true;
    }
    return { stopped, leftovers: stopAfterMs ? await leftovers() : [] };
  } finally {
    source.dispose();
  }
}

Object.assign(window, { runE2E: run, runSave });
document.title = "ready";
