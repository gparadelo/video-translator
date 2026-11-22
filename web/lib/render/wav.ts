// Reads the voice track (16-bit PCM WAV, as vt.build_voice_track writes it).

export type Pcm = { sampleRate: number; channels: number; frames: number; data: Int16Array };

export function parseWav(buf: ArrayBuffer): Pcm {
  const v = new DataView(buf);
  const tag = (at: number) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
  if (buf.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("the voice track is not a WAV file");
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let at = 12;
  while (at + 8 <= buf.byteLength) {
    const id = tag(at);
    const size = v.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      fmt = { format: v.getUint16(body, true), channels: v.getUint16(body + 2, true), sampleRate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID
      if (fmt.format === 0xfffe && size >= 26) fmt.format = v.getUint16(body + 24, true);
    } else if (id === "data") {
      if (!fmt) throw new Error("the voice track has no format header");
      if (fmt.format !== 1 || fmt.bits !== 16) throw new Error("the voice track must be 16-bit PCM");
      const bytes = Math.min(size, buf.byteLength - body) & ~1;
      // copy, so the samples are aligned whatever the header size was
      const data = new Int16Array(buf.slice(body, body + bytes));
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, frames: Math.floor(data.length / fmt.channels), data };
    }
    at = body + size + (size % 2);
  }
  throw new Error("the voice track has no audio");
}
