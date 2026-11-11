/**
 * Validate the live Google Sheet against the parsing contract.
 *
 * Usage:
 *   SHEETS_API_KEY=... SPREADSHEET_ID=... node scripts/check-sheet.ts
 *   SHEETS_API_KEY=... SPREADSHEET_ID=... node scripts/check-sheet.ts --range 'Q&A!A:G'
 *
 * Exits non-zero if the sheet would be mis-parsed, so it can gate a deploy.
 * Reads only — never writes to the sheet.
 */

import { parseSheetValues, deriveId } from "../src/sheets.ts";

const args = process.argv.slice(2);
const rangeFlag = args.indexOf("--range");
const RANGE = rangeFlag >= 0 ? (args[rangeFlag + 1] ?? "") : "";

const API_KEY = (process.env.SHEETS_API_KEY ?? "").trim();
const SPREADSHEET_ID = (process.env.SPID ?? process.env.SPREADSHEET_ID ?? "").trim();

const problems: string[] = [];
const warnings: string[] = [];

function fail(message: string): void {
  problems.push(message);
}

function warn(message: string): void {
  warnings.push(message);
}

if (!API_KEY || !SPREADSHEET_ID) {
  console.error(
    "Missing SHEETS_API_KEY and/or SPREADSHEET_ID.\n" +
      "  SHEETS_API_KEY=... SPREADSHEET_ID=... node scripts/check-sheet.ts",
  );
  process.exit(2);
}

const range = RANGE || "Q&A!A:G";
const url = new URL(
  `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}/values/${encodeURIComponent(range)}`,
);
url.searchParams.set("key", API_KEY);

const response = await fetch(url.toString(), { headers: { accept: "application/json" } });
if (!response.ok) {
  console.error(`Sheets API returned ${response.status}.`);
  const body = await response.text().catch(() => "");
  // Surface the API's own message — it distinguishes 403 (bad key / not shared)
  // from 404 (wrong sheet id or wrong range).
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) console.error(parsed.error.message);
  } catch {
    if (body) console.error(body.slice(0, 400));
  }
  process.exit(2);
}

const payload = (await response.json()) as { values?: unknown };
const values = Array.isArray(payload.values) ? payload.values : [];

if (!Array.isArray(payload.values)) {
  fail("The API response had no `values` array. The sheet may be empty or the range wrong.");
}

const header = Array.isArray(values[0]) ? (values[0] as unknown[]) : [];
if (header.length === 0) {
  fail("No header row found. Check that the range starts at row 1 and the tab name is correct.");
} else {
  console.log("Header row:", header.map((cell) => String(cell ?? "").trim()).join(" | "));

  const hasQuestion = header.some((cell) => {
    const key = String(cell ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
    return ["question", "cauhoi", "title"].includes(key);
  });
  if (!hasQuestion) {
    fail(
      'No recognisable `question` column. Add a header row with one of: ' +
        "question, câu hỏi, cau hoi, title.",
    );
  }
}

// Parse exactly the way the Worker does, so this reports what the site will show.
const parsed = await parseSheetValues(values);

console.log(`\nPublished items: ${parsed.items.length}`);
console.log(`Categories: ${parsed.categories.join(", ") || "(none)"}`);

const draftish = /\b(=|now\(\)|today\(\))/i;
const rawRows = Array.isArray(values) ? values.slice(1) : [];
const seenIds = new Map<string, number>();

for (const [index, row] of rawRows.entries()) {
  const cells = Array.isArray(row) ? (row as unknown[]) : [];
  const rowNumber = index + 2;

  cells.forEach((cell, colIndex) => {
    if (typeof cell === "string" && draftish.test(cell)) {
      warn(
        `Row ${rowNumber}, column ${colIndex + 1} looks like a formula ("${cell.slice(0, 30)}"). ` +
          "Formula results can be served ~70 minutes stale — use literal values instead.",
      );
    }
  });

  const question = String(cells[0] ?? "").trim();
  if (!question) continue;

  const id = await deriveId("", question);
  const previous = seenIds.get(id);
  if (previous !== undefined) {
    warn(
      `Row ${rowNumber} has the same question as row ${previous + 2} — they will share the same id (${id}).`,
    );
  }
  seenIds.set(id, index);
}

for (const item of parsed.items) {
  if (!item.answer) {
    warn(`Item "${item.question.slice(0, 50)}" has no answer — it will show an empty answer.`);
  }
}

if (warnings.length) {
  console.log(`\nWarnings (${warnings.length}):`);
  for (const warning of warnings) console.log(`  ! ${warning}`);
}

if (problems.length) {
  console.log(`\nProblems (${problems.length}):`);
  for (const problem of problems) console.log(`  x ${problem}`);
  console.log("\nFAILED — see docs/SHEET_SETUP.md");
  process.exit(1);
}

console.log("\nOK — the sheet parses cleanly and the site will show it as expected.");
