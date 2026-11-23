// Server only. Each person's API keys, encrypted before they reach the database and decrypted only here, with
// SECRETS_KEY: 32 random bytes, base64 (`openssl rand -base64 32`). Changing it makes every saved key unreadable;
// people then save theirs again.
//
// Format: "v1:" + base64(iv (12 bytes) | ciphertext | tag (16 bytes)), AES-256-GCM. The person's id and the
// key's name are bound in as associated data, so an encrypted key copied onto someone else's row won't open.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export type KeyName = "elevenlabs" | "anthropic";

function masterKey() {
  const key = Buffer.from(process.env.SECRETS_KEY ?? "", "base64");
  if (key.length !== 32) throw new Error("SECRETS_KEY is not set on the server (32 bytes, base64)");
  return key;
}

export function seal(plain: string, userId: string, name: KeyName): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey(), iv);
  c.setAAD(Buffer.from(`${userId}:${name}`));
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, body, c.getAuthTag()]).toString("base64");
}

export function unseal(sealed: string, userId: string, name: KeyName): string {
  if (!sealed.startsWith("v1:")) throw new Error("unknown key format");
  const raw = Buffer.from(sealed.slice(3), "base64");
  const d = createDecipheriv("aes-256-gcm", masterKey(), raw.subarray(0, 12));
  d.setAAD(Buffer.from(`${userId}:${name}`));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8");
}

/**
 * The signed-in person's saved keys, decrypted (null where none is saved). Throws when SECRETS_KEY is
 * missing, or when a saved key can't be opened (wrong SECRETS_KEY, or a key saved some other way).
 */
export async function myKeys(supabase: SupabaseClient, userId: string): Promise<Record<KeyName, string | null>> {
  masterKey(); // a server setup problem, not the person's: let it say so
  const { data: rows, error } = await supabase.rpc("my_keys");
  if (error) throw new Error(`couldn't read your saved keys: ${error.message}`);
  const data = (rows as { elevenlabs_key: string | null; anthropic_key: string | null }[] | null)?.[0];
  const open = (sealed: string | null | undefined, name: KeyName) => {
    if (!sealed) return null;
    try {
      return unseal(sealed, userId, name);
    } catch {
      throw new UnreadableKey(name);
    }
  };
  return { elevenlabs: open(data?.elevenlabs_key, "elevenlabs"), anthropic: open(data?.anthropic_key, "anthropic") };
}

/** A saved key that can't be opened: the person should save it again in Settings. */
export class UnreadableKey extends Error {
  constructor(public key: KeyName) {
    super(`your saved ${key === "elevenlabs" ? "ElevenLabs" : "Claude"} API key can't be read - save it again in Settings`);
  }
}

/** Last 4 characters, shown in Settings as "•••• abcd". */
export const hint = (key: string) => key.slice(-4);
