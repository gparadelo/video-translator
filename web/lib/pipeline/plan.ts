// The timing plan of one language: how to cut and retime the original video so every cut lands on its word in
// the new voice, and where each beat's voice goes. A line-by-line port of the old Python pipeline (beat_timing,
// build_plan, portable_plan, write_report); test/pipeline-parity.test.ts checks it still gives the plans that
// pipeline made (frozen in test/fixtures). Pure functions: no DOM, no network.

import type { RenderPlan } from "../render/plan";
import { PLAN_FORMAT } from "../render/plan";
import { CHANNELS, CLIP_LEAD, CLIP_TAIL, SAMPLE_RATE, type Fit } from "./config";
import type { ClipMeta, PlanInputs } from "./inputs";
import { pyFormat, pyRound, stripMarkers, words } from "./py";

export type Token = { cs: number; start: number; end: number };
export type BeatTiming = { tokens: Token[]; marks: Map<number, number>; clip_in: number; clip_out: number };

/**
 * vt.beat_timing: each word's time in its TTS clip, which word every {n} marker is on, and the part of the
 * clip that is used. `duration` is the clip's length in seconds (decoded samples / 44100, as ffprobe says).
 */
export function beatTiming(textMarked: string, meta: ClipMeta, duration: number): BeatTiming {
  const { clean, marks } = stripMarkers(textMarked);
  const al = meta.alignment;
  const chars = al?.characters ?? [];
  const st = al?.character_start_times_seconds ?? [];
  const en = al?.character_end_times_seconds ?? [];
  const at = (a: number[], i: number) => {
    const v = a[i];
    if (typeof v !== "number") throw new Error("a recorded beat has no word timing: translate this language again");
    return v;
  };
  const toks: Token[] = [];
  for (const m of words(clean)) {
    const cs = m.start;
    const ce = m.end - 1;
    let s: number, e: number;
    if (chars.length === clean.length && chars.length) {
      s = at(st, cs);
      e = at(en, ce);
    } else {
      // the timing doesn't match the text character for character: map proportionally
      const n = Math.max(1, st.length);
      s = at(st, Math.min(n - 1, Math.floor((cs * n) / clean.length)));
      e = at(en, Math.min(n - 1, Math.floor((ce * n) / clean.length)));
    }
    toks.push({ cs, start: s, end: e });
  }
  if (!toks.length) throw new Error("a beat of the translation is empty: translate this language again");
  const tokOfMark = new Map<number, number>();
  for (const [mid, idx] of marks) {
    const k = toks.findIndex((t) => t.cs >= idx);
    tokOfMark.set(mid, k === -1 ? toks.length - 1 : k);
  }
  return {
    tokens: toks,
    marks: tokOfMark,
    clip_in: Math.max(0.0, toks[0].start - CLIP_LEAD),
    clip_out: Math.min(duration, toks[toks.length - 1].end + CLIP_TAIL),
  };
}

export type Segment = {
  seg: number; src_start: number; src_len: number; base_len: number; frames: number; out_start: number;
  speed: number; trimmed: number;
};
export type Flag = { cut: number | null; beat: number | null; error: number; msg: string };
export type BeatRow = {
  beat: number; offset: number; clip_in: number; clip_out: number; tempo: number; tts_speed: number; dur: number;
  base_dur: number; pause_after: number; audio: string;
};
export type Plan = {
  lang: string; fps: number; total_frames: number; segments: Segment[]; beats: BeatRow[];
  anchors: { id: number; base: number; target: number; placed: number }[]; flags: Flag[]; audio_end: number;
};

/** A clip of the plan inputs, ready: its timing file and its length in seconds. */
export type Clip = { meta: ClipMeta; duration: number };

