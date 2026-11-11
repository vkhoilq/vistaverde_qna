/**
 * Vietnamese-aware search.
 *
 * Vietnamese words are separated by spaces but search input often is not, and
 * diacritics are frequently omitted. Everything here is pure and synchronous.
 * Folded/segmented token sets are built once per snapshot (see `buildItemIndex`)
 * and stored in KV, so request handling only does string comparisons.
 */

import type {
  IndexedText,
  ItemIndex,
  QAItem,
  ScoredQAItem,
  SearchQuery,
} from "./types.ts";
import { normalizeDateBound } from "./dates.ts";

export const FIELD_WEIGHTS = {
  question: 3,
  keywords: 2,
  answer: 1,
} as const;

/** Words that carry little meaning in a multi-word Vietnamese query. */
const STOP_WORDS = new Set([
  "la",
  "bao",
  "nhieu",
  "cua",
  "va",
  "thi",
  "cho",
  "co",
  "khong",
  "mot",
  "cac",
  "nhung",
  "gi",
  "nao",
  "tai",
  "trong",
  "de",
  "duoc",
  "nay",
  "do",
  "khi",
  "voi",
  "ra",
  "sao",
]);

/**
 * Fold diacritics and lowercase. `đ` is not decomposed by NFD, so it is mapped
 * to `d` explicitly — otherwise "đăng" would not match a "dang" search.
 */
export function fold(input: string): string {
  return String(input ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d");
}

let segmenter: Intl.Segmenter | undefined;

function getSegmenter(): Intl.Segmenter {
  if (!segmenter) {
    segmenter = new Intl.Segmenter("vi", { granularity: "word" });
  }
  return segmenter;
}

/** Segment folded text into word-like tokens. Empty when there is no word input. */
export function segmentWords(input: string): string[] {
  const folded = fold(input);
  if (!folded) return [];
  const words: string[] = [];
  for (const part of getSegmenter().segment(folded)) {
    if (part.isWordLike && part.segment.length > 0) {
      words.push(part.segment);
    }
  }
  return words;
}

function onlyLettersAndDigits(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, "");
}

function bigramsOf(text: string): string[] {
  const seen = new Set<string>();
  for (let i = 0; i + 1 < text.length; i += 1) {
    seen.add(text.slice(i, i + 2));
  }
  return Array.from(seen);
}

/** Build the precomputed index for one text field. */
export function buildIndexedText(input: string): IndexedText {
  const folded = fold(input).replace(/\s+/g, " ").trim();
  const compact = onlyLettersAndDigits(folded);
  const words = Array.from(new Set(segmentWords(folded)));
  return { folded, compact, words, bigrams: bigramsOf(compact) };
}

/** Index a Q&A item. Called once per row when a snapshot is created. */
export function buildItemIndex(
  question: string,
  answer: string,
  keywords: string[],
): ItemIndex {
  return {
    question: buildIndexedText(question),
    keywords: buildIndexedText(keywords.join(", ")),
    answer: buildIndexedText(answer),
  };
}

/**
 * Query tokens: segmented words, deduplicated. Multi-word queries drop common
 * stop words. A query made *only* of function words ("khong co gi") yields no
 * tokens — it carries no signal, and matching it loosely would return the whole
 * corpus. Such a query falls back to whole-phrase substring matching only.
 */
export function tokenizeQuery(query: string): string[] {
  const words = Array.from(new Set(segmentWords(query)));
  if (words.length <= 1) return words;
  return words.filter((word) => !STOP_WORDS.has(word));
}

function hasExactWord(words: string[], token: string): boolean {
  for (const word of words) {
    if (word === token) return true;
  }
  return false;
}

function hasPrefixWord(words: string[], token: string): boolean {
  for (const word of words) {
    if (word.length > token.length && word.startsWith(token)) return true;
  }
  return false;
}

function bigramOverlap(field: IndexedText, token: string): number {
  const tokenBigrams = bigramsOf(token);
  if (tokenBigrams.length === 0) return 0;
  let hits = 0;
  for (const bigram of tokenBigrams) {
    if (field.bigrams.includes(bigram)) hits += 1;
  }
  return hits / tokenBigrams.length;
}

function scoreField(
  field: IndexedText,
  tokens: string[],
  phrase: string,
  compactPhrase: string,
): number {
  let score = 0;

  for (const token of tokens) {
    if (hasExactWord(field.words, token)) {
      score += 1;
      continue;
    }
    if (token.length >= 2 && hasPrefixWord(field.words, token)) {
      // Prefix matches rank slightly below a whole-word match.
      score += 0.7;
      continue;
    }
    if (token.length >= 2) {
      // Fallback for input written without spaces between syllables.
      const overlap = bigramOverlap(field, token);
      if (overlap >= 0.5) score += 0.4 * overlap;
    }
  }

  if (phrase.length > 0 && field.folded.includes(phrase)) {
    score += 2;
  } else if (compactPhrase.length >= 4 && field.compact.includes(compactPhrase)) {
    score += 1.5;
  }

  return score;
}

