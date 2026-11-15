"use client";

import { useState } from "react";
import { COMMON_LANGS, LANGS, langName } from "@/lib/jobs";

/** Checkable language chips. `exclude` is the video's own language. */
export function LanguagePicker({
  value,
  onChange,
  exclude,
}: {
  value: string[];
  onChange: (langs: string[]) => void;
  exclude?: string | null;
}) {
  const [all, setAll] = useState(false);
  const shown = (all ? Object.keys(LANGS) : [...new Set([...COMMON_LANGS, ...value])]).filter((l) => l !== exclude);
  const toggle = (l: string) => onChange(value.includes(l) ? value.filter((x) => x !== l) : [...value, l]);

  return (
    <div className="flex flex-wrap gap-2">
      {shown.map((l) => (
        <label
          key={l}
          className={`cursor-pointer rounded-full border px-3 py-1 text-sm select-none ${
            value.includes(l)
              ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
              : "border-neutral-300 dark:border-neutral-700"
          }`}
        >
          <input type="checkbox" className="sr-only" checked={value.includes(l)} onChange={() => toggle(l)} />
          {langName(l)}
        </label>
      ))}
      {!all && (
        <button type="button" onClick={() => setAll(true)} className="px-2 text-sm text-neutral-500 underline">
          More languages
        </button>
      )}
    </div>
  );
}
