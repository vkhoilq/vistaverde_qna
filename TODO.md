# TODO

Outstanding work for [Vista Verde Q&A](https://qna.vistaverde.top).

The sheet contract is in [`docs/SHEET_SETUP.md`](docs/SHEET_SETUP.md); the operational guide
(including the **manual sync** procedure) is in [`README.md`](README.md); hard-won gotchas are
in [`AGENTS.md`](AGENTS.md).

---

## 1. Page size is too large for phones

**What:** `public/app.js:4` — `const DEFAULT_LIMIT = 50;` → change to `20`.

**Why:** 50 cards is a very long scroll on a phone before `Xem thêm` ever appears. With 20 the
button shows up sooner and each tap is a reasonable chunk.

**Note:** the backend has its own limits that are *not* the page size and should not be
changed for this — `src/search.ts:271` (server-side default) and `src/search.ts:272` (hard
clamp of 200). The frontend always sends an explicit `?limit=`, so changing the server
default would have no effect.

**Verify:** `npm run dev`, load the site, search for something broad, click `Xem thêm`, and
confirm the next page appends rather than replaces.

---

## 2. The load-more path is never exercised by the test suite

**What:** add a smoke check that drives the pagination path end to end.

**Why:** with 5 questions and a page size of 20, `Xem thêm` never renders, so the append
logic, the offset arithmetic and the hide-when-exhausted behaviour have never actually run.
The first real use will be with real content, in front of a resident.

**How:** in `scripts/seed.ts`, add enough fixture rows to exceed the page size, then in
`scripts/smoke.ts` assert that `?limit=N&offset=N` returns the expected slice and that
`total` stays the full match count.

---

## 3. No Content-Security-Policy or other security headers

**What:** add `public/_headers` with a CSP and the usual hardening headers.

**Why:** the frontend renders everything through `textContent`, so the XSS risk from sheet
content is already very low — but a CSP is cheap defence in depth, and it is the only
response header currently being set.

**How:** `_headers` is supported by Workers Static Assets (confirmed in the Cloudflare
docs); put it in `public/`. A reasonable starting policy for this app:

```
/*
  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
```

Note `script-src 'self'` is safe here — `app.js` is a plain module with no inline script and
no third-party assets.

**Verify:** `curl -sI https://qna.vistaverde.top/ | grep -i content-security` after deploy,
then confirm the page still loads with no CSP violations in the console.

---

## 4. `wrangler` is not pinned — it only works on this machine

**What:** add `wrangler` to `devDependencies`.

**Why:** `wrangler` is currently a global Homebrew install, so `npm run dev` and
`npm run deploy` fail on a fresh clone or in CI. It is also the direct cause of the
`compatibility_date` ceiling below — a floating global version is what capped the runtime.

**How:** `npm i -D wrangler@^4` and pin the version. Then revisit `compatibility_date`:
it is currently `2026-10-08` in `wrangler.jsonc` because wrangler 4.147.0's bundled `workerd`
refuses anything newer. Once the version is pinned you can bump the date deliberately (and
the `workerd` cap moves with the pinned wrangler), or leave it — nothing here needs a
newer date.

---

## 5. Rate-limit `/api/ask` **before** enabling the LLM

**What:** add a rate limit to the `/api/ask` endpoint.

**Why:** it is an unauthenticated public endpoint. With `GEMINI_API_KEY` set it becomes an
open proxy onto your Gemini quota — anyone who finds the URL can spend it. The endpoint is
currently safely `503 llm_not_configured`, so this only matters if the LLM is turned on.

**How:** either Cloudflare rate-limiting rules on the zone, or a KV counter in the Worker
(keyed by IP, with a TTL window). KV is fine here because `/api/ask` traffic would be near
zero — the KV free tier allows 1000 writes/day.

**Verify:** hammer the endpoint from a script and confirm it starts returning `429` before
the quota is at risk.

---

## 6. Enable the LLM — only if you actually need it

**What:** `npx wrangler secret put GEMINI_API_KEY`, then use `/api/ask`.

**Why maybe not:** the deterministic Vietnamese search already handles most queries, because
residents search for terms that appear in the question. Turn the LLM on if you *observe*
queries that keyword search misses — not speculatively. Retrieval stays deterministic; the
model only answers from the items it retrieved and cites them.

**Caveat:** the AI Studio free tier sends request content to Google for product improvement.
That includes building Q&A content. If that matters, leave it off.

**Verify:** `curl -s "https://qna.vistaverde.top/api/ask?q=phi%20quan%20ly"` — the answer
should cite only ids that exist in the sheet.

---

## 7. Switch to the real sheet

**What:** `wrangler.jsonc` → `"SHEETS_RANGE": "'QnA Log'!B5:H"` (from
`"'Sample QnA Log'!B5:H"`), then redeploy and run the manual sync.

**Why:** the site currently reads the *test* tab. Both tabs share the same layout, so only
the tab name changes — column B differs (`Mã câu hỏi` vs `Id`) and both are ignored.

**Verify:** `curl -s https://qna.vistaverde.top/api/meta` — `sheetRange` should read
`'QnA Log'!B5:H` and `total` should match the real content.

---

## 8. The whole workbook is publicly readable

**What:** consider moving the public log into its own spreadsheet.

**Why:** the sheet is shared "Anyone with the link" → Viewer because that is what an API key
can read. That exposes **every tab** — `Người hỏi`, `Người trả lời`, and anything else in
the file — to anyone with the URL. The site only ever serves the columns it recognises, but
the sheet itself does expose them. A dedicated workbook for the public log keeps the blast
radius to just the Q&A.

**Note:** a service account could read a private sheet instead, but that means a JSON key to
manage and rotate — heavier than the problem warrants for public Q&A.

---

## 9. Optional: a one-command sync

**What:** add `npm run sync` — a script that deletes the KV key and then polls
`/api/meta` until `source` becomes `"sheets"`, printing the new count.

**Why:** the documented flow is three commands and a wait, and you have to know to look at
`source` to confirm it landed. A script makes it one command with a clear result.

**How:** `scripts/sync.ts` using `wrangler kv key delete --remote` plus a poll loop. No new
secret — it reuses the existing `wrangler login`.

---

## 10. Optional: add a `Từ khóa` (keywords) column to the sheet

**What:** add a `Từ khóa` column and populate it with synonyms and phrasings that do not
appear in the question.

**Why:** the parser and the search index **already support keywords** — they are indexed with
weight ×2, between question (×3) and answer (×1). The sheet simply has no such column
today, so the feature is dormant. Good candidates: `phí dịch vụ`, `học phí quản lý`,
`thang máy`, `elevator`.

**How:** add the column to the sheet, fill a few rows, then run the manual sync.

**Verify:** `curl -s "https://qna.vistaverde.top/api/qa?q=elevator"` should match the
elevator question through the keywords column.

---

## 11. Minor: pagination is not deep-linkable

**What:** consider adding `offset` to the URL sync.

**Why:** the URL currently stores `q`, `category`, `from` and `to` but not `offset`, so a
resident who has scrolled through 150 results and reloads the page starts again at the
first page. Low impact for a FAQ, but it is the one gap in the shareable-link behaviour.

---

## 12. Minor: offset drift if a sync happens mid-scroll

**What:** nothing to do unless it is observed.

**Why:** pagination is offset-based, so if a manual sync inserts or removes a row while
someone is paging, they could see one question twice or miss one. Only possible during a
manual sync, and harmless at this scale. Cursor-based pagination would fix it but adds
state to the snapshot.
