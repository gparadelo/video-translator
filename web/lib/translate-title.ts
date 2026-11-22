// Server only: uses ANTHROPIC_API_KEY. Called from /api/jobs/<id>/title.
import Anthropic from "@anthropic-ai/sdk";
import { LANGS, langName } from "@/lib/jobs";
import { cleanTitle, MAX_TITLE, NON_LATIN, shorten, toAscii } from "@/lib/titles";

// Same model the pipeline uses (config.default.toml -> [claude] model).
const MODEL = "claude-opus-5-5";
const CODES = Object.keys(LANGS);

const SYSTEM = `You translate short video titles (social media / YouTube product videos) into other languages.
Rules for every title you write:
- At most ${MAX_TITLE - 5} characters, counting spaces. Shorter is fine; rephrase naturally rather than cut words.
- Plain ASCII only: no accents or language-specific letters (write "cancion", not "canción"; "u" for "ü"; "ss" for "ß").
- Only letters, digits, spaces and the punctuation . , ! ? : - ' " ( ) & - no emoji, no other symbols.
- Keep brand and product names as they are.
- For languages written in a non-Latin script (${[...NON_LATIN].map(langName).join(", ")}), write a romanized Latin version
  using the usual system (Hepburn for Japanese, Revised Romanization for Korean, pinyin without tone marks for Chinese,
  common transliteration for the others).
- Keep the tone of the original. \`original\` is the original title itself, cleaned to the same rules.`;

export type Translated = { source: string; original: string; titles: Record<string, string> };

/** Thrown with a message that can be shown to the person as is. */
export class TitleError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function schema(codes: string[], first: boolean) {
  const titles = {
    type: "object",
    properties: Object.fromEntries(codes.map((c) => [c, { type: "string", description: langName(c) }])),
    required: codes,
    additionalProperties: false,
  };
  const properties: Record<string, unknown> = { titles };
  if (first) Object.assign(properties, { source: { type: "string", enum: CODES }, original: { type: "string" } });
  return { type: "object" as const, properties, required: Object.keys(properties), additionalProperties: false };
}

async function ask(client: Anthropic, prompt: string, codes: string[], first: boolean) {
  const r = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "low", format: { type: "json_schema", schema: schema(codes, first) } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  if (r.stop_reason === "refusal") throw new TitleError(422, "Claude declined to translate this title");
  const text = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  try {
    return JSON.parse(text) as { source?: string; original?: string; titles?: Record<string, string> };
  } catch {
    throw new TitleError(502, "Claude's answer was cut off - try again");
  }
}

/**
 * The title in each of `targets` (2-letter codes), every one plain ASCII and at most 60 characters.
 * `given` is the title's language, or null to detect it. The title's own language is never in `titles`.
 */
export async function translateTitle(title: string, given: string | null, targets: string[]): Promise<Translated> {
  if (!process.env.ANTHROPIC_API_KEY) throw new TitleError(500, "ANTHROPIC_API_KEY is not set on the server");
  const codes = [...new Set(targets.filter((c) => c in LANGS && c !== given))];
  const client = new Anthropic();
  try {
    const first = await ask(
      client,
      `Title: ${JSON.stringify(title)}\n` +
        (given ? `It is in ${langName(given)} (${given}); give that code as \`source\`.` : "Detect its language and give its code as `source`.") +
        (codes.length ? `\nWrite it in each of these languages: ${codes.map((c) => `${c} (${langName(c)})`).join(", ")}.` : ""),
      codes,
      true,
    );
    const source = given ?? (first.source && first.source in LANGS ? first.source : "en");
    const wanted = codes.filter((c) => c !== source);
    const titles: Record<string, string> = {};
    for (const c of wanted) titles[c] = toAscii(first.titles?.[c] ?? "");

    // Any title that is too long or came back empty (e.g. not romanized) gets one more try.
    const redo = wanted.filter((c) => !titles[c] || titles[c].length > MAX_TITLE);
    if (redo.length) {
      const notes = redo.map((c) => `${c}: ${JSON.stringify(titles[c])} (${titles[c].length} characters)`).join("\n");
      const second = await ask(
        client,
        `Title: ${JSON.stringify(title)} (${langName(source)})\nThese translations broke the rules ` +
          `(over ${MAX_TITLE} characters, or empty because they weren't in plain Latin letters):\n${notes}\n` +
          `Write them again, each at most ${MAX_TITLE - 10} characters, in plain ASCII.`,
        redo,
        false,
      ).catch(() => null);
      for (const c of redo) {
        const again = toAscii(second?.titles?.[c] ?? "");
        if (again) titles[c] = again;
      }
    }
    for (const c of wanted) titles[c] = shorten(titles[c]);
    return { source, original: cleanTitle(first.original ?? "") || cleanTitle(title), titles };
  } catch (err) {
    if (err instanceof TitleError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new TitleError(500, "the server's ANTHROPIC_API_KEY was rejected");
    if (err instanceof Anthropic.RateLimitError) throw new TitleError(429, "too many requests to Claude - wait a moment");
    if (err instanceof Anthropic.APIError) throw new TitleError(502, `Claude API error: ${err.message}`);
    throw err;
  }
}
