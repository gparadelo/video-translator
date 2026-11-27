"use client";

import { useEffect, useState } from "react";
import { Page } from "@/components/Header";
import { Button, Card, Notice, PageTitle } from "@/components/ui";
import { api, langName } from "@/lib/jobs";
import { listOf, missingFor, toStatus, type SetupStatus } from "@/lib/setup";
import { createClient } from "@/lib/supabase/client";

const field = "rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-base font-normal dark:border-neutral-700";
const link = "underline underline-offset-2";
// Affiliate link (disclosed next to it on the page).
const ELEVENLABS_SIGNUP = "https://try.elevenlabs.io/yn7pyf0ztfla";

type Saved = { status: SetupStatus; notes: string[] };

// Settings: the person's own ElevenLabs and Claude API keys, and their voice. Their projects use these,
// so what they make is spoken in the voice they chose and billed to their accounts. Saved keys never come back to
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
      <PageTitle sub="Your projects use your own ElevenLabs and Claude accounts: the voice is your pick, and the costs are yours.">
        Settings
      </PageTitle>
      {status && missing.length > 0 && (
        <Notice tone="action">Add {listOf(missing)} to start translating videos.</Notice>
      )}

      <form onSubmit={submit} className="flex flex-col gap-5">
        <Card className="flex flex-col gap-4">
          <h2 className="font-medium">ElevenLabs</h2>
          <Steps
            title="New to ElevenLabs? Set it up step by step"
            open={!!status && !status.elevenlabs_hint}
            footer={
              <>
                The sign-up link is an affiliate link: if you subscribe through it, the maker of Video Translator earns a
                commission, at no extra cost to you. You can also go straight to{" "}
                <a className={link} href="https://elevenlabs.io" target="_blank" rel="noreferrer">
                  elevenlabs.io
                </a>
                .
              </>
            }
          >
            <li>
              <a className={link} href={ELEVENLABS_SIGNUP} target="_blank" rel="noreferrer sponsored">
                Sign up for ElevenLabs
              </a>{" "}
              and choose a plan. Each plan comes with monthly credits, and every translated video uses some of them.
            </li>
            <li>
              Choose a voice: open <b>Voices</b>, pick one you like, and copy its <b>Voice ID</b>. Paste it below.
            </li>
            <li>
              Open{" "}
              <a className={link} href="https://elevenlabs.io/app/developers/api-keys" target="_blank" rel="noreferrer">
                Developers → API keys
              </a>
              , choose <b>Create key</b>, and allow <b>Text to Speech</b>, <b>Speech to Text</b> and{" "}
              <b>Forced Alignment</b> (plus <b>Voices: Read</b> so the voice ID can be checked here). Copy the key: it
              is shown only once. Paste it below.
            </li>
          </Steps>
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
              In ElevenLabs, open <b>Voices</b>, pick a voice, and copy its ID. Every language is spoken in this voice.
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
          <Steps title="New to the Claude API? Set it up step by step" open={!!status && !status.anthropic_hint}>
            <li>
              <a className={link} href="https://platform.claude.com" target="_blank" rel="noreferrer">
                Sign up at platform.claude.com
              </a>{" "}
              (the Claude Developer Platform).{" "}
              <b>
                A Claude.ai subscription (Free, Pro or Max) does not work here: the API is a separate account with its
                own billing.
              </b>{" "}
              Even if you already pay for Claude.ai, you need to add API credits in the next step.
            </li>
            <li>
              Add credits: open{" "}
              <a className={link} href="https://platform.claude.com/settings/billing" target="_blank" rel="noreferrer">
                Settings → Billing
              </a>{" "}
              and buy some prepaid credits. A few dollars goes a long way: translating a voiceover or a title costs
              cents. You can turn on auto-reload so it never runs out.
            </li>
            <li>
              Open{" "}
              <a className={link} href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer">
                Settings → API keys
              </a>
              , choose <b>Create key</b>, name it something like “Video Translator”, and copy it (it starts with{" "}
              <span className="font-mono">sk-ant-</span> and is shown only once). Paste it below.
            </li>
          </Steps>
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

/** Step-by-step sign-up instructions, open until that key is saved. */
function Steps(props: { title: string; open: boolean; footer?: React.ReactNode; children: React.ReactNode }) {
  return (
    <details open={props.open} className="rounded-xl border border-neutral-200/80 bg-neutral-50 px-4 py-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
      <summary className="cursor-pointer font-medium">{props.title}</summary>
      <ol className="mt-3 flex list-decimal flex-col gap-2 pl-5">{props.children}</ol>
      {props.footer && <p className="mt-3 text-xs text-neutral-500">{props.footer}</p>}
    </details>
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