/** vt.build_plan. `clips` are the inputs' clips in beat order. */
export function buildPlan(inputs: PlanInputs, clips: Clip[]): Plan {
  const F: Fit = inputs.fit;
  const A = inputs.analysis;
  const S = inputs.script;
  const B = S.length;
  if (clips.length !== B || A.beats.length !== B) throw new Error("the recorded voice doesn't match the translation");
  const beats = S.map((b, i) => {
    const bt = beatTiming(b.text, clips[i].meta, clips[i].duration);
    return { ...bt, audio: inputs.clips[i].file, speed: inputs.clips[i].speed };
  });

  // which beat/token every marker is in (for anchors without a marker in the translation)
  const markLoc = new Map<number, [number, number]>();
  beats.forEach((bt, bi) => {
    for (const [mid, k] of bt.marks) markLoc.set(mid, [bi, k]);
  });

  const baseTokens = A.tokens;
  const tempo = new Array<number>(B).fill(1.0);
  const basePause = A.beats.map((b) => b.pause_after);
  const pause = basePause.map((p) => Math.max(F.pause_min, p - 0.14));
  pause[B - 1] = 0.0;
  const pauseHi = pause.map((p) => p + F.pause_max_extra);
  pauseHi[B - 1] = 0.0;
  const lead = Math.max(0.0, A.speech_start - 0.04);
  const vidDur = A.video.dur;
  const fps = A.video.fps;
  const baseTail = vidDur - A.speech_end;
  const anchors = A.anchors;
  const baseT = [0.0, ...anchors.map((an) => an.t), vidDur];
  const vmin = F.video_speed_min, vmax = F.video_speed_max, keep = F.trim_keep_min;
  const tol = F.sync_tolerance;

  const timeline = (): [number[], number] => {
    const O: number[] = [];
    let t = lead;
    beats.forEach((bt, i) => {
      O.push(t);
      t += (bt.clip_out - bt.clip_in) / tempo[i] + pause[i];
    });
    return [O, t];
  };
  const gtime = (O: number[], bi: number, local: number) => O[bi] + (local - beats[bi].clip_in) / tempo[bi];

  const targets = (O: number[], audioEnd: number) => {
    const first = gtime(O, 0, beats[0].tokens[0].start);
    const lastBeat = beats[B - 1];
    const last = gtime(O, B - 1, lastBeat.tokens[lastBeat.tokens.length - 1].end);
    const T: (number | null)[] = [0.0];
    const owner: (number | null)[] = [null];
    const missing: number[] = [];
    for (const an of anchors) {
      if (an.kind === "lead") {
        T.push(an.frac * first);
        owner.push(0);
      } else if (an.kind === "tail") {
        T.push(last + an.off);
        owner.push(B - 1);
      } else if (markLoc.has(an.id)) {
        const [bi, k] = markLoc.get(an.id)!;
        const tk = beats[bi].tokens[k];
        const s = gtime(O, bi, tk.start), e = gtime(O, bi, tk.end);
        if (an.kind === "in") {
          T.push(s + an.frac * (e - s));
        } else {
          let pe: number;
          if (k > 0) pe = gtime(O, bi, beats[bi].tokens[k - 1].end);
          else if (bi > 0) pe = gtime(O, bi - 1, beats[bi - 1].tokens[beats[bi - 1].tokens.length - 1].end);
          else pe = lead;
          T.push(pe + an.frac * (s - pe));
        }
        owner.push(bi);
      } else {
        T.push(null);
        owner.push(baseTokens[an.token].beat);
        missing.push(an.id);
      }
    }
    T.push(audioEnd + baseTail);
    owner.push(B - 1);
    // anchors whose marker was dropped: interpolate on base time
    for (let j = 0; j < T.length; j++) {
      if (T[j] !== null) continue;
      let p = j - 1;
      while (T[p] === null) p--;
      let n = j + 1;
      while (T[n] === null) n++;
      T[j] = T[p]! + ((T[n]! - T[p]!) * (baseT[j] - baseT[p])) / Math.max(1e-6, baseT[n] - baseT[p]);
    }
    return { T: T as number[], owner, missing };
  };

  const segLo = baseT.slice(0, -1).map((t, j) => ((baseT[j + 1] - t) * keep) / vmax);
  const segHi = baseT.slice(0, -1).map((t, j) => (baseT[j + 1] - t) / vmin);

  /** Place every cut C[j] within +-tol of its word T[j], honouring each clip's min/max length. */
  const solve = (T: number[]): [number[], [number, number][]] => {
    const n = baseT.length;
    const R: [number, number][] = [[0.0, 0.0]];
    const conflicts: [number, number][] = [];
    for (let j = 1; j < n; j++) {
      const a = R[j - 1][0] + segLo[j - 1], b = R[j - 1][1] + segHi[j - 1];
      const w = j < n - 1 ? tol : 30.0; // the video end is free: it holds/trims the last clip
      let lo = Math.max(a, T[j] - w), hi = Math.min(b, T[j] + w);
      if (lo > hi + 1e-9) {
        conflicts.push([j, b < T[j] - w ? -1 : 1]);
        lo = hi = b < T[j] - w ? b : a;
      }
      R.push([lo, hi]);
    }
    const C = new Array<number>(n).fill(0.0);
    C[n - 1] = Math.min(R[n - 1][1], Math.max(R[n - 1][0], T[n - 1]));
    for (let j = n - 2; j > 0; j--) {
      let lo = Math.max(R[j][0], C[j + 1] - segHi[j]);
      let hi = Math.min(R[j][1], C[j + 1] - segLo[j]);
      if (lo > hi) [lo, hi] = R[j];
      C[j] = Math.min(hi, Math.max(lo, T[j]));
    }
    return [C, conflicts];
  };

  const state = () => {
    const [O, audioEnd] = timeline();
    const { T, owner, missing } = targets(O, audioEnd);
    for (let j = 1; j < T.length; j++) T[j] = Math.max(T[j], T[j - 1] + 1.0 / fps); // keep targets increasing
    return { O, audioEnd, T, owner, missing };
  };

  // Only touch the voice where a cut can't be placed, and only in the beats around that cut.
  const unresolved = new Set<number>();
  for (let iter = 0; iter < 3000; iter++) {
    const { T, owner } = state();
    const [, conflicts] = solve(T);
    const todo = conflicts.filter((c) => !unresolved.has(c[0]));
    if (!todo.length) break;
    const [j, sign] = todo[0];
    let changed = false;
    for (const back of [1, 2, 3]) { // widen the window a little if the nearest beats are maxed out
      const o = owner[Math.max(0, j - back)];
      const blo = o !== null ? o : 0;
      const bhi = owner[j]!;
      const cand: ["pause" | "tempo", number][] = [];
      const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
      if (sign < 0) { // voice too long for the footage -> tighten
        for (const i of range(blo, bhi)) if (pause[i] > F.pause_min + 1e-6) cand.push(["pause", i]);
        cand.push(...range(blo, bhi + 1).filter((i) => tempo[i] < F.audio_tempo_max - 1e-6)
          .sort((x, y) => tempo[x] - tempo[y]).map((i): ["tempo", number] => ["tempo", i]));
      } else { // footage too long even after trimming -> loosen
        for (const i of range(blo, bhi)) if (pause[i] < pauseHi[i] - 1e-6) cand.push(["pause", i]);
        cand.push(...range(blo, bhi + 1).filter((i) => tempo[i] > F.audio_tempo_min + 1e-6)
          .sort((x, y) => tempo[y] - tempo[x]).map((i): ["tempo", number] => ["tempo", i]));
      }
      if (cand.length) {
        const [kind, i] = cand[0];
        if (kind === "pause") pause[i] = sign < 0 ? Math.max(F.pause_min, pause[i] - 0.02) : Math.min(pauseHi[i], pause[i] + 0.02);
        else tempo[i] = sign < 0 ? Math.min(F.audio_tempo_max, tempo[i] + 0.005) : Math.max(F.audio_tempo_min, tempo[i] - 0.005);
        changed = true;
        break;
      }
    }
    if (!changed) unresolved.add(j);
  }

  const { O, audioEnd, T, owner, missing } = state();
  const [C] = solve(T);
  const Cf = C.map((c) => pyRound(c * fps));
  for (let j = 1; j < Cf.length; j++) Cf[j] = Math.max(Cf[j], Cf[j - 1] + 1);
  const totalFrames = Math.max(Cf[Cf.length - 1], pyRound((audioEnd + Math.min(0.15, baseTail)) * fps));
  const hold = (totalFrames - Cf[Cf.length - 1]) / fps; // last frame held because the voice runs past the footage
  Cf[Cf.length - 1] = totalFrames;

  const segments: Segment[] = [];
  for (let j = 0; j < baseT.length - 1; j++) {
    const L = baseT[j + 1] - baseT[j];
    const out = (Cf[j + 1] - Cf[j]) / fps;
    const v = Math.min(vmax, Math.max(vmin, L / out));
    const src = Math.min(L, out * v);
    segments.push({ seg: j, src_start: baseT[j], src_len: src, base_len: L, frames: Cf[j + 1] - Cf[j],
                    out_start: Cf[j] / fps, speed: v, trimmed: Math.max(0.0, L - src) });
  }

  const f2 = (x: number) => pyFormat(x, 2);
  const f1 = (x: number) => pyFormat(x, 1);
  const flags: Flag[] = [];
  for (let j = 1; j < T.length - 1; j++) {
    const err = Cf[j] / fps - T[j];
    if (Math.abs(err) > tol + 0.5 / fps) {
      const bi = owner[j]!;
      const cut = anchors[j - 1].id, beat = S[bi].id, at = f1(Cf[j] / fps);
      flags.push(err < 0
        ? { cut, beat, error: err,
            msg: `cut ${cut} (at ${at}s) lands ${f2(-err)}s before its word: beat ${beat} (or the beats before it) ` +
                 `is ~${f2(-err - tol + 0.05)}s too long - shorten the text or raise its speed` }
        : { cut, beat, error: err,
            msg: `cut ${cut} (at ${at}s) lands ${f2(err)}s after its word: beat ${beat} is ~${f2(err - tol + 0.05)}s ` +
                 `too short - lengthen the text or lower its speed` });
    }
  }
  const lastId = S[B - 1].id;
  if (hold > 0.3) {
    flags.push({ cut: null, beat: lastId, error: -hold,
                 msg: `the voice runs ${f2(hold)}s past the last clip (last frame is held) - shorten beat ${lastId} or raise its speed` });
  }
  for (const mid of missing) {
    flags.push({ cut: mid, beat: null, error: 0.0, msg: `marker {${mid}} is missing in the translation - cut placed by interpolation` });
  }

  const beatRows: BeatRow[] = S.map((b, i) => {
    const bt = beats[i];
    return { beat: b.id, offset: O[i], clip_in: bt.clip_in, clip_out: bt.clip_out, tempo: tempo[i], tts_speed: bt.speed,
             dur: (bt.clip_out - bt.clip_in) / tempo[i], base_dur: A.beats[i].dur, pause_after: pause[i], audio: bt.audio };
  });
  return {
    lang: inputs.lang, fps, total_frames: totalFrames, segments, beats: beatRows,
    anchors: anchors.map((an, j) => ({ id: an.id, base: an.t, target: T[j + 1], placed: Cf[j + 1] / fps })),
    flags, audio_end: audioEnd,
  };
}

