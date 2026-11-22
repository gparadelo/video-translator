// Server only: checks a key works before it's saved, so a typo shows up in Settings and not halfway
// through a video. Neither check costs anything.
import Anthropic from "@anthropic-ai/sdk";

/** Thrown with a message that can be shown to the person as is. */
export class KeyError extends Error {}

export async function checkAnthropicKey(apiKey: string) {
  try {
    await new Anthropic({ apiKey }).models.list({ limit: 1 });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new KeyError("the Claude API rejected that key - check it and paste it again");
    if (err instanceof Anthropic.PermissionDeniedError) throw new KeyError("that Claude API key isn't allowed to use the API");
    if (err instanceof Anthropic.APIError) throw new KeyError(`couldn't check the Claude key: ${err.message}`);
    throw new KeyError("couldn't reach the Claude API to check the key - try again");
  }
}

/**
 * Checks an ElevenLabs key, and the voice with it. Returns the voice's name, or null with a note when the
 * key works but isn't allowed to look up voices (that permission is optional: rendering doesn't need it).
 */
export async function checkElevenLabs(apiKey: string, voiceId: string | null): Promise<{ voiceName: string | null; note?: string }> {
  // Without a voice yet, ask for one that can't exist: an invalid key answers 401, a valid one 400/404.
  const id = voiceId ?? "0000000000";
  let r: Response;
  try {
    r = await fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(id)}`, { headers: { "xi-api-key": apiKey } });
  } catch {
    throw new KeyError("couldn't reach ElevenLabs to check the key - try again");
  }
  const text = await r.text();
  if (r.ok) {
    const name = (JSON.parse(text) as { name?: string }).name ?? null;
    return { voiceName: voiceId ? name : null };
  }
  const lower = text.toLowerCase();
  if ((r.status === 401 || r.status === 403) && (lower.includes("permission") || lower.includes("scope"))) {
    return { voiceName: null, note: "Saved. The key can't look up voices (that permission is optional), so the voice ID wasn't checked." };
  }
  if (r.status === 401) throw new KeyError("ElevenLabs rejected that API key - check it and paste it again");
  if (r.status === 400 || r.status === 404 || r.status === 422) {
    if (voiceId) throw new KeyError("ElevenLabs has no voice with that ID in this account - copy it again from the voice's page");
    return { voiceName: null };
  }
  throw new KeyError(`couldn't check the ElevenLabs key (${r.status})`);
}
