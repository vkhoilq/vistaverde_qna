/**
 * Optional Gemini endpoint (`GET /api/ask`).
 *
 * Off by default: only active when the `GEMINI_API_KEY` secret is set. The
 * retrieval half is deterministic (src/search.ts); the model only summarises
 * the retrieved published items and cites them. Prompt building and response
 * parsing are pure functions so they can be tested without network access.
 */

import { AppError } from "./errors.ts";
import type { AskResult, AskSource } from "./types.ts";

export const GEMINI_MODEL = "gemini-2.5-flash";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/** The subset of an item that is safe to send to the model. */
export interface LlmItem {
  id: string;
  question: string;
  answer: string;
  category: string;
}

const NO_ANSWER_TEXT =
  "Mình không tìm thấy thông tin này trong danh sách Q&A của toà nhà.";

/**
 * Build the Gemini prompt. Only the supplied (already published) items are
 * embedded; the model is told not to use outside knowledge and to cite ids.
 */
export function buildPrompt(query: string, items: LlmItem[]): string {
  const payload = items.map((item) => ({
    id: item.id,
    question: item.question,
    category: item.category,
    answer: item.answer,
  }));

  return [
    "Bạn là trợ lý trả lời câu hỏi cho cư dân chung cư Vista Verde (Thành phố Hồ Chí Minh).",
    'Chỉ được sử dụng thông tin trong phần "DANH SÁCH Q&A" bên dưới. Không dùng kiến thức bên ngoài.',
    `Nếu các mục trong danh sách không trả lời được câu hỏi, hãy trả lời đúng câu: "${NO_ANSWER_TEXT}"`,
    "Không được bịa ra câu hỏi, câu trả lời, mã (id) hoặc danh mục không có trong danh sách.",
    "Trả lời bằng tiếng Việt, ngắn gọn và lịch sự.",
    'Chỉ trả về JSON hợp lệ theo đúng dạng: {"answer": "chuỗi", "citedIds": ["id", ...]}',
    "Trong citedIds chỉ được dùng các id có trong danh sách; nếu không có mục nào liên quan thì để mảng rỗng.",
    "",
    "DANH SÁCH Q&A:",
    JSON.stringify(payload, null, 2),
    "",
    `CÂU HỎI: ${query}`,
  ].join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function extractText(payload: unknown): string {
  const root = asRecord(payload);
  if (!root) return "";
  const candidates = root.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  const first = asRecord(candidates[0]);
  if (!first) return "";
  const content = asRecord(first.content);
  if (!content) return "";
  const parts = content.parts;
  if (!Array.isArray(parts)) return "";
  let text = "";
  for (const part of parts) {
    const record = asRecord(part);
    if (record && typeof record.text === "string") text += record.text;
  }
  return text;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseModelJson(text: string): Record<string, unknown> | null {
  const cleaned = stripCodeFence(text);
  try {
    const parsed: unknown = JSON.parse(cleaned);
    return asRecord(parsed);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
        return asRecord(parsed);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function toSources(items: LlmItem[]): AskSource[] {
  return items.slice(0, 8).map((item) => ({
    id: item.id,
    question: item.question,
    category: item.category,
  }));
}

/**
 * Parse a Gemini `generateContent` payload.
 *
 * Sources are always intersected with the items that were actually sent, so the
 * model cannot introduce a Q&A that was not retrieved (and drafts can never
 * appear because they are never passed in).
 */
export function parseGeminiResponse(payload: unknown, items: LlmItem[]): AskResult {
  const root = asRecord(payload);
  const model =
    root && typeof root.modelVersion === "string" && root.modelVersion
      ? root.modelVersion
      : GEMINI_MODEL;

  const rawText = extractText(payload);
  const parsed = parseModelJson(rawText);

  let answer = "";
  let citedIds: unknown[] | null = null;

  if (parsed) {
    if (typeof parsed.answer === "string") answer = parsed.answer.trim();
    if (Array.isArray(parsed.citedIds)) citedIds = parsed.citedIds;
  }

  if (!answer) {
    // Fall back to the raw text only when it is not just an empty/JSON blob.
    const fallback = stripCodeFence(rawText).trim();
    answer = fallback && !parsed ? fallback : NO_ANSWER_TEXT;
  }

  let sources: AskSource[];
  if (citedIds) {
    const wanted = new Set(
      citedIds.filter((id): id is string => typeof id === "string").map((id) => id.trim()),
    );
    sources = toSources(items.filter((item) => wanted.has(item.id)));
  } else {
    sources = toSources(items);
  }

  return { answer, sources, model };
}

interface GeminiConfig {
  GEMINI_API_KEY?: string;
}

/**
 * Ask Gemini to answer strictly from `items`. Plain `fetch`, no SDK.
 * The API key is only placed in the request URL sent to Google.
 */
export async function answerQuestion(
  query: string,
  items: LlmItem[],
  config: GeminiConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<AskResult> {
  const apiKey = (config.GEMINI_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new AppError(
      "llm_not_configured",
      "The language model endpoint is not configured.",
      503,
    );
  }

  const url = new URL(`${GEMINI_ENDPOINT}/${GEMINI_MODEL}:generateContent`);
  url.searchParams.set("key", apiKey);

  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: buildPrompt(query, items) }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
    },
  });

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch {
    throw new AppError("llm_unreachable", "Could not reach the language model service.");
  }

  if (!response.ok) {
    throw new AppError(
      "llm_upstream_error",
      `The language model service returned status ${response.status}.`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AppError("llm_upstream_error", "The language model returned an unreadable response.");
  }

  const result = parseGeminiResponse(payload, items);
  if (!result.answer) {
    throw new AppError("llm_empty_response", "The language model returned an empty answer.");
  }
  return result;
}

export { NO_ANSWER_TEXT };
