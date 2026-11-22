import { NextResponse, type NextRequest } from "next/server";
import { fail } from "@/lib/api";
import { checkAnthropicKey, checkElevenLabs, KeyError } from "@/lib/check-keys";
import { LANGS } from "@/lib/jobs";
import { hint, myKeys, seal } from "@/lib/secrets";
import { toStatus } from "@/lib/setup";
import { getUser } from "@/lib/supabase/server";

const VOICE = /^[A-Za-z0-9]{10,40}$/;

// POST /api/settings  {elevenlabs_key?, anthropic_key?, voice_id?, voice_ids?}
// Saves the person's API keys (checked, then encrypted) and voice. For each key: missing = keep the saved one,
// "" = remove it. voice_id / voice_ids, when given, replace what's saved ("" / {} clears them).
// -> {status, notes}: what's saved now (keys only as their last characters), and anything worth telling.
export async function POST(request: NextRequest) {
  const { supabase, user } = await getUser();
  if (!user) return fail(401, "sign in first");

  const body = await request.json().catch(() => null);
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
  const eleven = str(body?.elevenlabs_key);
  const claude = str(body?.anthropic_key);
  const voiceGiven = body && "voice_id" in body;
  const voiceId = voiceGiven ? (str(body.voice_id) ?? "") : undefined;
  const voiceIds: Record<string, string> = {};
  if (body?.voice_ids && typeof body.voice_ids === "object") {
    for (const [lang, v] of Object.entries(body.voice_ids as Record<string, unknown>)) {
      const id = str(v);
      if (!id) continue;
      if (!(lang in LANGS)) return fail(400, `unknown language "${lang}"`);
      if (!VOICE.test(id)) return fail(400, `the ${LANGS[lang]} voice ID doesn't look right (letters and digits only)`);
      voiceIds[lang] = id;
    }
  }
  if (voiceId && !VOICE.test(voiceId)) return fail(400, "that voice ID doesn't look right: copy it from the voice's page in ElevenLabs");
  if (eleven !== undefined && eleven !== "" && eleven.length < 20) return fail(400, "that ElevenLabs key looks too short");
  if (claude !== undefined && claude !== "" && !claude.startsWith("sk-ant-")) return fail(400, "a Claude API key starts with sk-ant-");

  const notes: string[] = [];
  try {
    if (claude) await checkAnthropicKey(claude);
    // The voice is checked with the key it will be used with: the new one, else the saved one.
    const savedEleven = eleven === undefined ? (await myKeys(supabase, user.id)).elevenlabs : null;
    const elevenToUse = eleven || savedEleven;
    if (elevenToUse && (eleven || voiceId)) {
      const r = await checkElevenLabs(elevenToUse, voiceId || null);
      if (r.note) notes.push(r.note);
      if (r.voiceName) notes.push(`Voice: ${r.voiceName}.`);
    }

    if (eleven !== undefined || claude !== undefined) {
      const { error } = await supabase.rpc("set_my_keys", {
        p_elevenlabs_key: eleven === undefined ? null : eleven && seal(eleven, user.id, "elevenlabs"),
        p_elevenlabs_hint: eleven ? hint(eleven) : null,
        p_anthropic_key: claude === undefined ? null : claude && seal(claude, user.id, "anthropic"),
        p_anthropic_hint: claude ? hint(claude) : null,
      });
      if (error) return fail(500, error.message);
    }
    if (voiceGiven || body?.voice_ids) {
      const { error } = await supabase.rpc("set_my_voice", { p_voice_id: voiceId || null, p_voice_ids: voiceIds });
      if (error) return fail(400, error.message);
    }
  } catch (err) {
    if (err instanceof KeyError) return fail(400, err.message);
    return fail(500, (err as Error).message);
  }

  const { data } = await supabase.rpc("my_key_status");
  return NextResponse.json({ status: toStatus(data), notes });
}
