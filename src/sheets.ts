/**
 * Google Sheets read + parse path.
 *
 * The sheet is the CMS: staff edit it in the Sheets UI. We read one range
 * (default `Q&A!A:G`, starting at row 1 so the header row is included) and map
 * columns by header name, never by fixed index.
 *
 * Parsing rules implemented here:
 *  - `values` may be absent when the sheet is empty.
 *  - Rows are ragged; missing cells are read as "".
 *  - Dates are ISO-8601 text, with a DD/MM/YYYY fallback.
 *  - Empty/missing `status` means published; drafts are excluded entirely.
 *  - `id` is derived server-side, never read from the sheet.
 */

import { AppError } from "./errors.ts";
import { parseSheetDate } from "./dates.ts";
import { buildItemIndex, fold } from "./search.ts";
import type { QAItem, Snapshot } from "./types.ts";

const DEFAULT_RANGE = "Q&A!A:G";

type SheetField =
  | "question"
  | "answer"
  | "category"
  | "keywords"
  | "asker"
  | "responder"
  | "status"
  | "createdAt"
  | "updatedAt";

const HEADER_ALIASES: Record<SheetField, string[]> = {
  question: ["question", "câu hỏi", "cau hoi", "title"],
  answer: ["answer", "câu trả lời", "tra loi", "content"],
  category: ["category", "danh mục", "danh muc", "chủ đề", "chude"],
  keywords: ["keywords", "từ khóa", "tu khoa", "tags"],
  asker: ["người hỏi", "nguoi hoi", "asker", "người đặt câu hỏi", "nguoi dat cau hoi"],
  responder: [
    "người trả lời",
    "nguoi tra loi",
    "responder",
    "người phụ trách",
    "nguoi phu trach",
    "bộ phận",
    "bo phan",
  ],
  status: ["status", "trạng thái", "trang thai", "published"],
  createdAt: [
    "created_at",
    "createdat",
    "created",
    "created at",
    "date",
    "ngày đăng",
    "ngay dang",
    "ngày hỏi",
    "ngay hoi",
  ],
  updatedAt: [
    "updated_at",
    "updatedat",
    "modified",
    "last updated",
    "lastupdated",
    "ngày cập nhật",
    "ngay cap nhat",
    "updated at",
  ],
};

/** Folder header/alias values so case, accents and separators do not matter. */
function headerKey(input: unknown): string {
  return fold(String(input ?? "")).replace(/[^\p{L}\p{N}]+/gu, "");
}

const HEADER_LOOKUP = (() => {
  const map = new Map<string, SheetField>();
  for (const field of Object.keys(HEADER_ALIASES) as SheetField[]) {
    for (const alias of HEADER_ALIASES[field]) {
      map.set(headerKey(alias), field);
    }
  }
  return map;
})();

const PUBLISHED_VALUES = new Set(["", "published", "yes", "true", "1", "co"]);

/** Published unless the status is an explicit draft marker. */
export function isPublished(raw: unknown): boolean {
  const key = headerKey(raw);
  return PUBLISHED_VALUES.has(key);
}

/** Split a comma/semicolon separated keyword cell, lowercase, de-duplicate. */
export function parseKeywords(raw: unknown): string[] {
  const text = String(raw ?? "");
  if (!text.trim()) return [];
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const part of text.split(/[,;]/)) {
    const keyword = part.trim().toLowerCase();
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    keywords.push(keyword);
  }
  return keywords;
}

