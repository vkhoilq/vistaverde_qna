/**
 * Cloudflare Worker: static assets + read-only JSON API.
 *
 * Caching strategy:
 *  - KV key `qa:snapshot` is the shared source of truth across PoPs.
 *  - Requests are served from KV whenever the snapshot is < 60 minutes old.
 *  - A 30-minute cron refreshes it proactively, so a visitor rarely waits.
 *  - KV is never written per request.
 *  - A short-lived per-isolate memory cache avoids repeated KV reads.
 */

import { AppError } from "./errors.ts";
import { answerQuestion, GEMINI_MODEL, NO_ANSWER_TEXT } from "./llm.ts";
import { buildItemIndex, parseQueryParams, runQuery } from "./search.ts";
import { createSnapshot, fetchSheetValues } from "./sheets.ts";
import type { Env, Snapshot } from "./types.ts";

const SNAPSHOT_KEY = "qa:snapshot";
const SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1000;
const MEMORY_TTL_MS = 60 * 1000;
const DEFAULT_RANGE = "Q&A!A:G";

interface MemoryEntry {
  key: string;
  snapshot: Snapshot;
  expires: number;
}

let memory: MemoryEntry | null = null;

/** Test hook: clear the per-isolate memory cache. */
export function __resetSnapshotMemory(): void {
  memory = null;
}

function configKey(env: Env): string {
  return `${env.SPREADSHEET_ID ?? ""}|${resolveRange(env)}`;
}

function resolveRange(env: Env): string {
  return (env.SHEETS_RANGE ?? "").trim() || DEFAULT_RANGE;
}

