# Vista Verde Q&A

Public Q&A site for residents of **Chung cư Vista Verde** (Ho Chi Minh City).

- **Content source of truth:** a Google Sheet that building staff edit directly.
- **Frontend:** static HTML/CSS/JS, served by the same Cloudflare Worker as the API.
- **Search:** Vietnamese-aware (diacritic folding + syllable segmentation), no LLM required.
- **Auth:** none. The site is anonymous and read-only; there is no login, ever.
- **Cost:** $0 on the Cloudflare free tier, well within limits.

See [`docs/SHEET_SETUP.md`](docs/SHEET_SETUP.md) for the sheet contract — read it before
touching anything, the column and date conventions are load-bearing.

## Architecture

```
Google Sheet  ──(Sheets API, API key, 60 reads/min cap)──▶  Cloudflare Worker
                                                                │
                                                   KV snapshot (refreshed ≤30 min)
                                                                │
                                          ┌─────────────────────┴─────────────────────┐
                                          │                                           │
                                   /api/qa, /api/meta                    /public/*  (static assets)
                                          │                                           │
                                          └──────────────▶ browser ──────────────────┘
                                                             Vietnamese BM25-style search
```

The Worker fetches the sheet, caches a normalized snapshot in **Workers KV**, and serves
both the JSON API and the static frontend from a single deployment.

**Why a Worker at all** — a plain static page *can* call the Sheets API directly (the API
does send `Access-Control-Allow-Origin`). But the API key would be visible in page source,
every visitor would burn the shared 60-reads/min quota independently, and there would be no
place to put the LLM call later. The Worker costs nothing and fixes all three.

**Why KV** — the Sheets API read quota is 60/min/user, and an API key counts as a single
"user". Serving from cache means the sheet is read roughly every 30 minutes instead of
on every request, so quota is a non-issue and the site stays fast.

## Layout

| Path | What |
|---|---|
| `src/worker.ts` | Worker entrypoint — routing, KV cache, Sheets fetch |
| `src/sheets.ts` | Sheet fetch + parsing (header-name mapping, dates, status, drafts) |
| `src/search.ts` | Vietnamese tokenization, folding, scoring, filtering |
| `src/dates.ts` | Sheet-date parsing (`YYYY-MM-DD`, `DD/MM/YYYY` fallback) |
| `src/llm.ts` | Optional Gemini-backed `/api/ask` (off unless `GEMINI_API_KEY` is set) |
| `public/` | Static frontend (no build step, no dependencies) |
| `test/` | `node --test` unit tests (58) |
| `scripts/check-sheet.ts` | Validate a live sheet against the parsing contract |
| `scripts/smoke.ts` | End-to-end HTTP test against a running Worker |
| `docs/SHEET_SETUP.md` | The sheet contract |

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/qa?q=&category=&from=&to=&limit=&offset=` | Search + filter Q&A |
| `GET /api/meta` | Counts, categories, last-sync time |
| `GET /api/health` | Liveness + cache state |
| `GET /api/ask?q=` | Optional natural-language answer (needs `GEMINI_API_KEY`) |

Only **published** items are ever returned. Drafts are excluded from every endpoint,
including the LLM path.

## Local development

```bash
npm install
npm test                       # node --test, no network
npm run typecheck              # tsc --noEmit
npm run dev                    # wrangler dev on :8787
```

Local secrets go in `.dev.vars` (gitignored), same keys as production:

```
SHEETS_API_KEY=...
GEMINI_API_KEY=...             # optional
```

## Deploy

```bash
# 1. one-time: the Sheets API key (never in the repo)
npx wrangler secret put SHEETS_API_KEY

# 2. optional: enable the LLM endpoint
npx wrangler secret put GEMINI_API_KEY

# 3. point at your sheet (already set in wrangler.jsonc)
#    SPREADSHEET_ID = "1RRbOuo9NwcdWCBE4Uwo5BqNVBuvycT_cAHJEn0AgHEI"
#    SHEETS_RANGE   = "'Sample QnA Log'!B5:H"   # → "'QnA Log'!B5:H" for production

npm run deploy
```

The site is live at **https://qna.vistaverde.top**.

`wrangler.jsonc` attaches it as a Cloudflare **custom domain**:

```jsonc
"routes": [{ "pattern": "qna.vistaverde.top", "custom_domain": true }]
```

Because `vistaverde.top` is a zone in the same Cloudflare account, Cloudflare creates the
DNS record and issues the TLS certificate on deploy — nothing to configure by hand. The
`workers.dev` URL stays enabled as a fallback; `preview_urls` is off so each deployment does
not mint a random subdomain.

To use a different domain, change the `pattern` in `routes` and redeploy. Removing the
`routes` block detaches the custom domain.

### Manual sync (how to publish sheet changes)

**Sync is manual.** There is no cron trigger and no age-based auto-refresh — the site keeps
serving the snapshot it has until you explicitly clear it. Nothing publishes automatically.

Run this from the project root whenever you have edited the spreadsheet:

```bash
cd /Volumes/AData/Work/vistaverde_qna

