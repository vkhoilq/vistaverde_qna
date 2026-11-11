# AGENTS.md

Public Q&A site for residents of **Chung cư Vista Verde** (Ho Chi Minh City).
Content lives in a Google Sheet that building staff edit directly; the site reads it and
serves an anonymous, read-only JSON API + static frontend from one Cloudflare Worker.

Full operational guide: `README.md`. Sheet contract: `docs/SHEET_SETUP.md`.

## Commands

```bash
npm install
npm test            # node --test "test/**/*.test.ts"  (no network needed)
npm run typecheck   # tsc --noEmit
npm run dev         # wrangler dev, :8787
npm run deploy      # wrangler deploy
```

Single test file: `node --test test/search.test.ts`. Single suite by name:
`node --test --test-name-pattern="folds diacritics" test/`.

**Use the quoted glob, not the directory form.** `node --test test/` fails on Node 24 with
`Cannot find module '.../test'` (it tries to *run* the path) while working on Node 26. The
quoted glob `node --test "test/**/*.test.ts"` works on both, and Node handles the glob itself
rather than the shell — so it survives any shell. CI runs Node 24; local is Node 26.

End-to-end (no Sheets API key needed — seeds a local KV snapshot):

```bash
npm run seed                                                       # 1. write KV snapshot
npx wrangler dev --port 8787 --local --persist-to .wrangler/state   # 2. terminal 1
npm run smoke                                                      # 3. terminal 2
```

**Order matters:** seed *before* starting dev. The Worker caches the snapshot in isolate
memory for 60s, so a key written while the server is running is not picked up immediately.

Against the real sheet: `SHEETS_API_KEY=... SPREADSHEET_ID=... npm run check:sheet`.

**Order matters before you call it done:** `npm test` → `npm run typecheck` →
`npx wrangler deploy --dry-run --outdir dist-check`. All three green, or it is not done.

### `compatibility_date` is capped at 2026-10-08 — do not bump it

The installed `wrangler` is **4.147.0**, whose bundled `workerd` only supports compatibility
dates up to **2026-10-08**. A newer date (e.g. `2026-11-11`) passes `--dry-run` but makes
`npm run dev` **fail to start**:

```
ERROR  service core:user:<name>: This Worker requires compatibility date "2026-11-11",
but the newest date supported by this server binary is "2026-10-08".
```

`wrangler.jsonc` pins `2026-10-08` for this reason. If you need a newer runtime, upgrade
wrangler (`npm i -D wrangler@latest`) **and** bump the date in the same change — never the
date alone. Nothing this project uses needs a date newer than 2026-10-08.

Note `--dry-run` does **not** start the runtime, so it will not catch this. Only
`npm run dev` does.

## Architecture

```
Google Sheet ──(Sheets API, API key)──▶ Worker ──▶ KV snapshot (refreshed ≤30 min)
                                            ├──▶ /api/qa, /api/meta, /api/ask
                                            └──▶ /public/*  (static assets)
```

- `src/sheets.ts` — fetch + parse the sheet. `src/search.ts` — Vietnamese tokenize/score.
  `src/dates.ts` — sheet-date parsing. `src/llm.ts` — optional Gemini endpoint.
  `src/worker.ts` — routing + KV cache. `src/errors.ts` — `AppError` (code + HTTP status).
- `public/` — plain HTML/CSS/JS, **no build step, no framework, no CDN**. Do not add one.
- `test/` — `node --test` unit tests. `scripts/check-sheet.ts` — validates a live sheet.
  `scripts/smoke.ts` — end-to-end HTTP test against a running Worker.
- Frontend and API are one Worker. Deploy once; there is no second service.

## The Google Sheet is the CMS — these rules are load-bearing

**Real workbook layout** (verified against the live sheet): the header row is **row 5**, data
starts at **column B**, and there are four tabs (`QnA Log`, `Sample QnA Log`, `Categories`,
`Hướng Dẫn sử dụng`). Hence `SHEETS_RANGE = "'Sample QnA Log'!B5:H"` — switch the tab name to
`QnA Log` for production; both log tabs share the same layout.

