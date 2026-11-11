/**
 * Shared types for the Vista Verde Q&A worker.
 *
 * Note: Node runs the test files with type-stripping only, so everything here
 * must be erasable TypeScript (no enums, namespaces, parameter properties).
 */

/** Precomputed search index for a single text field. */
export interface IndexedText {
  /** Folded (accent-free, lowercase) text with whitespace collapsed. */
  folded: string;
  /** Folded text with all non-alphanumeric characters removed. */
  compact: string;
  /** Segmented, word-like tokens (folded). */
  words: string[];
  /** Deduplicated character bigrams of `compact`. */
  bigrams: string[];
}

export interface ItemIndex {
  question: IndexedText;
  keywords: IndexedText;
  answer: IndexedText;
}

/** A single Q&A item as exposed by the API (index is stripped in responses). */
export interface QAItem {
  id: string;
  question: string;
  answer: string;
  category: string;
  keywords: string[];
  /** Người hỏi — who asked. Empty when not recorded. */
  asker: string;
  /** Người trả lời — who answered. Empty when not recorded. */
  responder: string;
  /** YYYY-MM-DD, or "" when unknown/invalid. */
  createdAt: string;
  /** YYYY-MM-DD, or "" when unknown/invalid. */
  updatedAt: string;
  /** Precomputed once per snapshot so per-request work stays small. */
  index: ItemIndex;
}

export interface ScoredQAItem extends Omit<QAItem, "index"> {
  score: number;
}

/** Snapshot stored in KV under `qa:snapshot`. */
export interface Snapshot {
  /** ISO timestamp of when the snapshot was fetched from Sheets. */
  fetchedAt: string;
  /** ISO timestamp exposed as the top-level `updatedAt` in API responses. */
  updatedAt: string;
  /** Range used to read the sheet, e.g. `Q&A!A:G`. */
  sheetRange: string;
  /** Published items only. */
  items: QAItem[];
  /** Sorted, distinct categories across all published items. */
  categories: string[];
}

export interface SearchQuery {
  q: string;
  category: string;
  from: string;
  to: string;
  limit: number;
  offset: number;
}

export interface AskSource {
  id: string;
  question: string;
  category: string;
}

export interface AskResult {
  answer: string;
  sources: AskSource[];
  model: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/** Bindings available to the worker. */
export interface Env {
  QACACHE: KVNamespace;
  ASSETS?: Fetcher;
  SPREADSHEET_ID?: string;
  SHEETS_RANGE?: string;
  /** Secret. Never log or return this. */
  SHEETS_API_KEY?: string;
  /** Secret. Optional; enables /api/ask. */
  GEMINI_API_KEY?: string;
}
