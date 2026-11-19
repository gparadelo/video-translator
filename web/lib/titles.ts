// Rules for translated video titles, shared by the /titles page and /api/titles.

export const MAX_TITLE = 60;

// Languages written in another script: the model gives a Latin (romanized) version.
export const NON_LATIN = new Set(["ja", "ko", "zh", "ar", "hi", "ru", "uk", "el"]);

// Letters that NFD doesn't split into "base letter + accent", and typographic punctuation.
const SPECIAL: Record<string, string> = {
  ß: "ss", ẞ: "SS", æ: "ae", Æ: "Ae", ø: "o", Ø: "O", œ: "oe", Œ: "Oe", ł: "l", Ł: "L",
  đ: "d", Đ: "D", ð: "d", Ð: "D", þ: "th", Þ: "Th", ı: "i", ħ: "h", Ħ: "H", ŧ: "t", Ŧ: "T",
  ŋ: "n", Ŋ: "N", ſ: "s", ĸ: "k",
  "‘": "'", "’": "'", "‚": "'", "‹": "'", "›": "'", "`": "'", "´": "'",
  "“": '"', "”": '"', "„": '"', "«": '"', "»": '"',
  "–": "-", "—": "-", "‐": "-", "‑": "-", "…": "...", " ": " ",
};

/** Plain ASCII: accents removed, special letters spelled out, anything else outside
 *  letters, digits, spaces and . , ! ? : - ' " ( ) & dropped. */
export function toAscii(text: string) {
  return text
    .replace(/«\s*/g, "\"").replace(/\s*»/g, "\"") // French guillemets carry inner spaces
    .replace(/[^\x00-\x7f]/g, (c) => SPECIAL[c] ?? c)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9 .,!?:\-'"()&]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?:])/g, "$1")
    .trim();
}

/** Cut to `max` characters at a word boundary, without leaving dangling punctuation. */
export function shorten(text: string, max = MAX_TITLE) {
  if (text.length <= max) return text;
  let cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  cut = space > max / 2 ? cut.slice(0, space) : cut.slice(0, max);
  return cut.replace(/[\s,:\-&("']+$/, "").trim();
}

/** A title that follows every rule. */
export const cleanTitle = (text: string) => shorten(toAscii(text));
