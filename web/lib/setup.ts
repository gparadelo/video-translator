// What a person has set up in Settings (no keys here: only their last characters), and what each kind
// of project needs. Safe to use in the browser.

export type SetupStatus = {
  elevenlabs_hint: string | null;
  anthropic_hint: string | null;
  voice_id: string | null;
  voice_ids: Record<string, string>;
};

/** What's still missing for a project with a video and/or a title, as short phrases ("your Claude API key"). */
export function missingFor(s: SetupStatus | null, { video, title }: { video: boolean; title: boolean }): string[] {
  if (!s) return [];
  const missing: string[] = [];
  if (video && !s.elevenlabs_hint) missing.push("your ElevenLabs API key");
  if ((video || title) && !s.anthropic_hint) missing.push("your Claude API key");
  if (video && !s.voice_id) missing.push("your ElevenLabs voice");
  return missing;
}

export const listOf = (items: string[]) =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** The status row from the database (my_key_status), or null if it couldn't be read. */
export function toStatus(rows: unknown): SetupStatus | null {
  const r = (rows as Partial<SetupStatus>[] | null)?.[0];
  if (!r) return null;
  return {
    elevenlabs_hint: r.elevenlabs_hint ?? null,
    anthropic_hint: r.anthropic_hint ?? null,
    voice_id: r.voice_id ?? null,
    voice_ids: r.voice_ids ?? {},
  };
}