# 1. Clear the cached snapshot from the live KV namespace
npx wrangler kv key delete --binding QACACHE --remote "qa:snapshot"

# 2. Wait ~60 s for the per-isolate memory cache to expire, then trigger a re-read
sleep 70
curl -s https://qna.vistaverde.top/api/health

# 3. Confirm the new content
curl -s https://qna.vistaverde.top/api/meta
```

Step 3 returns e.g. `{"total":5,"categories":[…],"source":"sheets","updatedAt":"…"}`. Two
fields tell you the sync landed:

| Field | Meaning |
|---|---|
| `source` | `"sheets"` = the snapshot was just re-read from the spreadsheet; `"cache"` = you are still looking at the old one |
| `updatedAt` | when the sheet was last read — compare it with the time you started |

If `source` is still `"cache"`, wait a little longer and call `/api/meta` again.

#### The two flags that matter

| Flag | Why it matters |
|---|---|
| `--remote` | **Without it, wrangler deletes the *local* dev KV** and the live site never changes. This fails silently — the command still reports success. |
| `--binding QACACHE` | Resolves the namespace id from `wrangler.jsonc`, so you never need to copy the id by hand. |

Authentication is your existing `wrangler login` (the OAuth token in your keychain — the
same one `npm run deploy` uses). There is no separate Cloudflare API token to create.

#### How long until visitors see it

Not instant — two caches sit in front of KV:

| Layer | Delay |
|---|---|
| Per-isolate memory cache (`MEMORY_TTL_MS`, 60 s) | up to 60 s |
| KV write propagation to other PoPs | up to ~60 s |

Allow **one to two minutes** before every visitor sees the change. This is why step 2 waits
before triggering the re-read — the very first request after the delete may still be served
from a warm isolate.

#### Going back to automatic refresh

The Worker's `scheduled()` handler is still implemented. List a cron in `wrangler.jsonc` to
re-enable it — for example `"crons": ["0,30 * * * *"]` for every 30 minutes — and redeploy.
Nothing else needs to change.

⚠️ **To *disable* an existing cron, set `"crons": []` — do not just delete the `triggers`
block.** An already-deployed schedule is not removed by omitting `triggers`; it stays
attached to the Worker and keeps firing. An explicit empty list is what detaches it.

## Verification

```bash
npm test                       # 65 unit tests
npm run typecheck
npx wrangler deploy --dry-run --outdir dist-check
```

End-to-end against a running Worker (no Sheets API key needed — it seeds a local KV snapshot):

```bash
npm run seed                   # 1. write the snapshot to local KV
npx wrangler dev --port 8787 --local --persist-to .wrangler/state   # 2. start the server
npm run smoke                  # 3. 19 checks over the real HTTP surface
```

Seed **before** starting the dev server: the Worker holds the snapshot in isolate memory for
60 seconds, so a key written while it is running is not seen straight away.

Against the real sheet, to confirm it parses the way the site expects:

```bash
SHEETS_API_KEY=... SPREADSHEET_ID=... npm run check:sheet
```

`check-sheet` flags formulas, unparseable dates, missing answers, duplicate questions and
a missing/unrecognisable `question` column — the things that would silently break the site.

## Notes and gotchas

- **Header row is row 5, data starts at column B.** The range is positional — do not insert
  rows above it. See `docs/SHEET_SETUP.md` §1.
- **`Người hỏi` / `Người trả lời` are shown** as "Người hỏi" / "Người trả lời" on each card.
  They are not searchable — a resident's name will not list their questions.
- **A row goes live only when it has both a question and an answer.** Blank answer = pending.
  An explicit `published` status overrides this.
- **Dates are real date cells formatted `yyyy-mm-dd`**, so the API returns ISO text. Keep the
  format — a reformatted cell returns ambiguous locale text.
- **No formulas in columns C, D, G, H.** The API can serve formula results ~70 minutes stale.
  Column B is a formula and is fine, because it is never read.
- **No `id` column we use.** Ids are derived from category+question.
- **Vietnamese search folds diacritics and segments syllables**, so `hoc phi` finds
  `học phí` and `học phí` finds `hoc phi`. It is lexical, not semantic — see the LLM note below.
- **Never commit the API key.** It is a Worker secret.

## The optional LLM step

`/api/ask` is implemented but **inactive** until `GEMINI_API_KEY` is set; without it the
endpoint returns `503 llm_not_configured`. It retrieves the top matching published items
with the same deterministic search, then asks Gemini to answer strictly from those items and
cite them.

Adding it does not change the rest of the system. The deterministic search remains the
source of truth — the LLM only rephrases what retrieval already found, so it cannot
introduce a Q&A that is not in the sheet.

**Is it worth it?** For a few hundred to a few thousand rows, usually not. The lexical
search already handles the common case, because residents search for terms that appear in
the question ("phí quản lý", "bảo trì"). Turn the LLM on if you observe people phrasing
questions that keyword search misses, not speculatively.

Free-tier caveat: Google AI Studio free tier sends request content to Google for product
improvement. If that matters for this content, leave the endpoint off.
