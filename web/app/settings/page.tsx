"use client";

import { useEffect, useState } from "react";
import { Page } from "@/components/Header";
import { Button, Card, Notice } from "@/components/ui";
import { api, langName } from "@/lib/jobs";
import { listOf, missingFor, toStatus, type SetupStatus } from "@/lib/setup";
import { createClient } from "@/lib/supabase/client";

const field = "rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-base font-normal dark:border-neutral-700";
const link = "underline underline-offset-2";

type Saved = { status: SetupStatus; notes: string[] };

// Settings: the person's own ElevenLabs and Claude API keys, and their voice. Their projects use these,
// so what they make is spoken in their voice and billed to their accounts. Saved keys never come back to
// the browser: only their last 4 characters, to tell which one is saved.
export default function Settings() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [languages, setLanguages] = useState<string[]>([]);
  const [eleven, setEleven] = useState("");
  const [claude, setClaude] = useState("");
  const [voice, setVoice] = useState("");
  const [perLang, setPerLang] = useState<Record<string, string>>({});
  const [showPerLang, setShowPerLang] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<string[]>([]);

  function show(s: SetupStatus | null) {
    setStatus(s);
    setVoice(s?.voice_id ?? "");
    setPerLang(s?.voice_ids ?? {});
    if (s && Object.keys(s.voice_ids).length) setShowPerLang(true);
  }

  useEffect(() => {
    const supabase = createClient();
    supabase.rpc("my_key_status").then(({ data }) => show(toStatus(data)));
    supabase
      .from("profiles")
      .select("languages")
      .maybeSingle()
      .then(({ data }) => setLanguages(data?.languages ?? []));
  }, []);

  async function save(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setNotes([]);
    try {
      const r = await api<Saved>("/api/settings", body);
      show(r.status);
      setEleven("");
      setClaude("");
      setNotes(r.notes.length ? r.notes : ["Saved."]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    save({
      ...(eleven.trim() && { elevenlabs_key: eleven }),
      ...(claude.trim() && { anthropic_key: claude }),
      voice_id: voice,
      voice_ids: showPerLang ? perLang : {},
    });
  }

  const missing = missingFor(status, { video: true, title: true });
  return (
    <Page>
      <h1 className="text-xl font-semibold">Settings</h1>
      <p className="-mt-3 text-sm text-neutral-500">
        Your projects use your own ElevenLabs and Claude accounts: the voice is yours, and so are the costs.
      </p>
      {status && missing.length > 0 && (
        <Notice tone="action">Add {listOf(missing)} to start translating videos.</Notice>
      )}

      <form onSubmit={submit} className="flex flex-col gap-5">
        <Card className="flex flex-col gap-4">
          <h2 className="font-medium">ElevenLabs</h2>
          <KeyField
            label="API key"
            value={eleven}
            onChange={setEleven}
            saved={status?.elevenlabs_hint ?? null}
            disabled={busy}
            onRemove={() => save({ elevenlabs_key: "" })}
            help={
              <>
                At{" "}
                <a className={link} href="https://elevenlabs.io/app/developers/api-keys" target="_blank" rel="noreferrer">
                  elevenlabs.io → Developers → API keys
                </a>
                , create a key with <b>Text to Speech</b>, <b>Speech to Text</b> and <b>Forced Alignment</b> allowed. Add{" "}
                <b>Voices: Read</b> too if you want the voice ID checked here.
              </>
            }
          />
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Voice ID
            <input
              value={voice}
              disabled={busy}
              onChange={(e) => setVoice(e.target.value.trim())}
              placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
              className={`${field} font-mono text-sm`}
            />
            <span className="text-xs font-normal text-neutral-500">
              In ElevenLabs, open <b>Voices</b>, pick your voice, and copy its ID. Every language is spoken in this voice.
            </span>
          </label>
          {showPerLang ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">
                A different voice for some languages <span className="font-normal text-neutral-500">(optional)</span>
              </p>
              {languages.map((l) => (
                <label key={l} className="flex items-center gap-3 text-sm">
                  <span className="w-24 shrink-0">{langName(l)}</span>
                  <input
                    value={perLang[l] ?? ""}
                    disabled={busy}
                    onChange={(e) => setPerLang({ ...perLang, [l]: e.target.value.trim() })}
                    placeholder="Same as above"
                    className={`${field} min-w-0 flex-1 font-mono text-sm`}
                  />
                </label>
              ))}
            </div>
          ) : (
            languages.length > 0 && (
              <button type="button" onClick={() => setShowPerLang(true)} className="self-start text-sm text-neutral-500 underline">
                Use a different voice for some languages
              </button>
            )
          )}
        </Card>

        <Card className="flex flex-col gap-4">
          <h2 className="font-medium">Claude</h2>
          <KeyField
            label="API key"
            value={claude}
            onChange={setClaude}
            saved={status?.anthropic_hint ?? null}
            disabled={busy}
            onRemove={() => save({ anthropic_key: "" })}
            help={
              <>
                At{" "}
                <a className={link} href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer">
                  platform.claude.com → API keys
                </a>
                , create a key. It translates the voiceover and the titles. The account needs credits.
              </>
            }
          />
        </Card>

        {error && <Notice tone="bad">{error}</Notice>}
        {notes.length > 0 && <Notice tone="idle">{notes.join(" ")}</Notice>}
        <Button type="submit" disabled={busy || !status} className="self-start">
          {busy ? "Checking and saving…" : "Save"}
        </Button>
      </form>
    </Page>
  );
}

function KeyField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  saved: string | null;
  disabled: boolean;
  onRemove: () => void;
  help: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      <span className="flex items-center gap-2">
        {props.label}
        {props.saved && (
          <span className="font-normal text-neutral-500">
            saved: <span className="font-mono">•••• {props.saved}</span> ·{" "}
            <button type="button" disabled={props.disabled} onClick={props.onRemove} className="underline">
              remove
            </button>
          </span>
        )}
      </span>
      <input
        type="password"
        autoComplete="off"
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.saved ? "Paste a new key to replace it" : "Paste your key"}
        className={`${field} font-mono text-sm`}
      />
      <span className="text-xs font-normal text-neutral-500">{props.help}</span>
    </label>
  );
}
