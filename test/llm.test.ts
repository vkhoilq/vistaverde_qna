import test from "node:test";
import assert from "node:assert/strict";

import { AppError } from "../src/errors.ts";
import {
  answerQuestion,
  buildPrompt,
  GEMINI_MODEL,
  NO_ANSWER_TEXT,
  parseGeminiResponse,
} from "../src/llm.ts";
import type { LlmItem } from "../src/llm.ts";

const ITEMS: LlmItem[] = [
  {
    id: "bv-aaaaaa",
    question: "Học phí năm 2027 là bao nhiêu?",
    answer: "Bảng phí sẽ được gửi vào tháng 12/2026.",
    category: "Phí quản lý",
  },
  {
    id: "bv-bbbbbb",
    question: "Hồ bơi mở cửa mấy giờ?",
    answer: "Hồ bơi mở từ 6h đến 21h.",
    category: "Tiện ích",
  },
];

function geminiPayload(text: string, modelVersion = GEMINI_MODEL): unknown {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
    modelVersion,
  };
}

function mockFetch(
  handler: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return handler as unknown as typeof fetch;
}

test("buildPrompt embeds only the provided items and forbids outside knowledge", () => {
  const prompt = buildPrompt("học phí 2027", ITEMS);

  assert.ok(prompt.includes("bv-aaaaaa"));
  assert.ok(prompt.includes("bv-bbbbbb"));
  assert.ok(prompt.includes("Học phí năm 2027 là bao nhiêu?"));
  assert.ok(prompt.includes("Hồ bơi mở cửa mấy giờ?"));
  assert.ok(prompt.includes("học phí 2027"));
  assert.ok(prompt.includes("Chỉ được sử dụng thông tin"));
  assert.ok(prompt.includes(NO_ANSWER_TEXT));
  assert.ok(prompt.includes("citedIds"));
  assert.equal(prompt.includes("bv-draft"), false);
});

test("buildPrompt is safe with no items", () => {
  const prompt = buildPrompt("câu hỏi", []);
  assert.ok(prompt.includes("DANH SÁCH Q&A:"));
  assert.ok(prompt.includes("[]"));
});

test("parses a clean JSON answer and filters sources to retrieved ids", () => {
  const text = JSON.stringify({
    answer: "Hồ bơi mở từ 6h đến 21h.",
    citedIds: ["bv-bbbbbb", "bv-does-not-exist"],
  });
  const result = parseGeminiResponse(geminiPayload(text), ITEMS);

  assert.equal(result.answer, "Hồ bơi mở từ 6h đến 21h.");
  assert.equal(result.model, GEMINI_MODEL);
  assert.deepEqual(result.sources, [
    { id: "bv-bbbbbb", question: "Hồ bơi mở cửa mấy giờ?", category: "Tiện ích" },
  ]);
});

test("parses JSON wrapped in a markdown code fence", () => {
  const text = '```json\n{"answer":"Có bảng phí.","citedIds":["bv-aaaaaa"]}\n```';
  const result = parseGeminiResponse(geminiPayload(text), ITEMS);

  assert.equal(result.answer, "Có bảng phí.");
  assert.deepEqual(result.sources.map((source) => source.id), ["bv-aaaaaa"]);
});

test("unknown model citations cannot introduce items", () => {
  const text = JSON.stringify({ answer: "Không rõ.", citedIds: ["bv-fake99"] });
  const result = parseGeminiResponse(geminiPayload(text), ITEMS);

  assert.equal(result.answer, "Không rõ.");
  assert.deepEqual(result.sources, []);
});

test("falls back to plain text when the model does not return JSON", () => {
  const result = parseGeminiResponse(geminiPayload("Hồ bơi mở từ 6h."), ITEMS);

  assert.equal(result.answer, "Hồ bơi mở từ 6h.");
  assert.equal(result.sources.length, ITEMS.length);
});

test("missing candidates produces the no-answer response", () => {
  const result = parseGeminiResponse({}, ITEMS);

  assert.equal(result.answer, NO_ANSWER_TEXT);
  assert.deepEqual(result.sources.map((source) => source.id), ["bv-aaaaaa", "bv-bbbbbb"]);
  assert.equal(result.model, GEMINI_MODEL);
});

test("uses the modelVersion reported by Gemini when present", () => {
  const text = JSON.stringify({ answer: "Ổn.", citedIds: [] });
  const result = parseGeminiResponse(geminiPayload(text, "gemini-2.5-flash-001"), ITEMS);
  assert.equal(result.model, "gemini-2.5-flash-001");
});

test("answerQuestion rejects with 503 when no API key is configured", async () => {
  await assert.rejects(
    answerQuestion("học phí", ITEMS, {}, mockFetch(() => new Response("{}"))),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "llm_not_configured");
      assert.equal(error.status, 503);
      return true;
    },
  );
});

test("answerQuestion calls Gemini with the retrieved items and parses the reply", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fakeFetch = mockFetch((input, init) => {
    calls.push({
      url: String(input),
      body: String(init?.body ?? ""),
    });
    const text = JSON.stringify({
      answer: "Bảng phí sẽ được gửi vào tháng 12/2026.",
      citedIds: ["bv-aaaaaa"],
    });
    return new Response(JSON.stringify(geminiPayload(text)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const result = await answerQuestion(
    "học phí 2027",
    ITEMS,
    { GEMINI_API_KEY: "test-key" },
    fakeFetch,
  );

  assert.equal(calls.length, 1);
  const url = new URL(calls[0]?.url ?? "");
  assert.ok(url.origin.includes("generativelanguage.googleapis.com"));
  assert.ok(url.pathname.includes(`${GEMINI_MODEL}:generateContent`));
  assert.equal(url.searchParams.get("key"), "test-key");

  assert.ok(calls[0]?.body.includes("bv-aaaaaa"));
  assert.ok(calls[0]?.body.includes("bv-bbbbbb"));

  assert.equal(result.answer, "Bảng phí sẽ được gửi vào tháng 12/2026.");
  assert.deepEqual(result.sources.map((source) => source.id), ["bv-aaaaaa"]);
});

test("answerQuestion never leaks the API key in upstream error messages", async () => {
  await assert.rejects(
    answerQuestion(
      "học phí",
      ITEMS,
      { GEMINI_API_KEY: "super-secret-key" },
      mockFetch(
        () =>
          new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
            status: 429,
          }),
      ),
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "llm_upstream_error");
      assert.equal(error.status, 500);
      assert.equal(error.message.includes("super-secret-key"), false);
      assert.equal(error.message.includes("quota exceeded"), false);
      return true;
    },
  );
});

test("network failures become a generic upstream error", async () => {
  await assert.rejects(
    answerQuestion(
      "học phí",
      ITEMS,
      { GEMINI_API_KEY: "test-key" },
      mockFetch(() => {
        throw new Error("network down: test-key");
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "llm_unreachable");
      assert.equal(error.message.includes("test-key"), false);
      return true;
    },
  );
});
