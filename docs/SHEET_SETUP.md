# Google Sheets setup (the source of truth)

The spreadsheet **is** the CMS. Staff edit it directly in the Sheets UI.
There is no admin UI, no database, and no write path from the app.

## 1. Workbook shape

Workbook ID: `1RRbOuo9NwcdWCBE4Uwo5BqNVBuvycT_cAHJEn0AgHEI`

| Tab | Purpose |
|---|---|
| `QnA Log` | **Production** content |
| `Sample QnA Log` | Test content — used until the real log is ready |
| `Categories` | Canonical category list + descriptions (reference only) |
| `Hướng Dẫn sử dụng` | Staff guide |

Both log tabs share the **same layout**:

```
row 1–3   title block + counters (Tổng câu hỏi / Đã trả lời / Chờ xử lý / Tỷ lệ phản hồi)
row 4     blank
row 5     ← HEADER ROW
row 6+    ← data
```

- The header row is **row 5**, not row 1. Do not insert rows above it — the range is
  positional and would shift.
- Data starts in **column B** (column A is empty).
- Tab names contain spaces, so they must be quoted in A1 notation.

`wrangler.jsonc` therefore sets:

```jsonc
"SPREADSHEET_ID": "1RRbOuo9NwcdWB…",
"SHEETS_RANGE": "'Sample QnA Log'!B5:H"   // switch to 'QnA Log'!B5:H for production
```

## 2. Columns

The app matches columns **by header name**, case-insensitively, with Vietnamese aliases.
Order and position do not matter.

| Column | Header | Read by the app? | Notes |
|---|---|---|---|
| B | `Mã câu hỏi` (Sample) / `Id` (QnA Log) | **No** | Auto-numbering formula. Harmless — ignored. |
| C | `Câu hỏi` | **Yes** → question | Row is skipped if empty. Required. |
| D | `Câu trả lời` | **Yes** → answer | See §3 — a blank answer means "pending". |
| E | `Người hỏi` | **Yes** → asker | Resident name. Shown on the site as "Người hỏi". |
| F | `Người trả lời` | **Yes** → responder | Staff/team name. Shown as "Người trả lời". |
| G | `Ngày hỏi` | **Yes** → createdAt | See §5. |
| H | `Danh mục` | **Yes** → category | See §4. |

**Attribution:** the asker and responder names are displayed on each card. They are *not*
searchable — typing a resident's name will not list their questions. Aliases also accepted:
`asker` / `responder`, `Người phụ trách`, `Bộ phận`.

Note that the sheet is shared by link (§7), so these names are readable through the sheet
itself regardless of what the site shows. If that ever needs to change, move the public log
to its own workbook.

There is no `keywords` column. Search matches the question and answer text directly (with
diacritic folding, so `ho boi` finds `hồ bơi`). If recall ever proves weak, adding a
`Từ khóa` column is a one-line change — the parser already recognises it.

## 3. Pending vs published — how a row goes live

**A row is published when it has a question *and* an answer.**

| State | On the public site? |
|---|---|
| Question + answer | **Yes** |
| Question, blank answer | **No — treated as pending** |
| Blank question | No (row ignored) |
| Explicit `Trạng thái` = `draft`/`no`/`false`/`0` | No |
| Explicit `Trạng thái` = `published` + blank answer | Yes (explicit override) |

This matches your "Chờ xử lý" counter: staff add the question first, and it appears on the
site only once someone fills in `Câu trả lời`. No extra column is required.

There is currently **no `Trạng thái` column**, which is fine. If you ever want to publish a
question with no answer, add a `Trạng thái` header and put `published` in that row — an
explicit status overrides the pending rule.

## 4. `Danh mục` — keep it aligned with the `Categories` tab

The `Categories` tab holds the canonical list:

```
Tiện ích · Bảo trì · Phí & Tài chính · An ninh & Ra vào
Nội quy & Quy định · Thủ tục Chuyển nhà · Thắc mắc chung
```

The site's category filter is built from **the categories actually used in data**, not from
this tab — so a category with no questions never shows up as a dead filter option. That means
the filter currently shows 5 of the 7 categories, which is correct.

Apply **Data validation → List of items** on column H using the `Categories` list so staff
pick from a dropdown. Free typing is the main source of drift (`Phí & Tài chính` vs
`Phí và Tài chính` become two filter entries). Matching is accent- and case-insensitive, so
minor casing drift is tolerated; genuinely different wording is not.

## 5. `Ngày hỏi` — real date cells are fine here

Unlike a naive setup, this column **is** a real date cell, formatted `yyyy-mm-dd`. That is
deliberate and works: the Sheets API returns the *formatted* value, so the app receives
`2026-11-01` — unambiguous ISO text.

Requirements:

- **Keep the cell format `yyyy-mm-dd`.** If a cell is reformatted (or a new row doesn't
  inherit it), the API returns locale text like `01/11/2026`, which is ambiguous. The parser
  accepts `DD/MM/YYYY` as a fallback, but ISO is the contract.
- **No formulas in columns C, D, G, or H.** The API can serve formula results ~70 minutes
  stale — it does not force recalculation on read. Only editing a cell in the UI refreshes it.
  The formula in column B is fine because that column is never read.

## 6. Non-negotiables

- **Do not insert rows above row 5.** The range `B5:H` is positional.
- **Do not merge cells.** Merged cells produce shifted reads.
- **Do not add filler rows** (e.g. a "Tổng cộng" row) below the data — every row with a
  question and answer is treated as a Q&A.
- **Do not rename the tabs** without updating `SHEETS_RANGE`.
- Columns E and F are never published — but keep them free of anything you'd mind a
  *spreadsheet* viewer seeing, since the sheet itself is link-shared (see §7).

## 7. API key (one-time setup)

The Worker reads the sheet with a **Sheets API key**, which only works for a sheet shared
"Anyone with the link" → Viewer. The data is public Q&A by design; the *key* is what must be
protected.

1. Google Cloud console → **APIs & Services → Credentials → Create credentials → API key**
2. **Edit the key → API restrictions → only `Google Sheets API`**
3. **Application restrictions → `None`.** Do *not* use "HTTP referrers": the Worker calls
   the API server-side without a `Referer` header, so Google rejects every request with
   `Requests from referer <empty> are blocked`. The key's safety comes from being a Worker
   secret, never in the repo.
4. Store it as a Worker secret — never in the repo:
   ```bash
   npx wrangler secret put SHEETS_API_KEY
   ```

The sheet must be **Share → Anyone with the link → Viewer**.

> Note: link-sharing exposes the whole workbook, all tabs, to anyone with the link — including
> `Người hỏi`. That is why the site ignores those columns; it is not a substitute for keeping
> the workbook itself free of data you would not share. If that becomes a concern, move the
> public log to its own workbook.

## 8. Check it works

```bash
SHEETS_API_KEY=... SPREADSHEET_ID=... npm run check:sheet
```

It reads the sheet through the same parser the Worker uses and reports anything that would be
silently dropped or mis-parsed: unrecognised headers, unparseable dates, formulas in read
columns, pending rows, duplicate questions.
