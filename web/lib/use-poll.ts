"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Load something now and again every `ms`. Returns the latest value and a function to reload at once. */
export function usePoll<T>(load: () => Promise<T>, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });

  const refresh = useCallback(async () => {
    try {
      setData(await loader.current());
    } catch {
      // keep what we have; the next tick tries again
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const timer = setInterval(refresh, ms);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh, ms]);

  return [data, refresh] as const;
}
