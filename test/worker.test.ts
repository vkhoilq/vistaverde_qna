import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createSnapshot } from "../src/sheets.ts";
import { handleRequest, __resetSnapshotMemory } from "../src/worker.ts";
import type { Env, Snapshot } from "../src/types.ts";

const SNAPSHOT_KEY = "qa:snapshot";
const TEST_SECRET = "test-sheets-key";

class MemoryKV {
  store = new Map<string, string>();
  getCalls = 0;
  putCalls = 0;

  async get(key: string): Promise<string | null> {
    this.getCalls += 1;
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.putCalls += 1;
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(): Promise<{ keys: Array<{ name: string }>; list_complete: boolean }> {
    return {
      keys: Array.from(this.store.keys()).map((name) => ({ name })),
      list_complete: true,
    };
  }
}

const HEADERS = [
  "Question",
  "Answer",
  "Category",
  "Người hỏi",
  "Người trả lời",
  "Status",
  "Created at",
  "Updated at",
];

const VALUES = [
  HEADERS,
  [
    "Phí quản lý năm 2027 là bao nhiêu?",
    "Bảng phí sẽ được gửi vào tháng 12.",
    "Phí quản lý",
    "Lan Trần",
    "Bộ phận Kế toán",
    "published",
    "2026-10-02",
    "2026-11-01",
  ],
  [
    "Câu nháp nội bộ",
    "Thông tin nội bộ chưa công bố. Tài liệu tuyệt mật.",
    "Nội bộ",
    "Minh Phạm",
    "Ban quản lý",
    "draft",
    "2026-10-01",
    "2026-10-01",
  ],
  [
    "Hồ bơi mở cửa mấy giờ?",
    "Hồ bơi mở từ 6h đến 21h.",
    "Tiện ích",
    "",
    "",
    "",
    "2026-09-15",
    "2026-10-20",
  ],
];

function makeEnv(kv: MemoryKV, extra: Partial<Env> = {}): Env {
  return {
    QACACHE: kv as unknown as KVNamespace,
    SPREADSHEET_ID: "sheet-abc",
    SHEETS_RANGE: "Q&A!A:G",
    SHEETS_API_KEY: TEST_SECRET,
    ...extra,
  };
}

function sheetsFetch(values: unknown, counter?: { calls: number }): typeof fetch {
  return (async () => {
    if (counter) counter.calls += 1;
    return new Response(JSON.stringify({ range: "Q&A!A:G", values }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

async function primeSnapshot(kv: MemoryKV, fetchedAt = new Date().toISOString()): Promise<Snapshot> {
  const snapshot = await createSnapshot(VALUES, {
    fetchedAt,
    sheetRange: "Q&A!A:G",
  });
  kv.store.set(SNAPSHOT_KEY, JSON.stringify(snapshot));
  return snapshot;
}

interface ApiItem {
  id: string;
  question: string;
  answer: string;
  category: string;
  keywords: string[];
  asker: string;
  responder: string;
  createdAt: string;
  updatedAt: string;
  score: number;
}

interface QaBody {
  updatedAt: string;
  total: number;
  limit: number;
  offset: number;
  categories: string[];
  items: ApiItem[];
}

interface MetaBody {
  updatedAt: string;
  total: number;
  categories: string[];
  source: "sheets" | "cache";
  sheetRange: string;
}

interface ErrorBody {
  error: { code: string; message: string };
}

function apiRequest(path: string, method = "GET"): Request {
  return new Request(`https://vista-verde.example${path}`, { method });
}

beforeEach(() => {
  __resetSnapshotMemory();
});

test("/api/qa returns published items only and caches the snapshot once", async () => {
  const kv = new MemoryKV();
  const env = makeEnv(kv);
  const response = await handleRequest(apiRequest("/api/qa"), env, sheetsFetch(VALUES));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");

  const body = (await response.json()) as QaBody;
  assert.equal(body.total, 2);
  assert.equal(body.limit, 50);
  assert.equal(body.offset, 0);
  assert.deepEqual(body.categories, ["Phí quản lý", "Tiện ích"]);
  assert.ok(!Number.isNaN(Date.parse(body.updatedAt)));

  assert.equal(body.items.length, 2);
  assert.deepEqual(
    body.items.map((item) => item.question).sort(),
    ["Hồ bơi mở cửa mấy giờ?", "Phí quản lý năm 2027 là bao nhiêu?"],
  );
  assert.ok(body.items.every((item) => item.score === 0));
  assert.equal(JSON.stringify(body).includes("Câu nháp nội bộ"), false);
  assert.equal(JSON.stringify(body).includes("Thông tin nội bộ"), false);
  assert.equal(kv.putCalls, 1);
  assert.ok(kv.store.has(SNAPSHOT_KEY));

  // Ask attribution is published; the draft's asker must not be.
  const fee = body.items.find((item) => item.question.includes("Phí quản lý"));
  assert.ok(fee);
  assert.equal(fee.asker, "Lan Trần");
  assert.equal(fee.responder, "Bộ phận Kế toán");
  assert.equal(JSON.stringify(body).includes("Minh Phạm"), false);
  assert.equal(JSON.stringify(body).includes("Ban quản lý"), false);
});

test("draft items cannot be found even when the query matches them", async () => {
  const kv = new MemoryKV();
  const env = makeEnv(kv);

  for (const query of ["cau+nhap+noi+bo", "tuyet+mat"]) {
    const response = await handleRequest(apiRequest(`/api/qa?q=${query}`), env, sheetsFetch(VALUES));
    assert.equal(response.status, 200);

    const body = (await response.json()) as QaBody;
    const serialized = JSON.stringify(body);
    assert.equal(body.items.some((item) => item.question === "Câu nháp nội bộ"), false);
    assert.equal(serialized.includes("Câu nháp nội bộ"), false);
    assert.equal(serialized.includes("tuyệt mật"), false);
    // Categories still describe all published items.
    assert.deepEqual(body.categories, ["Phí quản lý", "Tiện ích"]);
  }
});

test("a cached snapshot short-circuits the Sheets call (no auto-refresh)", async () => {
  const kv = new MemoryKV();
  await primeSnapshot(kv);
  const counter = { calls: 0 };
  const failingFetch = (async () => {
    counter.calls += 1;
    throw new Error("Sheets should not be called");
  }) as unknown as typeof fetch;

  const response = await handleRequest(apiRequest("/api/qa"), makeEnv(kv), failingFetch);

  assert.equal(response.status, 200);
  assert.equal(counter.calls, 0);
  assert.equal(kv.putCalls, 0);

  const metaResponse = await handleRequest(apiRequest("/api/meta"), makeEnv(kv), failingFetch);
  const meta = (await metaResponse.json()) as MetaBody;
  assert.equal(counter.calls, 0);
  assert.equal(meta.source, "cache");
  assert.equal(meta.total, 2);
  assert.equal(meta.sheetRange, "Q&A!A:G");
  assert.deepEqual(meta.categories, ["Phí quản lý", "Tiện ích"]);
});

test("a stale snapshot is served without refreshing — sync is manual", async () => {
  const kv = new MemoryKV();
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await primeSnapshot(kv, twoHoursAgo);

  const counter = { calls: 0 };
  const failingFetch = (async () => {
    counter.calls += 1;
    return new Response("boom", { status: 500 });
  }) as unknown as typeof fetch;

  const response = await handleRequest(apiRequest("/api/qa"), makeEnv(kv), failingFetch);

  assert.equal(response.status, 200);
  const body = (await response.json()) as QaBody;
  assert.equal(body.total, 2);
  // No age-based refresh: an old snapshot is served as-is until someone
  // clears it manually.
  assert.equal(counter.calls, 0);
});

test("an empty KV reads the sheet once (cold start)", async () => {
  const kv = new MemoryKV();
  const counter = { calls: 0 };
  const countingFetch = sheetsFetch(VALUES, counter);

  const response = await handleRequest(apiRequest("/api/qa"), makeEnv(kv), countingFetch);
  assert.equal(response.status, 200);
  assert.equal(counter.calls, 1);
  assert.equal(kv.putCalls, 1);

  // The second request is served from KV — no further Sheets call.
  const second = await handleRequest(apiRequest("/api/qa"), makeEnv(kv), countingFetch);
  assert.equal(second.status, 200);
  assert.equal(counter.calls, 1);
});

test("upstream failures return a JSON 500 without leaking secrets or bodies", async () => {
  const kv = new MemoryKV();
  const env = makeEnv(kv);

  for (const fetchImpl of [
    (async () => new Response("upstream says: " + TEST_SECRET, { status: 500 })) as unknown as typeof fetch,
    (async () => {
      throw new Error(`network down ${TEST_SECRET}`);
    }) as unknown as typeof fetch,
  ]) {
    __resetSnapshotMemory();
    const response = await handleRequest(apiRequest("/api/qa"), env, fetchImpl);
    assert.equal(response.status, 500);

    const text = await response.text();
    const body = JSON.parse(text) as ErrorBody;
    assert.equal(body.error.code.startsWith("sheets_"), true);
    assert.equal(text.includes(TEST_SECRET), false);
    assert.equal(text.includes("upstream says"), false);
  }
});

test("missing Sheets configuration fails closed", async () => {
  const kv = new MemoryKV();
  const env = makeEnv(kv, { SHEETS_API_KEY: "" });
  const response = await handleRequest(apiRequest("/api/meta"), env, sheetsFetch(VALUES));

  assert.equal(response.status, 500);
  const body = (await response.json()) as ErrorBody;
  assert.equal(body.error.code, "sheets_not_configured");
});

test("/api/health reports whether a snapshot is cached", async () => {
  const kv = new MemoryKV();
  const empty = await handleRequest(apiRequest("/api/health"), makeEnv(kv));
  assert.deepEqual(await empty.json(), { ok: true, cached: false, updatedAt: null });

  const snapshot = await primeSnapshot(kv);
  const cached = await handleRequest(apiRequest("/api/health"), makeEnv(kv));
  assert.deepEqual(await cached.json(), {
    ok: true,
    cached: true,
    updatedAt: snapshot.updatedAt,
  });
});

test("/api/ask is disabled without GEMINI_API_KEY", async () => {
  const kv = new MemoryKV();
  const response = await handleRequest(apiRequest("/api/ask?q=hoc+phi"), makeEnv(kv));

  assert.equal(response.status, 503);
  const body = (await response.json()) as ErrorBody;
  assert.equal(body.error.code, "llm_not_configured");
  assert.equal(kv.putCalls, 0);
});

test("/api/ask rejects an empty query", async () => {
  const kv = new MemoryKV();
  const response = await handleRequest(
    apiRequest("/api/ask?q="),
    makeEnv(kv, { GEMINI_API_KEY: "gemini-test-key" }),
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as ErrorBody;
  assert.equal(body.error.code, "invalid_query");
});

test("/api/ask feeds only published items to Gemini and returns its sources", async () => {
  const kv = new MemoryKV();
  await primeSnapshot(kv);
  const env = makeEnv(kv, { GEMINI_API_KEY: "gemini-test-key" });

  const captured: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    captured.push({ url, body: String(init?.body ?? "") });
    const text = JSON.stringify({
      answer: "Bảng phí sẽ được gửi vào tháng 12.",
      citedIds: ["bv-whatever"],
    });
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text }] } }],
        modelVersion: "gemini-2.5-flash",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const response = await handleRequest(apiRequest("/api/ask?q=phi+quan+ly"), env, fetchImpl);

  assert.equal(response.status, 200);
  assert.equal(captured.length, 1);
  const promptBody = captured[0]?.body ?? "";
  assert.equal(promptBody.includes("Câu nháp nội bộ"), false);
  assert.equal(promptBody.includes("Thông tin nội bộ"), false);
  assert.ok(promptBody.includes("Phí quản lý năm 2027 là bao nhiêu?"));

  const body = (await response.json()) as {
    answer: string;
    sources: Array<{ id: string; question: string; category: string }>;
    model: string;
  };
  assert.equal(body.answer, "Bảng phí sẽ được gửi vào tháng 12.");
  assert.equal(body.model, "gemini-2.5-flash");
  // The cited id was not one of the retrieved ids, so it cannot become a source.
  assert.deepEqual(body.sources, []);
});

test("non-GET API requests are rejected", async () => {
  const kv = new MemoryKV();
  const response = await handleRequest(apiRequest("/api/qa", "POST"), makeEnv(kv));
  assert.equal(response.status, 405);
  const body = (await response.json()) as ErrorBody;
  assert.equal(body.error.code, "method_not_allowed");
});

test("unknown API routes return a JSON 404", async () => {
  const kv = new MemoryKV();
  const response = await handleRequest(apiRequest("/api/nope"), makeEnv(kv));
  assert.equal(response.status, 404);
  const body = (await response.json()) as ErrorBody;
  assert.equal(body.error.code, "not_found");
});

test("non-API requests fall through to static assets when bound", async () => {
  const kv = new MemoryKV();
  let assetRequests = 0;
  const assets = {
    fetch: async () => {
      assetRequests += 1;
      return new Response("<html>ok</html>", { headers: { "content-type": "text/html" } });
    },
  } as unknown as Fetcher;

  const response = await handleRequest(
    apiRequest("/"),
    makeEnv(kv, { ASSETS: assets }),
    sheetsFetch(VALUES),
  );

  assert.equal(response.status, 200);
  assert.equal(assetRequests, 1);
});