function remember(key: string, snapshot: Snapshot): void {
  memory = { key, snapshot, expires: Date.now() + MEMORY_TTL_MS };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function isSnapshot(value: unknown): value is Snapshot {
  const record = asRecord(value);
  if (!record) return false;
  return (
    typeof record.fetchedAt === "string" &&
    typeof record.updatedAt === "string" &&
    typeof record.sheetRange === "string" &&
    Array.isArray(record.items) &&
    Array.isArray(record.categories)
  );
}

/** Rebuild indexes if an older snapshot in KV lacks them. */
function ensureIndexes(snapshot: Snapshot): Snapshot {
  let changed = false;
  const items = snapshot.items.map((item) => {
    const index = asRecord(asRecord(item)?.index);
    const valid =
      index !== null &&
      asRecord(index.question) !== null &&
      asRecord(index.keywords) !== null &&
      asRecord(index.answer) !== null &&
      Array.isArray(asRecord(index.question)?.words);
    if (valid) return item;
    changed = true;
    return {
      ...item,
      index: buildItemIndex(item.question, item.answer, item.keywords),
    };
  });
  return changed ? { ...snapshot, items } : snapshot;
}

async function readCachedSnapshot(env: Env): Promise<Snapshot | null> {
  try {
    const raw = await env.QACACHE.get(SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isSnapshot(parsed)) return null;
    return ensureIndexes(parsed);
  } catch {
    return null;
  }
}

async function writeSnapshot(env: Env, snapshot: Snapshot): Promise<void> {
  try {
    await env.QACACHE.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.error(
      "Failed to write the Q&A snapshot to KV:",
      error instanceof Error ? error.message : "unknown error",
    );
  }
}

export interface LoadedSnapshot {
  snapshot: Snapshot;
  source: "sheets" | "cache";
}

/**
 * Return the current snapshot. A KV hit younger than 60 minutes short-circuits
 * the Sheets call; a KV miss fetches synchronously and writes KV once.
 */
export async function loadSnapshot(
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<LoadedSnapshot> {
  const key = configKey(env);
  const now = Date.now();

  if (memory && memory.key === key && memory.expires > now) {
    return { snapshot: memory.snapshot, source: "cache" };
  }

  const cached = await readCachedSnapshot(env);
  if (cached) {
    const age = now - Date.parse(cached.fetchedAt);
    if (Number.isFinite(age) && age >= 0 && age < SNAPSHOT_MAX_AGE_MS) {
      remember(key, cached);
      return { snapshot: cached, source: "cache" };
    }
  }

  try {
    const values = await fetchSheetValues(env, fetchImpl);
    const snapshot = await createSnapshot(values, { sheetRange: resolveRange(env) });
    await writeSnapshot(env, snapshot);
    remember(key, snapshot);
    return { snapshot, source: "sheets" };
  } catch (error) {
    // A stale snapshot is better than an error page.
    if (cached) {
      remember(key, cached);
      return { snapshot: cached, source: "cache" };
    }
    throw error;
  }
}

/** Force a refresh (cron). Never writes more than once per invocation. */
export async function refreshSnapshot(
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Snapshot> {
  const values = await fetchSheetValues(env, fetchImpl);
  const snapshot = await createSnapshot(values, { sheetRange: resolveRange(env) });
  await writeSnapshot(env, snapshot);
  remember(configKey(env), snapshot);
  return snapshot;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  console.error(
    "Unhandled worker error:",
    error instanceof Error ? error.message : "unknown error",
  );
  return json(
    { error: { code: "internal_error", message: "Something went wrong. Please try again." } },
    500,
  );
}

function normalizePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
}

async function handleQa(env: Env, url: URL, fetchImpl: typeof fetch): Promise<Response> {
  const query = parseQueryParams(url.searchParams);
  const { snapshot } = await loadSnapshot(env, fetchImpl);
  const result = runQuery(snapshot.items, query);
  return json({
    updatedAt: snapshot.updatedAt,
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    categories: snapshot.categories,
    items: result.items,
  });
}

async function handleMeta(env: Env, fetchImpl: typeof fetch): Promise<Response> {
  const { snapshot, source } = await loadSnapshot(env, fetchImpl);
  return json({
    updatedAt: snapshot.updatedAt,
    total: snapshot.items.length,
    categories: snapshot.categories,
    source,
    sheetRange: snapshot.sheetRange || resolveRange(env),
  });
}

async function handleHealth(env: Env): Promise<Response> {
  const cached = await readCachedSnapshot(env);
  return json({
    ok: true,
    cached: cached !== null,
    updatedAt: cached ? cached.updatedAt : null,
  });
}

async function handleAsk(env: Env, url: URL, fetchImpl: typeof fetch): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) {
    return json(
      { error: { code: "invalid_query", message: "Provide a non-empty q parameter." } },
      400,
    );
  }

  const apiKey = (env.GEMINI_API_KEY ?? "").trim();
  if (!apiKey) {
    return json(
      {
        error: {
          code: "llm_not_configured",
          message: "The language model endpoint is not configured on this deployment.",
        },
      },
      503,
    );
  }

  const { snapshot } = await loadSnapshot(env, fetchImpl);
  const retrieval = runQuery(snapshot.items, {
    q,
    category: "",
    from: "",
    to: "",
    limit: 8,
    offset: 0,
  });

  if (retrieval.items.length === 0) {
    return json({ answer: NO_ANSWER_TEXT, sources: [], model: GEMINI_MODEL });
  }

  const result = await answerQuestion(q, retrieval.items, env, fetchImpl);
  return json(result);
}

/** Route a request. Exported for tests; `fetch` below is the Worker entrypoint. */
export async function handleRequest(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);

  if (path.startsWith("/api/")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(
        { error: { code: "method_not_allowed", message: "Only GET is supported." } },
        405,
      );
    }

    try {
      if (path === "/api/qa") return await handleQa(env, url, fetchImpl);
      if (path === "/api/meta") return await handleMeta(env, fetchImpl);
      if (path === "/api/health") return await handleHealth(env);
      if (path === "/api/ask") return await handleAsk(env, url, fetchImpl);
      return json({ error: { code: "not_found", message: "Unknown API endpoint." } }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (env.ASSETS) {
    return env.ASSETS.fetch(request);
  }
  return json({ error: { code: "not_found", message: "Not found." } }, 404);
}

const worker = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env);
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      refreshSnapshot(env).then(
        () => undefined,
        (error: unknown) => {
          console.error(
            "Scheduled snapshot refresh failed:",
            error instanceof Error ? error.message : "unknown error",
          );
        },
      ),
    );
  },
};

export default worker;
