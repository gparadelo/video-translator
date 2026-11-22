"use client";

// While a video renders in this tab: keep the screen on, warn before the tab is closed, and remember that a
// render was running, so after a crash or reload the page can say it stopped (rather than look as if
// nothing happened). Nothing half-made is ever recorded: the preview is only saved after its upload
// is checked, and a download only becomes a file when it's complete.

import { useEffect } from "react";

type WakeLockSentinel = { release(): Promise<void> };
type WakeLockNavigator = Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinel> } };

export function useRenderGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let lock: WakeLockSentinel | null = null;
    let stopped = false;
    const acquire = async () => {
      try {
        const l = await (navigator as WakeLockNavigator).wakeLock?.request("screen");
        if (stopped) l?.release();
        else lock = l ?? null;
      } catch {
        // not allowed (e.g. battery saver): the render still works while the tab stays open
      }
    };
    // the browser drops the lock when the tab is hidden; take it again when it's back
    const onVisible = () => document.visibilityState === "visible" && acquire();
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // older browsers need this to ask
    };
    acquire();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      stopped = true;
      lock?.release().catch(() => {});
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [active]);
}

export type Running = { kind: "preview" | "download"; startedAt: number; fraction: number };

const key = (jobId: string, lang: string) => `vt-render:${jobId}:${lang}`;

/** A render of this language that was running in a tab that's gone (closed, reloaded, crashed). */
export function interruptedRender(jobId: string, lang: string): Running | null {
  try {
    const raw = localStorage.getItem(key(jobId, lang));
    return raw ? (JSON.parse(raw) as Running) : null;
  } catch {
    return null;
  }
}

export function saveRunning(jobId: string, lang: string, r: Running | null) {
  try {
    if (r) localStorage.setItem(key(jobId, lang), JSON.stringify(r));
    else localStorage.removeItem(key(jobId, lang));
  } catch {
    // private mode / storage blocked: only the "it stopped" note is lost
  }
}
