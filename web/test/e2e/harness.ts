// Runs in a real browser (test/e2e/run.mjs) with the same code the job page uses: builds the fixture jobs' timing
// plans and voice tracks from their plan inputs (lib/pipeline, the clips decoded by this browser), renders the
// "flat" job from what it built, reading the source with range requests from the test server, and posts
// everything back to it.

import { BufferTarget, StreamTarget, type Target } from "mediabunny";
import { buildLanguage } from "../../lib/pipeline/build";
import { metaFile, parseClipMeta, parseInputs } from "../../lib/pipeline/inputs";
import { decodeMp3 } from "../../lib/pipeline/run";
import { checkVoice, parsePlan, sourceSize, type RenderPlan } from "../../lib/render/plan";
import { previewQuality, qualityOptions, type QualityId } from "../../lib/render/quality";
import { canEncodeVoice, findEncoder, measureSpeed, missingApis, openSource, renderPlan } from "../../lib/render/render";
import { chooseSaveTarget, cleanUpTemporaryFiles } from "../../lib/render/save";
import { parseWav, type Pcm } from "../../lib/render/wav";

type Mode = "preview" | QualityId;

const built = new Map<string, { plan: RenderPlan; voice: Pcm }>();

/** Plan inputs -> plan.json + voice.wav, as lib/pipeline/run.ts does it (without the API routes). */
async function build(name: string) {
  const t0 = performance.now();
  const inputs = parseInputs(await (await fetch(`/files/${name}/inputs.json`)).json());
  const clips = await Promise.all(inputs.clips.map(async (c) => {
    const meta = parseClipMeta(await (await fetch(`/files/${name}/tts/${metaFile(c.file)}`)).json(), c.file);
    const decoded = await decodeMp3(await (await fetch(`/files/${name}/tts/${c.file}`)).arrayBuffer());
    return { meta, ...decoded };
  }));
  const b = buildLanguage(inputs, clips);
  const planJson = JSON.stringify(b.portable, null, 1);
  await fetch(`/save/${name}-plan.json`, { method: "POST", body: planJson });
  await fetch(`/save/${name}-voice.wav`, { method: "POST", body: b.voice });
  built.set(name, { plan: parsePlan(JSON.parse(planJson)), voice: parseWav(b.voice) });
  return { ms: performance.now() - t0, seconds: b.seconds };
}

function flat() {
  const b = built.get("flat");
  if (!b) throw new Error("build the flat job first");
  return b;
}

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
  const { plan, voice } = flat();
  const source = await openSource(new URL("/files/source.mp4", location.href).href);
  try {
    const [w, h] = sourceSize(plan, source.width, source.height);
    checkVoice(plan, voice);
    const q = mode === "preview" ? previewQuality(w, h) : qualityOptions(w, h).find((o) => o.id === mode);
    if (!q) throw new Error(`no ${mode} option for ${w}x${h}`);
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
      mode, ...r, ms, bytes: out.length, encoder, size: [w, h], progressCalls,
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
  const { plan, voice } = flat();
  const source = await openSource(new URL("/files/source.mp4", location.href).href);
  const leftovers = async () => {
    const names: string[] = [];
    const root = await navigator.storage.getDirectory();
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    return names;
  };
  try {
    await cleanUpTemporaryFiles();
    const encoder = (await findEncoder(qualityOptions(...sourceSize(plan, source.width, source.height))[0]))!;
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

Object.assign(window, { runBuild: build, runE2E: run, runSave });
document.title = "ready";
