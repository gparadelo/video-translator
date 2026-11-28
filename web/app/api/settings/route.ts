import { NextResponse, type NextRequest } from "next/server";
import { fail } from "@/lib/api";
import { checkAnthropicKey, checkElevenLabs, KeyError } from "@/lib/check-keys";
import { LANGS } from "@/lib/jobs";
import { hint, myKeys, seal, UnreadableKey } from "@/lib/secrets";
import { toStatus } from "@/lib/setup";
import { getUser } from "@/lib/supabase/server";

const VOICE = /^[A-Za-z0-9]{10,40}$/;

// POST /api/settings  {elevenlabs_key?, anthropic_key?, voice_id?, voice_ids?, languages?}
// Saves the person's API keys (checked, then encrypted), voice, and default languages (what a new project starts
// with). Each field: missing = keep what's saved,
// "" (or {} for voice_ids) = remove it, anything else = replace it.
// -> {status, notes}: what's saved now (keys only as their last characters), and anything worth telling.
export async function POST(request: NextRequest) {
  const { supabase, user } = await getUser();
  if (!user) return fail(401, "sign in first");

  const raw: unknown = await request.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(400, "send the settings as a JSON object");
  const body = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
  const eleven = str(body.elevenlabs_key);
  const claude = str(body.anthropic_key);
  const voiceId = str(body.voice_id);

  let voiceIds: Record<string, string> | undefined;
  if (body.voice_ids && typeof body.voice_ids === "object") {
    voiceIds = {};
    for (const [lang, v] of Object.entries(body.voice_ids as Record<string, unknown>)) {
      const id = str(v);
      if (!id) continue;
      if (!(lang in LANGS)) return fail(400, `unknown language "${lang}"`);
      if (!VOICE.test(id)) return fail(400, `the ${LANGS[lang]} voice ID doesn't look right (letters and digits only)`);
      voiceIds[lang] = id;
    }
  }
  let languages: string[] | undefined;
  if (body.languages !== undefined) {
    if (!Array.isArray(body.languages)) return fail(400, "send the languages as a list");
    languages = [...new Set(body.languages.map(str).filter((l): l is string => Boolean(l)))];
    const unknown = languages.find((l) => !(l in LANGS));
    if (unknown) return fail(400, `unknown language "${unknown}"`);
  }
  if (voiceId && !VOICE.test(voiceId)) return fail(400, "that voice ID doesn't look right: copy it from the voice's page in ElevenLabs");
  if (eleven && eleven.length < 20) return fail(400, "that ElevenLabs key looks too short");
  if (claude && !claude.startsWith("sk-ant-")) return fail(400, "a Claude API key starts with sk-ant-");

  const saved = toStatus((await supabase.rpc("my_key_status")).data);
  const notes: string[] = [];
  try {
    // Check everything before saving anything.
    if (claude) await checkAnthropicKey(claude);
    // The ElevenLabs key and voice are checked only when one of them changes, with the key they'll be used with.
    const voiceChanged = Boolean(voiceId) && voiceId !== saved?.voice_id;
    if (eleven || voiceChanged) {
      const key = eleven || (await myKeys(supabase, user.id)).elevenlabs;
      if (key) {
        const r = await checkElevenLabs(key, voiceId || saved?.voice_id || null);
        if (r.note) notes.push(r.note);
        if (r.voiceName) notes.push(`Voice: ${r.voiceName}.`);
      }
    }

    if (voiceId !== undefined || voiceIds !== undefined) {
      const { error } = await supabase.rpc("set_my_voice", { p_voice_id: voiceId ?? null, p_voice_ids: voiceIds ?? null });
      if (error) return fail(400, error.message);
    }
    if (languages !== undefined) {
      const { error } = await supabase.rpc("set_my_languages", { p_languages: languages });
      if (error) return fail(400, error.message);
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
  } catch (err) {
    if (err instanceof KeyError || err instanceof UnreadableKey) return fail(400, err.message);
    return fail(500, (err as Error).message);
  }

  const { data } = await supabase.rpc("my_key_status");
  return NextResponse.json({ status: toStatus(data), notes });
}
