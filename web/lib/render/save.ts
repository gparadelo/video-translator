// Where a full-quality render is written: straight into a file the person picks (Chrome, Edge), or into
// the browser's private storage and then downloaded (other browsers). Either way the video goes to disk
// as it is made, never all into memory. Nothing is kept if the render fails.

import { BufferTarget, StreamTarget, type Target } from "mediabunny";

export type SaveTarget = {
  target: Target;
  /** Called right before the output is finalized: only then may the file be completed. */
  allowCommit(): void;
  /** After the output is finalized: hand the file to the person. */
  finish(): Promise<void>;
  /** The render failed or was stopped: throw away what was written. */
  discard(): Promise<void>;
};

type PickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle>;
};

const TEMP_PREFIX = "render-";

/**
 * Remove temporary files left in private storage by earlier renders: finished ones (kept until now so their
 * download could finish) and interrupted ones. A file another tab is still writing is locked and stays.
 */
export async function cleanUpTemporaryFiles() {
  try {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    for (const name of names) if (name.startsWith(TEMP_PREFIX)) await root.removeEntry(name).catch(() => {});
  } catch {
    // no private storage in this browser: nothing to clean
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * The file's stream, except that closing it only completes the file after allowCommit(). Mediabunny also
 * closes its stream when a render is canceled; that must throw the partial file away, not save it.
 */
function guarded(writable: FileSystemWritableFileStream) {
  let commit = false;
  const stream = new WritableStream({
    write: (chunk) => writable.write(chunk),
    close: () => (commit ? writable.close() : writable.abort()),
    abort: (reason) => writable.abort(reason),
  });
  return { stream, allowCommit: () => void (commit = true), abort: () => writable.abort().catch(() => {}) };
}

/**
 * Ask where to save. Call it first thing in the click handler: the file picker only opens in response to a
 * click. Returns null when the person closes the picker.
 */
export async function chooseSaveTarget(filename: string): Promise<SaveTarget | null> {
  const w = window as PickerWindow;
  if (w.showSaveFilePicker) {
    let handle: FileSystemFileHandle;
    try {
      handle = await w.showSaveFilePicker({ suggestedName: filename, types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }] });
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return null;
      throw e;
    }
    // writes go to a temporary file; the chosen file only appears when the stream closes after allowCommit()
    const g = guarded(await handle.createWritable());
    return {
      target: new StreamTarget(g.stream, { chunked: true }),
      allowCommit: g.allowCommit,
      finish: async () => {},
      discard: g.abort,
    };
  }

  try {
    // first, so it can't touch the file this render writes
    await cleanUpTemporaryFiles();
    const root = await navigator.storage.getDirectory();
    const name = `${TEMP_PREFIX}${Date.now()}.mp4`;
    const handle = await root.getFileHandle(name, { create: true });
    const g = guarded(await handle.createWritable());
    return {
      target: new StreamTarget(g.stream, { chunked: true }),
      allowCommit: g.allowCommit,
      finish: async () => downloadBlob(await handle.getFile(), filename), // removed on the next render
      discard: async () => {
        await g.abort();
        await root.removeEntry(name).catch(() => {});
      },
    };
  } catch {
    // no private file storage: keep it in memory (fine for small videos)
    const target = new BufferTarget();
    return {
      target,
      allowCommit: () => {},
      finish: async () => {
        if (target.buffer) downloadBlob(new Blob([target.buffer], { type: "video/mp4" }), filename);
      },
      discard: async () => {},
    };
  }
}
