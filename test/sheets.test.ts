import test from "node:test";
import assert from "node:assert/strict";

import { parseSheetDate } from "../src/dates.ts";
import {
  createSnapshot,
  deriveId,
  isPublished,
  parseKeywords,
  parseSheetValues,
} from "../src/sheets.ts";
import { fold } from "../src/search.ts";

const HEADERS = [
  "Question",
  "Answer",
  "Category",
  "Keywords",
  "Status",
  "Created at",
  "Updated at",
];

test("absent or malformed values parse to an empty sheet", async () => {
  for (const input of [undefined, null, [], {}, "nope", 42]) {
    const parsed = await parseSheetValues(input);
    assert.deepEqual(parsed.items, []);
    assert.deepEqual(parsed.categories, []);
  }
});

test("header row alone yields no items", async () => {
  const parsed = await parseSheetValues([HEADERS]);
  assert.equal(parsed.items.length, 0);
});

test("maps columns by header name and tolerates ragged rows", async () => {
  const values = [
    ["Question", "Answer", "Category"],
    ["Q1", "A1"],
    [],
    ["Q2", "A2", "Cat"],
  ];
  const { items } = await parseSheetValues(values);
  assert.equal(items.length, 2);

  const q1 = items.find((item) => item.question === "Q1");
  const q2 = items.find((item) => item.question === "Q2");
  assert.ok(q1);
  assert.ok(q2);
  assert.equal(q1.answer, "A1");
  assert.equal(q1.category, "");
  assert.equal(q2.answer, "A2");
  assert.deepEqual(q1.keywords, []);
  assert.equal(q1.createdAt, "");
  assert.equal(q1.updatedAt, "");
});

test("asker and responder are read from Người hỏi / Người trả lời", async () => {
  const values = [
    ["Câu hỏi", "Câu trả lời", "Người hỏi", "Người trả lời", "Danh mục"],
    ["Hồ bơi mở mấy giờ?", "Từ 6h.", "Alice Trần", "Quầy Lễ tân", "Tiện ích"],
  ];
  const { items } = await parseSheetValues(values);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.ok(item);
  assert.equal(item.asker, "Alice Trần");
  assert.equal(item.responder, "Quầy Lễ tân");
  // "Người trả lời" must not be mistaken for the answer column.
  assert.equal(item.answer, "Từ 6h.");
  assert.equal(item.question, "Hồ bơi mở mấy giờ?");
});

test("missing asker/responder columns become empty strings", async () => {
  const values = [
    ["Question", "Answer"],
    ["Hồ bơi mở mấy giờ?", "Từ 6h."],
  ];
  const { items } = await parseSheetValues(values);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.asker, "");
  assert.equal(items[0]?.responder, "");
});

test("accepts Vietnamese header aliases and ignores case/accents", async () => {
  const values = [
    ["Câu hỏi", "Câu trả lời", "Danh mục", "Từ khóa", "Trạng thái", "Ngày đăng", "Ngày cập nhật"],
    ["Phí quản lý?", "Đã có bảng phí.", "Phí quản lý", "phi, 2027", "published", "2026-10-02", "2026-11-01"],
  ];
  const { items } = await parseSheetValues(values);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.ok(item);
  assert.equal(item.question, "Phí quản lý?");
  assert.equal(item.answer, "Đã có bảng phí.");
  assert.equal(item.category, "Phí quản lý");
  assert.deepEqual(item.keywords, ["phi", "2027"]);
  assert.equal(item.createdAt, "2026-10-02");
  assert.equal(item.updatedAt, "2026-11-01");
});

test("accepts uppercase and alias headers such as TITLE / CONTENT / TAGS", async () => {
  const values = [
    ["TITLE", "CONTENT", "CHỦ ĐỀ", "TAGS", "PUBLISHED", "DATE"],
    ["Hồ bơi mở mấy giờ?", "Từ 6h.", "Tiện ích", "ho boi", "yes", "2026-10-05"],
  ];
  const { items } = await parseSheetValues(values);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.ok(item);
  assert.equal(item.question, "Hồ bơi mở mấy giờ?");
  assert.equal(item.answer, "Từ 6h.");
  assert.equal(item.category, "Tiện ích");
  assert.deepEqual(item.keywords, ["ho boi"]);
  assert.equal(item.createdAt, "2026-10-05");
  assert.equal(item.updatedAt, "2026-10-05");
});

test("missing optional columns become empty strings", async () => {
  const values = [
    ["Question", "Status"],
    ["Chỉ có câu hỏi", "published"],
  ];
  const { items } = await parseSheetValues(values);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.ok(item);
  assert.equal(item.answer, "");
  assert.equal(item.category, "");
  assert.deepEqual(item.keywords, []);
  assert.equal(item.createdAt, "");
  assert.equal(item.updatedAt, "");
});

test("a sheet without a question column yields no items", async () => {
  const values = [
    ["Answer", "Category"],
    ["A", "B"],
  ];
  const parsed = await parseSheetValues(values);
  assert.equal(parsed.items.length, 0);
});

test("a blank answer is published only when the status is explicit", async () => {
  const values = [
    ["Question", "Answer", "Status"],
    ["Câu hỏi chưa có trả lời", "", "published"],
  ];
  const { items } = await parseSheetValues(values);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.answer, "");
});