function hexFromBytes(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Deterministic id: `bv-` + first 6 hex chars of sha256(category|question). */
export async function deriveId(category: string, question: string): Promise<string> {
  const input = new TextEncoder().encode(`${category}|${question}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return `bv-${hexFromBytes(new Uint8Array(digest)).slice(0, 6)}`;
}

function extractRows(values: unknown): unknown[][] | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  const rows: unknown[][] = [];
  for (const row of values) {
    rows.push(Array.isArray(row) ? row : []);
  }
  return rows;
}

function readCell(row: unknown[], index: number | undefined): string {
  if (index === undefined) return "";
  const value = row[index];
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function mapColumns(header: unknown[]): Partial<Record<SheetField, number>> {
  const columns: Partial<Record<SheetField, number>> = {};
  header.forEach((cell, index) => {
    const field = HEADER_LOOKUP.get(headerKey(cell));
    if (field && columns[field] === undefined) {
      columns[field] = index;
    }
  });
  return columns;
}

interface RowDraft {
  row: unknown[];
  columns: Partial<Record<SheetField, number>>;
}

function draftFromRow(row: unknown[], columns: Partial<Record<SheetField, number>>): RowDraft | null {
  const question = readCell(row, columns.question);
  if (!question) return null;

  const statusRaw = readCell(row, columns.status);
  if (!isPublished(statusRaw)) return null;

  // An unanswered question is not ready for the public site: staff add the row
  // first and fill the answer later, so a blank answer means "pending".
  // Only an explicitly set status overrides this (e.g. status = "published"
  // for a question that intentionally has no answer yet).
  const answer = readCell(row, columns.answer);
  if (!answer && headerKey(statusRaw) === "") return null;

  return { row, columns };
}

function buildItemBase(draft: RowDraft) {
  const { row, columns } = draft;
  const question = readCell(row, columns.question);
  const answer = readCell(row, columns.answer);
  const category = readCell(row, columns.category);
  const keywords = parseKeywords(readCell(row, columns.keywords));
  const asker = readCell(row, columns.asker);
  const responder = readCell(row, columns.responder);

  let createdAt = parseSheetDate(readCell(row, columns.createdAt));
  let updatedAt = parseSheetDate(readCell(row, columns.updatedAt));
  if (!createdAt) createdAt = updatedAt;
  if (!updatedAt) updatedAt = createdAt;

  return { question, answer, category, keywords, asker, responder, createdAt, updatedAt };
}

export interface ParsedSheet {
  items: QAItem[];
  categories: string[];
}

/** Parse raw `values` from the Sheets API. Never throws on empty/ragged input. */
export async function parseSheetValues(values: unknown): Promise<ParsedSheet> {
  const rows = extractRows(values);
  if (!rows) return { items: [], categories: [] };

  const header = rows[0] ?? [];
  const columns = mapColumns(header);
  if (columns.question === undefined) return { items: [], categories: [] };

  const drafts: RowDraft[] = [];
  for (const row of rows.slice(1)) {
    const draft = draftFromRow(row, columns);
    if (draft) drafts.push(draft);
  }

  const items = await Promise.all(
    drafts.map(async (draft) => {
      const base = buildItemBase(draft);
      const id = await deriveId(base.category, base.question);
      return {
        id,
        question: base.question,
        answer: base.answer,
        category: base.category,
        keywords: base.keywords,
        asker: base.asker,
        responder: base.responder,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
        index: buildItemIndex(base.question, base.answer, base.keywords),
      } satisfies QAItem;
    }),
  );

  return { items, categories: collectCategories(items) };
}

/** Distinct, sorted categories across all published items (accent-insensitive). */
export function collectCategories(items: QAItem[]): string[] {
  const seen = new Set<string>();
  const categories: string[] = [];
  for (const item of items) {
    const category = item.category.trim();
    if (!category) continue;
    const key = fold(category).replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    categories.push(category);
  }
  categories.sort((a, b) => a.localeCompare(b, "vi"));
  return categories;
}

export interface CreateSnapshotOptions {
  fetchedAt?: string;
  sheetRange?: string;
}

/** Build the KV snapshot (including precomputed search indexes). */
export async function createSnapshot(
  values: unknown,
  options: CreateSnapshotOptions = {},
): Promise<Snapshot> {
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  const sheetRange = options.sheetRange ?? DEFAULT_RANGE;
  const parsed = await parseSheetValues(values);
  return {
    fetchedAt,
    updatedAt: fetchedAt,
    sheetRange,
    items: parsed.items,
    categories: parsed.categories,
  };
}

export interface SheetsConfig {
  SPREADSHEET_ID?: string;
  SHEETS_RANGE?: string;
  SHEETS_API_KEY?: string;
}

function readValues(payload: unknown): unknown[] {
  if (typeof payload !== "object" || payload === null) return [];
  const values = (payload as { values?: unknown }).values;
  return Array.isArray(values) ? values : [];
}

/**
 * Read the configured range from the Sheets API. Only the API key is used
 * (the sheet is shared "Anyone with the link" → Viewer).
 *
 * Upstream bodies are never surfaced to callers; only the HTTP status is used.
 */
export async function fetchSheetValues(
  env: SheetsConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown[]> {
  const apiKey = (env.SHEETS_API_KEY ?? "").trim();
  const spreadsheetId = (env.SPREADSHEET_ID ?? "").trim();
  if (!apiKey) {
    throw new AppError(
      "sheets_not_configured",
      "The Sheets API key is not configured on the server.",
    );
  }
  if (!spreadsheetId) {
    throw new AppError(
      "spreadsheet_not_configured",
      "The spreadsheet id is not configured on the server.",
    );
  }

  const range = (env.SHEETS_RANGE ?? "").trim() || DEFAULT_RANGE;
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
  );
  url.searchParams.set("key", apiKey);

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
    });
  } catch {
    throw new AppError("sheets_unreachable", "Could not reach the Google Sheets API.");
  }

  if (!response.ok) {
    throw new AppError(
      "sheets_upstream_error",
      `Google Sheets returned status ${response.status}.`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AppError("sheets_upstream_error", "Google Sheets returned an unreadable response.");
  }

  return readValues(payload);
}
