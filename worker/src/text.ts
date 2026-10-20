// Text checks for contributions: cleaning, length limits, and the profanity filter.

import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from "obscenity";

export class Rejected extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
  }
}

// Words in obscenity's English list that are ordinary vocabulary in biomedical illustration.
const SCIENTIFIC = new Set(["anal", "anus", "ejaculate", "orgasm", "penis", "semen", "sex", "vagina", "tit"]);

// Words that contain a listed word but are fine (matched as a prefix of the whole word).
const ALLOWED_PREFIXES = [
  "analg", "analy", "cumin", "cumul", "cumber", "cucumber", "shiitake", "retardant", "retardation",
  "dickinson", "dickens", "hancock", "peacock", "cockatoo", "cockroach", "cocci", "coccus", "scunthorpe",
  "titr", "titan", "therapist", "assay", "assess", "assist", "assoc", "assum", "bass", "class", "pass", "mass",
];

const matcher = new RegExpMatcher({
  ...englishDataset.removePhrasesIf((p) => SCIENTIFIC.has(String(p.metadata?.originalWord))).build(),
  ...englishRecommendedTransformers,
});

/** The offending word, or null. Each match is widened to its whitespace-delimited word so
 *  allowed words that merely contain a listed one ("analgesic", "flame-retardant") pass. */
export function profanity(text: string): string | null {
  for (const m of matcher.getAllMatches(text)) {
    let start = m.startIndex;
    let end = m.endIndex + 1;
    while (start > 0 && !/\s/.test(text[start - 1])) start--;
    while (end < text.length && !/\s/.test(text[end])) end++;
    const word = text.slice(start, end);
    const letters = word.toLowerCase().replace(/[^a-z]/g, "");
    const parts = word.toLowerCase().split(/[-/]+/).filter(Boolean);
    const allowed = (w: string) => ALLOWED_PREFIXES.some((p) => w.replace(/[^a-z]/g, "").startsWith(p));
    // "flame-retardant": each hyphenated part must be allowed or clean on its own.
    if (allowed(letters) || (parts.length > 1 && parts.every((p) => allowed(p) || !matcher.hasMatch(p)))) continue;
    return word;
  }
  return null;
}

/** Trim, drop control characters, enforce a length limit. */
export function clean(v: unknown, limit: number, field: string, required = false): string {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (required && !s) throw new Rejected(`${field} is required`);
  if ([...s].length > limit) throw new Rejected(`${field} is longer than ${limit} characters`);
  return s;
}

/** Reject if any of `texts` contains profanity (the word is not echoed back). */
export function checkLanguage(texts: string[]): void {
  for (const t of texts) {
    if (t && profanity(t)) throw new Rejected("This contains language that isn't allowed. Please reword it.");
  }
}

/** URL- and key-safe id: readable slug plus random suffix. Matches data/uploads.py's SLUG. */
export function newId(title: string): string {
  const slug = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const rand = [...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${slug || "item"}-${rand}`;
}
