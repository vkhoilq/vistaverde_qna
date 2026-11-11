/**
 * End-to-end smoke test against a locally-running Worker.
 *
 * Prerequisites:
 *   1. npm run seed      # writes the KV snapshot (must happen before dev starts)
 *   2. npm run dev       # serves the Worker on :8787
 *   3. npm run smoke     # this file
 *
 * It exercises the real HTTP surface: /api/qa, /api/meta, /api/health, /api/ask
 * (must be 503 without GEMINI_API_KEY) and the static frontend.
 */

export {}; // marks this file as a module so top-level await is allowed

const portFlag = process.argv.indexOf("--port");
const PORT = portFlag >= 0 ? (process.argv[portFlag + 1] ?? "8787") : "8787";
const BASE = `http://127.0.0.1:${PORT}`;

const EXPECTED_PUBLISHED = 3;
const EXPECTED_CATEGORIES = 2;

interface QaItem {
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

interface QaResponse {
  updatedAt: string;
  total: number;
  limit: number;
  offset: number;
  categories: string[];
  items: QaItem[];
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  return (await response.json()) as T;
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const has = (items: QaItem[], needle: string): boolean =>
  items.some((item) => item.question.includes(needle));

console.log("— API surface —");

const health = await getJson<{ ok: boolean; cached: boolean; updatedAt: string | null }>(
  "/api/health",
);
check("/api/health responds", health?.ok === true, JSON.stringify(health));

const meta = await getJson<{ total: number; categories: string[] }>("/api/meta");
check("/api/meta reports the seeded snapshot", meta?.total === EXPECTED_PUBLISHED, `total=${meta?.total}`);

const all = await getJson<QaResponse>("/api/qa");
check("/api/qa returns items", all?.total === EXPECTED_PUBLISHED, `n=${all?.items?.length}`);
check("draft item is excluded", !has(all?.items ?? [], "nội bộ"));
check("pending item (blank answer) is excluded", !has(all?.items ?? [], "đang chờ"));
check("ragged row (question + answer only) is published", has(all?.items ?? [], "Hồ bơi"));
check(
  "categories are distinct + sorted",
  all?.categories?.length === EXPECTED_CATEGORIES,
  JSON.stringify(all?.categories),
);

const fee = (all?.items ?? []).find((item) => item.question.includes("Phí quản lý"));
check(
  "asker and responder are published",
  fee?.asker === "Lan Trần" && fee?.responder === "Bộ phận Kế toán",
  `${fee?.asker} / ${fee?.responder}`,
);
check(
  "the draft's asker is not published",
  !JSON.stringify(all).includes("Bí Thương"),
);

const accentless = await getJson<QaResponse>("/api/qa?q=phi%20quan%20ly");
check(
  "accentless query finds the accented question",
  accentless?.items?.[0]?.question?.includes("Phí quản lý") === true,
  `total=${accentless?.total}`,
);

const nonsense = await getJson<QaResponse>("/api/qa?q=khong%20co%20gi");
check("a nonsense query matches nothing", nonsense?.total === 0, `total=${nonsense?.total}`);

const byCat = await getJson<QaResponse>("/api/qa?category=B%E1%BA%A3o%20tr%C3%AC");
check(
  "category filter works",
  byCat?.total === 1 && byCat.items[0]?.category === "Bảo trì",
  `total=${byCat?.total}`,
);

const byDate = await getJson<QaResponse>("/api/qa?from=2026-10-02&to=2026-10-02");
check("date range filter is inclusive", byDate?.total === 1, `total=${byDate?.total}`);

const paged = await getJson<QaResponse>("/api/qa?limit=1&offset=1");
check(
  "pagination returns a limit-sized page",
  paged?.items?.length === 1 && paged?.total === EXPECTED_PUBLISHED,
);

const ask = await fetch(`${BASE}/api/ask?q=phi%20quan%20ly`);
check("/api/ask is 503 without GEMINI_API_KEY", ask.status === 503, `status=${ask.status}`);
const askBody = (await ask.json()) as { error?: { code?: string } };
check(
  "/api/ask error code is llm_not_configured",
  askBody?.error?.code === "llm_not_configured",
  JSON.stringify(askBody),
);

const post = await fetch(`${BASE}/api/qa`, { method: "POST" });
check("non-GET API requests are rejected", post.status === 405, `status=${post.status}`);

console.log("\n— Static frontend —");
const index = await fetch(`${BASE}/`).then((r) => r.text());
check("/ serves the frontend", index.includes("Hỏi đáp Cư dân"));
check("/ declares lang=vi", index.includes('lang="vi"'));
check("/styles.css is served", (await fetch(`${BASE}/styles.css`)).ok);
check("/app.js is served", (await fetch(`${BASE}/app.js`)).ok);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