/**
 * Count how many query tokens matched *meaningfully* in some field: a whole
 * word, a word prefix, or a high bigram overlap (for input written without
 * spaces).
 *
 * Partial bigram credit alone must never qualify an item, otherwise a query
 * containing one common syllable matches the whole corpus. Bigrams still
 * contribute to the ranking score, but cannot admit an item on their own.
 */
function countStrongMatches(item: QAItem, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const fields = [item.index.question, item.index.keywords, item.index.answer];
  let matched = 0;
  for (const token of tokens) {
    let hit = false;
    for (const field of fields) {
      if (hasExactWord(field.words, token)) {
        hit = true;
      } else if (token.length >= 2 && hasPrefixWord(field.words, token)) {
        hit = true;
      } else if (token.length >= 4 && bigramOverlap(field, token) >= 0.8) {
        hit = true;
      }
      if (hit) break;
    }
    if (hit) matched += 1;
  }
  return matched;
}

/**
 * How many tokens an item must match to be a candidate. Short queries must
 * match in full (so "thang máy" does not drag in every row containing "mấy");
 * longer natural-language queries only need a strong majority.
 */
function requiredTokenMatches(tokenCount: number): number {
  if (tokenCount <= 3) return tokenCount;
  return Math.ceil(tokenCount * 0.6);
}

/** Relevance of one item for a non-empty query. */
export function scoreItem(
  item: QAItem,
  tokens: string[],
  phrase: string,
  compactPhrase: string,
): number {
  return (
    FIELD_WEIGHTS.question * scoreField(item.index.question, tokens, phrase, compactPhrase) +
    FIELD_WEIGHTS.keywords * scoreField(item.index.keywords, tokens, phrase, compactPhrase) +
    FIELD_WEIGHTS.answer * scoreField(item.index.answer, tokens, phrase, compactPhrase)
  );
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function toPublicItem(item: QAItem, score: number): ScoredQAItem {
  return {
    id: item.id,
    question: item.question,
    answer: item.answer,
    category: item.category,
    keywords: item.keywords,
    asker: item.asker,
    responder: item.responder,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    score: roundScore(score),
  };
}

/** Parse and clamp the query string parameters of `/api/qa`. */
export function parseQueryParams(params: URLSearchParams): SearchQuery {
  const q = (params.get("q") ?? "").trim();
  const category = (params.get("category") ?? "").trim();
  const from = normalizeDateBound(params.get("from"));
  const to = normalizeDateBound(params.get("to"));

  let limit = Number.parseInt(params.get("limit") ?? "", 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  limit = Math.min(limit, 200);

  let offset = Number.parseInt(params.get("offset") ?? "", 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  return { q, category, from, to, limit, offset };
}

export interface QueryResult {
  total: number;
  limit: number;
  offset: number;
  items: ScoredQAItem[];
}

/**
 * Filter, score, sort and paginate already-published items.
 *
 * - `q` empty  → everything, `updatedAt` desc then `createdAt` desc, score 0.
 * - `q` present → only score > 0, relevance desc.
 * - Date bounds are inclusive and compared lexically (both sides `YYYY-MM-DD`).
 */
export function runQuery(items: QAItem[], query: SearchQuery): QueryResult {
  const foldedCategory = fold(query.category).replace(/\s+/g, " ").trim();
  const phrase = fold(query.q).replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
  const compactPhrase = onlyLettersAndDigits(phrase);
  const tokens = phrase ? tokenizeQuery(phrase) : [];
  const requiredMatches = requiredTokenMatches(tokens.length);

  const matches: Array<{ item: QAItem; score: number }> = [];

  for (const item of items) {
    if (foldedCategory && fold(item.category).replace(/\s+/g, " ").trim() !== foldedCategory) {
      continue;
    }

    if (query.from || query.to) {
      const itemDate = item.createdAt || item.updatedAt;
      if (!itemDate) continue;
      if (query.from && itemDate < query.from) continue;
      if (query.to && itemDate > query.to) continue;
    }

    let score = 0;
    if (phrase) {
      if (countStrongMatches(item, tokens) < requiredMatches) continue;
      score = scoreItem(item, tokens, phrase, compactPhrase);
      if (score <= 0) continue;
    }

    matches.push({ item, score });
  }

  matches.sort((a, b) => {
    if (phrase && b.score !== a.score) return b.score - a.score;
    const updatedA = a.item.updatedAt || "";
    const updatedB = b.item.updatedAt || "";
    if (updatedA !== updatedB) return updatedA < updatedB ? 1 : -1;
    const createdA = a.item.createdAt || "";
    const createdB = b.item.createdAt || "";
    if (createdA !== createdB) return createdA < createdB ? 1 : -1;
    if (a.item.id === b.item.id) return 0;
    return a.item.id < b.item.id ? -1 : 1;
  });

  const page = matches.slice(query.offset, query.offset + query.limit);

  return {
    total: matches.length,
    limit: query.limit,
    offset: query.offset,
    items: page.map(({ item, score }) => toPublicItem(item, score)),
  };
}