Columns: `Mã câu hỏi`/`Id` (ignored, it's a formula), `Câu hỏi`, `Câu trả lời`, `Người hỏi`,
`Người trả lời`, `Ngày hỏi`, `Danh mục`.

- **`Người hỏi` / `Người trả lời` are published** (owner's decision) — they map to `asker` and
  `responder` and are displayed on each card. They are deliberately **not** part of the search
  index, so searching a resident's name does not surface that person's questions. The sheet
  itself is link-shared, so these names were already public via the sheet before this change.
- **A row is published only when it has a question AND an answer.** A blank answer means
  "pending" and stays off the site — this matches the sheet's own "Chờ xử lý" counter. An
  explicitly set status (`published`/`yes`/`true`/`1`/`có`) overrides that. Explicit drafts
  (`draft`/`no`/`false`/`0`/`ẩn`) are always excluded.
- **Dates are real date cells formatted `yyyy-mm-dd`**, so the API returns ISO text. Keep that
  format; a reformatted cell yields ambiguous locale text (`01/11/2026`). `DD/MM/YYYY` is
  accepted as a fallback.
- **`values` may be absent entirely** when the sheet is empty → treat as `[]`.
- **Rows are ragged** — missing trailing cells are `undefined`, not `""`. Always
  `row[i] ?? ""`.
- **Trailing empty rows/columns are omitted**; interior blanks are `""`.
- `values[0]` is the header row, because the range starts at row 5. `majorDimension` stays `ROWS`.
- **Do not insert rows above row 5** — the range is positional. Do not merge cells or add
  filler rows below the data.
- **There is no `id` column that we use.** Ids are derived:
  `"bv-" + sha256(category + "|" + question).slice(0,6)`. The sheet's own `Mã câu hỏi` column
  is a formula and is ignored.

Never put the API key in the repo. It is a Worker secret (`wrangler secret put SHEETS_API_KEY`).

## Vietnamese search — the part that is easy to get wrong

Vietnamese is written without spaces between syllables, so whitespace splitting fails.

- Fold diacritics: `s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()`.
  `hoc phi` must find `học phí`.
- Segment with `Intl.Segmenter("vi", { granularity: "word" })` — available in Node and
  Workers, verified working. Fall back to character bigrams when segmentation yields nothing.
- **Verified in the actual Workers runtime** (not just Node): `Intl.Segmenter` with locale
  `"vi"` works, `NFD` folding works, and `crypto.subtle.digest("SHA-256", …)` works — so the
  id derivation needs no polyfill and no `node:crypto` import.
- Field weights: question ×3, keywords ×2, answer ×1. Substring match gets a bonus.
- **Precompute folded/segmented tokens at snapshot time and store them in the KV snapshot.**
  Do not re-normalize every row per request — Workers free plan allows only **10 ms CPU per
  request**. Measured: ~15 ms to index 1000 rows once, ~0.5 ms per query over them.
- Date filtering is **lexical string comparison** on `YYYY-MM-DD`. Do not parse `Date`.

## Quotas and caching — why the Worker exists

- Sheets API: **300 reads/min/project, 60 reads/min/user**. An API key counts as ONE user,
  so **60/min is the real ceiling**. Never read the sheet on the request path.
- Serve from **Workers KV** (`QACACHE`, key `qa:snapshot`); refresh only if older than
  60 minutes. A 30-minute cron also refreshes proactively.
- KV free tier: **1000 writes/day**. A 30-minute cron is ~48/day. **Do not write KV per
  request.**
- **After changing the snapshot shape, the served data is stale.** Both the KV snapshot and
  the 60-second isolate cache hold the *old* JSON, so a newly added field comes back empty
  even though the code is correct. Force a refresh:
  ```bash
  npx wrangler kv key delete --binding QACACHE --remote "qa:snapshot"
  ```
  then wait ~60 s for the isolate cache to expire before checking. Do this after any change
  to `QAItem` or the parser output.
- An API key can only read a sheet shared **"Anyone with the link" → Viewer**. The sheet is
  public by link because the content is public; the *key* is what must stay protected.
  **API restriction → Google Sheets API only.** Do **not** add an *HTTP referrer* application
  restriction: the Worker calls the API server-side with no `Referer`, so Google rejects every
  request with `Requests from referer <empty> are blocked`. Application restrictions stay on
  **None**; the key's safety comes from being a Worker secret.
- The Sheets API **does** send `Access-Control-Allow-Origin` (verified live), so a
  no-backend static site is technically possible — but it would leak the key to page source
  and let every visitor burn the shared quota. Keep the Worker.

## Node runs the `.ts` files directly — type-stripping constraints

`node --test` executes TypeScript via native type stripping. Violating these **breaks the
test run**, so:

- Relative imports **must** carry the `.ts` extension: `import { fold } from "../src/search.ts";`
- **No `enum`, `namespace`, parameter properties, or decorators** — only erasable syntax.
- Type-only imports must use `import type { … }`.
- `tsconfig.json` sets `allowImportingTsExtensions`, `noEmit`, `verbatimModuleSyntax`.
- Node's test runner is the only test framework. No Jest/Vitest.

## The LLM endpoint is optional and off by default

`GET /api/ask` returns `503 llm_not_configured` until `GEMINI_API_KEY` is set.

- Retrieval stays **deterministic** (`src/search.ts`); the LLM only answers from the items
  it retrieved and cites them. It must never introduce a Q&A that is not in the sheet, and
  draft items must never reach it.
- Tests use a **mocked `fetch`** — there is no live key in this environment.
- Do not add an LLM SDK dependency; plain `fetch` is the whole integration.
- **Do not turn it on speculatively.** For a few hundred to a few thousand rows the lexical
  search already handles most queries, because residents search for terms that appear in the
  question. Enable it when you have observed a recall gap.
- Free-tier caveat: AI Studio free tier sends request content to Google for product
  improvement.

## Conventions

- `strict` TypeScript, no `any`. Money/percent never — this is Q&A text.
- Keep the sheet parsing and the search logic in **pure functions** so they are testable
  without network or Worker globals.
- The API returns `{ "error": { "code", "message" } }` on errors. Never leak the API key,
  a service-account credential, or a raw upstream body to the client.
- UI copy is **Vietnamese**. Do not "improve" wording; the strings in `public/` are final.
- Interface language is Vietnamese; answers are stored verbatim in the sheet, so do not
  translate or rewrite them server-side.
- Draft/empty/loading/error states must all be handled — a failed `/api/qa` shows a
  Vietnamese error with a retry button, never a blank page.

## Scope boundaries

- **Do not** add auth, user accounts, comments, ratings, or a write path. The sheet is the
  CMS; staff edit there. Adding a write endpoint would need a service account and changes
  the threat model — that is a decision for the owner, not a detail.
- **Do not** add a second tab to the API or a second deploy target without asking.
- `docs/SHEET_SETUP.md` is the contract with the editors. Changing column names, date
  format, or the draft convention means updating that file **and** `src/sheets.ts` together.

## Verifying against the real API

The live workbook is `1RRbOuo9NwcdWCBE4Uwo5BqNVBuvycT_cAHJEn0AgHEI`; the sheet is link-shared
(Viewer), so it can be read without credentials for **inspection only**:

```bash
curl -sL "https://docs.google.com/spreadsheets/d/<ID>/export?format=xlsx" -o /tmp/wb.xlsx
# then read it with openpyxl (installed) — dates are yyyy-mm-dd formatted cells
```

Notes that save time:

- `/export?format=csv` returns the **first tab only**; `&gid=<n>` returns **400** for this
  workbook. Use the xlsx export to reach a specific tab.
- `gviz/tq?...&gid=<n>` works keyless and sends CORS, but `&sheet=<name>` is ignored — it only
  accepts a numeric `gid`. That would duplicate the tab/range config, so the Worker does not
  use it.
- The **Worker** path still needs `SHEETS_API_KEY`; without it `/api/qa` returns 500
  `sheets_not_configured`. For local verification use `npm run seed` instead (see Commands).

### Creating the API key is blocked on this machine

`gcloud` cannot mint a key here: the active project (`gen-lang-client-0798841705`) has the
**Service Usage API disabled**, so `gcloud services enable` and `gcloud services api-keys
create` both fail, and the API Keys API is off too. The key must be created once in the
console (APIs & Services → Credentials). Do not burn time retrying the gcloud route.
