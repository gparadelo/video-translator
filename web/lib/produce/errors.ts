// What a produce step tells the job page when it can't go on. Safe to use in the browser.
//
//   retry: worth trying again in a moment (ElevenLabs or Claude busy, a dropped connection); `after` = seconds
//          the service asked us to wait
//   code "stale": the run moved on under this request (another tab, an older answer): start again from where the
//          run is now; "gone": the run is over (canceled, started again): stop and show what's there
//   otherwise the person has to do something (a key, credits): the language fails with this message.

export type ErrorCode = "stale" | "gone";

export class ProduceError extends Error {
  status: number;
  retry: boolean;
  after?: number;
  code?: ErrorCode;
  constructor(message: string, opts: { status?: number; retry?: boolean; after?: number; code?: ErrorCode } = {}) {
    super(message);
    this.name = "ProduceError";
    this.status = opts.status ?? (opts.retry ? 503 : 422);
    this.retry = opts.retry ?? false;
    this.after = opts.after;
    this.code = opts.code;
  }
  toJSON() {
    return { error: this.message, retry: this.retry || undefined, after: this.after, code: this.code };
  }
}

/** Seconds from a Retry-After header (seconds or a date), within reason. */
export function retryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const s = Number(header);
  const secs = Number.isFinite(s) ? s : (Date.parse(header) - Date.now()) / 1000;
  return Number.isFinite(secs) && secs > 0 ? Math.min(120, Math.ceil(secs)) : undefined;
}