/** plan.json as storage keeps it (vt.portable_plan, format 1): what the browser renders from. */
export type PortablePlan = Omit<Plan, "beats"> & RenderPlan & { beats: BeatRow[] };

export function portablePlan(plan: Plan, source: { width: number; height: number }): PortablePlan {
  return {
    ...plan, format: PLAN_FORMAT, beats: plan.beats.map((b) => ({ ...b, audio: b.audio.split("/").pop()! })),
    source: { width: source.width, height: source.height },
    voice: { file: "voice.wav", sample_rate: SAMPLE_RATE, channels: CHANNELS },
  };
}

/** vt.write_report: the plan in words (kept on the job's row as `report`). */
export function writeReport(name: string, plan: Pick<Plan, "lang" | "fps" | "total_frames" | "segments" | "beats" | "anchors" | "flags">) {
  const total = plan.total_frames / plan.fps;
  const L = [`# ${name} - ${plan.lang.toUpperCase()}`, "",
    `Length: ${pyFormat(total, 2)}s (base ${pyFormat(plan.segments.reduce((s, x) => s + x.base_len, 0), 2)}s)`, ""];
  if (plan.flags.length) L.push("## Needs attention", "", ...plan.flags.map((f) => `- ${f.msg}`), "");
  else L.push("All cuts land on their words within tolerance.", "");
  L.push("## Voiceover beats", "", "| beat | base s | new s | TTS speed | tempo | pause after |", "|---|---|---|---|---|---|");
  for (const b of plan.beats) {
    L.push(`| ${b.beat} | ${pyFormat(b.base_dur, 2)} | ${pyFormat(b.dur, 2)} | ${pyFormat(b.tts_speed, 2)} | ` +
           `${pyFormat(b.tempo, 3)} | ${pyFormat(b.pause_after, 2)} |`);
  }
  L.push("", "## Clips", "", "| clip | source in | base s | new s | speed | trimmed s | cut error s |", "|---|---|---|---|---|---|---|");
  for (const s of plan.segments) {
    const an = s.seg < plan.anchors.length ? plan.anchors[s.seg] : null;
    const err = an ? pyFormat(an.placed - an.target, 2, true) : "";
    L.push(`| ${s.seg + 1} | ${pyFormat(s.src_start, 2)} | ${pyFormat(s.base_len, 2)} | ${pyFormat(s.frames / plan.fps, 2)} | ` +
           `${pyFormat(s.speed, 2)} | ${pyFormat(s.trimmed, 2)} | ${err} |`);
  }
  return L.join("\n") + "\n";
}
