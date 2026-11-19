import Anthropic from "@anthropic-ai/sdk";
import { NextResponse, type NextRequest } from "next/server";
import { fail } from "@/lib/api";
import { LANGS, langName } from "@/lib/jobs";
import { getUser } from "@/lib/supabase/server";
import { cleanTitle, MAX_TITLE, NON_LATIN, shorten, toAscii } from "@/lib/titles";

export const maxDuration = 60;

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
- Keep the tone of the original. Return the original language too, cleaned to the same rules.`;

type Result = { source: string; titles: Record<string, string> };

function schema(codes: string[], withSource: boolean) {
  const titles = {
    type: "object",
    properties: Object.fromEntries(codes.map((c) => [c, { type: "string", description: langName(c) }])),
    required: codes,
    additionalProperties: false,
  };
  return {
    type: "object" as const,
    properties: withSource ? { source: { type: "string", enum: CODES }, titles } : { titles },
    required: withSource ? ["source", "titles"] : ["titles"],
    additionalProperties: false,
  };
}

async function ask(client: Anthropic, prompt: string, codes: string[], withSource: boolean) {
  const r = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "low", format: { type: "json_schema", schema: schema(codes, withSource) } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  if (r.stop_reason === "refusal") throw new Error("Claude declined to translate this title");
  const text = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  try {
    return JSON.parse(text) as Partial<Result>;
  } catch {
    throw new Error("Claude's answer was cut off - try again");
  }
}

// POST /api/titles  {title, source?: "auto" | "<code>"}
// -> {source, titles: {<code>: title}} for every language the app knows, each at most 60 plain ASCII characters.
export async function POST(request: NextRequest) {
  const { user } = await getUser();
  if (!user) return fail(401, "sign in first");
  if (!process.env.ANTHROPIC_API_KEY) return fail(500, "ANTHROPIC_API_KEY is not set on the server");

  const body = await request.json().catch(() => null);
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const given = typeof body?.source === "string" && body.source in LANGS ? body.source : null;
  if (!title) return fail(400, "type a title first");
  if (title.length > 300) return fail(400, "the title is too long (300 characters at most)");

  const client = new Anthropic();
  const list = CODES.map((c) => `${c} (${langName(c)})`).join(", ");
  try {
    const first = await ask(
      client,
      `Title: ${JSON.stringify(title)}\n` +
        (given ? `It is in ${langName(given)} (${given}).` : "Detect its language and give its code as `source`.") +
        `\nWrite it in each of these languages: ${list}.`,
      CODES,
      !given,
    );
    const source = given ?? (first.source && first.source in LANGS ? first.source : "en");
    const titles: Record<string, string> = {};
    for (const c of CODES) titles[c] = toAscii(first.titles?.[c] ?? "");

    // Any title that is too long or came back empty (e.g. not romanized) gets one more try.
    const redo = CODES.filter((c) => !titles[c] || titles[c].length > MAX_TITLE);
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
    for (const c of CODES) titles[c] = shorten(titles[c]);
    if (!titles[source]) titles[source] = cleanTitle(title);

    return NextResponse.json({ source, titles } satisfies Result);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return fail(500, "the server's ANTHROPIC_API_KEY was rejected");
    if (err instanceof Anthropic.RateLimitError) return fail(429, "too many requests to Claude - wait a moment");
    if (err instanceof Anthropic.APIError) return fail(502, `Claude API error: ${err.message}`);
    return fail(500, (err as Error).message);
  }
}
