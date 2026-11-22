// A Web Worker of the scene detection (lib/prepare/local.ts starts a few): it rotates and scales the luma planes it
// is sent (lib/prepare/scenes.ts) and sends back the 270-pixel-wide pictures. Scaling is the slow part (a 4K frame
// is ~35 million multiply-adds), so several of these run at once; the scores are worked out in order by the page.

import { LumaScaler, rotatePlane } from "./scenes";

export type SceneInit = { type: "init"; codedW: number; codedH: number; rotation: 0 | 90 | 180 | 270; dstW: number; dstH: number };
export type SceneFrame = { type: "frame"; id: number; data: ArrayBuffer; offset: number; stride: number };
export type ScenePicture = { id: number; pic: ArrayBuffer } | { id: number; error: string };

let scaler: LumaScaler | null = null;
let init: SceneInit | null = null;

self.onmessage = (e: MessageEvent<SceneInit | SceneFrame>) => {
  const m = e.data;
  if (m.type === "init") {
    init = m;
    const w = m.rotation % 180 ? m.codedH : m.codedW, h = m.rotation % 180 ? m.codedW : m.codedH;
    scaler = new LumaScaler(w, h, m.dstW, m.dstH);
    return;
  }
  try {
    if (!scaler || !init) throw new Error("not set up");
    const src = new Uint8Array(m.data, m.offset);
    const r = rotatePlane(src, m.stride, init.codedW, init.codedH, init.rotation);
    const out = new Uint8Array(init.dstW * init.dstH);
    scaler.scale(r.data, r.stride, out);
    (self as unknown as Worker).postMessage({ id: m.id, pic: out.buffer } satisfies ScenePicture, [out.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: m.id, error: (err as Error).message } satisfies ScenePicture);
  }
};
