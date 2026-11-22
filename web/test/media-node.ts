// lib/prepare/probe.ts on a file in Node (Mediabunny reads files from disk too), for the tests.

import { ALL_FORMATS, FilePathSource, Input } from "mediabunny";
import { readFacts } from "../lib/prepare/probe";

export async function factsOf(path: string) {
  const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS });
  try {
    return await readFacts(input);
  } finally {
    input.dispose();
  }
}

/** Every frame's time in seconds from the start of the file, in presentation order, as ffmpeg's filters see it. */
export async function frameTimes(path: string): Promise<number[]> {
  const f = await factsOf(path);
  return f.video!.ticks.map((t) => t / f.video!.timescale - f.start);
}
