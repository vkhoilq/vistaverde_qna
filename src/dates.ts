/**
 * Date helpers.
 *
 * Sheet dates are always ISO-8601 *text* (`YYYY-MM-DD`). We still accept the
 * Vietnamese `DD/MM/YYYY` form as a fallback because staff occasionally type it.
 * Anything invalid becomes "" — never a crash, never a bogus date.
 */

const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const VN_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function buildDate(year: number, month: number, day: number): string {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return "";
  if (year < 1900 || year > 2999) return "";
  if (month < 1 || month > 12) return "";
  if (day < 1 || day > 31) return "";
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return "";
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Parse a sheet date cell into `YYYY-MM-DD`, or "" when not a valid date. */
export function parseSheetDate(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";

  const iso = ISO_RE.exec(text);
  if (iso) return buildDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const vn = VN_RE.exec(text);
  if (vn) return buildDate(Number(vn[3]), Number(vn[2]), Number(vn[1]));

  return "";
}

/** Normalize an API `from`/`to` bound. Invalid input is treated as absent. */
export function normalizeDateBound(raw: string | null | undefined): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  return parseSheetDate(text);
}