test("unanswered questions stay off the site by default (pending workflow)", async () => {
  const values = [
    ["Question", "Answer", "Status"],
    ["Đã trả lời", "Nội dung trả lời", ""],
    ["Chờ xử lý", "", ""],
    ["Chờ xử lý nhưng được duyệt", "", "published"],
    ["Nháp", "Nội dung", "draft"],
  ];
  const { items } = await parseSheetValues(values);
  const questions = items.map((item) => item.question);
  assert.deepEqual(questions, ["Đã trả lời", "Chờ xử lý nhưng được duyệt"]);
});

test("published/draft rules: empty status is published, explicit drafts are dropped", async () => {
  const statuses = ["", "published", "YES", "true", "1", "Có", "draft", "no", "false", "0", "ẩn", "An"];
  const values = [
    ["Question", "Answer", "Status"],
    ...statuses.map((status, index) => [`Câu ${index}`, "Nội dung trả lời", status]),
  ];
  const { items } = await parseSheetValues(values);
  assert.equal(items.length, 6);
  const questions = items.map((item) => item.question);
  for (let index = 0; index < 6; index += 1) {
    assert.ok(questions.includes(`Câu ${index}`));
  }
  for (let index = 6; index < statuses.length; index += 1) {
    assert.equal(questions.includes(`Câu ${index}`), false);
  }
});

test("isPublished is a pure helper with the documented whitelist", () => {
  for (const value of ["", "published", "Published", "yes", "TRUE", "1", "Có", "có"]) {
    assert.equal(isPublished(value), true, `expected ${JSON.stringify(value)} to be published`);
  }
  for (const value of ["draft", "no", "false", "0", "ẩn", "an", "hidden", "maybe"]) {
    assert.equal(isPublished(value), false, `expected ${JSON.stringify(value)} to be draft`);
  }
});

test("DD/MM/YYYY dates fall back correctly and invalid dates become empty", () => {
  assert.equal(parseSheetDate("2026-10-02"), "2026-10-02");
  assert.equal(parseSheetDate("2026-1-2"), "2026-01-02");
  assert.equal(parseSheetDate("02/10/2026"), "2026-10-02");
  assert.equal(parseSheetDate("2/10/2026"), "2026-10-02");

  assert.equal(parseSheetDate("31/02/2026"), "");
  assert.equal(parseSheetDate("2026-13-01"), "");
  assert.equal(parseSheetDate("2026-02-30"), "");
  assert.equal(parseSheetDate("not a date"), "");
  assert.equal(parseSheetDate("12345"), "");
  assert.equal(parseSheetDate(""), "");
  assert.equal(parseSheetDate(undefined), "");
});

test("keywords split on comma/semicolon, lowercase, dedupe and drop empties", () => {
  assert.deepEqual(parseKeywords("Phí, quản lý; phí ,,  "), ["phí", "quản lý"]);
  assert.deepEqual(parseKeywords("  "), []);
  assert.deepEqual(parseKeywords(undefined), []);
  assert.deepEqual(parseKeywords("A;b,c"), ["a", "b", "c"]);
});

test("categories are distinct, accent-insensitively de-duplicated and sorted", async () => {
  const values = [
    ["Question", "Answer", "Category"],
    ["Q1", "A", "Phí quản lý"],
    ["Q2", "A", "Bảo trì"],
    ["Q3", "A", "phi quan ly"],
    ["Q4", "A", ""],
  ];
  const parsed = await parseSheetValues(values);
  assert.deepEqual(parsed.categories, ["Bảo trì", "Phí quản lý"]);
});

test("ids are deterministic, stable and well formed", async () => {
  const first = await deriveId("Phí quản lý", "Phí 2027 là bao nhiêu?");
  const second = await deriveId("Phí quản lý", "Phí 2027 là bao nhiêu?");
  const otherCategory = await deriveId("Bảo trì", "Phí 2027 là bao nhiêu?");

  assert.equal(first, second);
  assert.notEqual(first, otherCategory);
  assert.match(first, /^bv-[0-9a-f]{6}$/);

  const values = [
    ["Question", "Answer", "Category"],
    ["Phí 2027 là bao nhiêu?", "A", "Phí quản lý"],
    ["Phí 2027 là bao nhiêu?", "A", "Phí quản lý"],
  ];
  const { items } = await parseSheetValues(values);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.id, items[1]?.id);
});

test("createSnapshot precomputes indexes and exposes the fetch timestamp", async () => {
  const values = [
    ["Question", "Answer", "Category"],
    ["Học phí 2027?", "Liên hệ ban quản lý.", "Phí quản lý"],
  ];
  const snapshot = await createSnapshot(values, {
    fetchedAt: "2026-11-11T04:20:00.000Z",
    sheetRange: "Q&A!A:G",
  });

  assert.equal(snapshot.updatedAt, "2026-11-11T04:20:00.000Z");
  assert.equal(snapshot.fetchedAt, "2026-11-11T04:20:00.000Z");
  assert.equal(snapshot.sheetRange, "Q&A!A:G");
  assert.deepEqual(snapshot.categories, ["Phí quản lý"]);
  assert.equal(snapshot.items.length, 1);

  const item = snapshot.items[0];
  assert.ok(item);
  assert.ok(item.index.question.words.includes(fold("học").trim()));
  assert.ok(item.index.question.folded.includes("hoc phi"));
  assert.ok(item.index.question.compact.includes("hocphi"));
  assert.ok(item.index.question.bigrams.includes("ho"));
});
