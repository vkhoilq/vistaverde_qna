import test from "node:test";
import assert from "node:assert/strict";

import { createSnapshot } from "../src/sheets.ts";
import {
  fold,
  parseQueryParams,
  runQuery,
  segmentWords,
} from "../src/search.ts";
import type { SearchQuery } from "../src/types.ts";

const HEADERS = [
  "Question",
  "Answer",
  "Category",
  "Keywords",
  "Status",
  "Created at",
  "Updated at",
];

interface RowSpec {
  question: string;
  answer?: string;
  category?: string;
  keywords?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

function toValues(rows: RowSpec[]): unknown[][] {
  return [
    HEADERS,
    ...rows.map((row) => [
      row.question,
      row.answer ?? "Nội dung trả lời",
      row.category ?? "",
      row.keywords ?? "",
      row.status ?? "",
      row.createdAt ?? "",
      row.updatedAt ?? "",
    ]),
  ];
}

async function queryRows(rows: RowSpec[], params = "") {
  const snapshot = await createSnapshot(toValues(rows), {
    fetchedAt: "2026-11-11T04:20:00.000Z",
  });
  const parsed = parseQueryParams(new URLSearchParams(params));
  return runQuery(snapshot.items, parsed);
}

const EMPTY_QUERY: SearchQuery = {
  q: "",
  category: "",
  from: "",
  to: "",
  limit: 50,
  offset: 0,
};

test("folds Vietnamese diacritics, including đ", () => {
  assert.equal(fold("Học phí 2027"), "hoc phi 2027");
  assert.equal(fold("Đăng ký"), "dang ky");
  assert.equal(fold("  Phí   QUẢN LÝ  "), "  phi   quan ly  ");
});

test("segments Vietnamese text into word-like tokens", () => {
  assert.deepEqual(segmentWords("học phí quản lý"), ["hoc", "phi", "quan", "ly"]);
  assert.deepEqual(segmentWords("Học phí năm 2027 là bao nhiêu?"), [
    "hoc",
    "phi",
    "nam",
    "2027",
    "la",
    "bao",
    "nhieu",
  ]);
  assert.deepEqual(segmentWords(""), []);
});

test("diacritic-free query finds accented question", async () => {
  const result = await queryRows(
    [
      {
        question: "Học phí năm 2027 là bao nhiêu?",
        answer: "Bảng phí được gửi vào tháng 12.",
        category: "Phí quản lý",
      },
      { question: "Giờ mở cửa hồ bơi?", answer: "Từ 6h sáng.", category: "Tiện ích" },
    ],
    "q=hoc+phi",
  );

  assert.ok(result.total >= 1);
  assert.equal(result.items[0]?.question, "Học phí năm 2027 là bao nhiêu?");
});

test("accented query finds accented question", async () => {
  const result = await queryRows(
    [{ question: "Học phí năm 2027 là bao nhiêu?", category: "Phí quản lý" }],
    `q=${encodeURIComponent("học phí")}`,
  );
  assert.equal(result.items[0]?.question, "Học phí năm 2027 là bao nhiêu?");
});

test("segmentation makes 'quan ly' match the separate syllables of 'quản lý'", async () => {
  const result = await queryRows(
    [{ question: "Quản lý toà nhà làm việc mấy giờ?", category: "Phí quản lý" }],
    "q=quan+ly",
  );
  assert.equal(result.items.length, 1);
  assert.ok(result.items[0]?.score > 0);
});

test("bigram fallback matches input written without spaces", async () => {
  const result = await queryRows(
    [{ question: "Quản lý toà nhà làm việc mấy giờ?" }],
    "q=quanly",
  );
  assert.equal(result.items.length, 1);
  assert.ok(result.items[0]?.score > 0);
});

test("a query made only of function words returns nothing", async () => {
  const result = await queryRows(
    [{ question: "Hồ bơi mở mấy giờ?" }, { question: "Phí quản lý bao nhiêu?" }],
    `q=${encodeURIComponent("khong co gi")}`,
  );
  assert.equal(result.total, 0);
});

test("a nonsense query matches nothing", async () => {
  const result = await queryRows(
    [{ question: "Hồ bơi mở mấy giờ?" }, { question: "Quy trình chuyển nhà thế nào?" }],
    "q=xyzabc",
  );
  assert.equal(result.total, 0);
});

test("a specific query does not drag in unrelated items", async () => {
  const result = await queryRows(
    [
      { question: "Hồ bơi mở mấy giờ?", category: "Tiện ích" },
      { question: "Phí quản lý hàng tháng bao nhiêu?", category: "Phí quản lý" },
      { question: "Quy trình chuyển nhà thế nào?", category: "Thủ tục" },
    ],
    `q=${encodeURIComponent("hồ bơi")}`,
  );
  assert.equal(result.total, 1);
  assert.match(result.items[0]?.question ?? "", /Hồ bơi/);
});

test("field weighting: a question match outranks an answer-only match", async () => {
  const result = await queryRows(
    [
      {
        question: "Học phí năm 2027 là bao nhiêu?",
        answer: "Xem bảng phí.",
        category: "Phí quản lý",
      },
      {
        question: "Thông báo họp cư dân",
        answer: "Học phí được thu vào tháng 1 hàng năm.",
        category: "Thông báo",
      },
    ],
    "q=hoc+phi",
  );

  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]?.question, "Học phí năm 2027 là bao nhiêu?");
  assert.ok(
    (result.items[0]?.score ?? 0) > (result.items[1]?.score ?? 0),
    "question match must score higher than answer match",
  );
});

test("full-query substring bonus raises a contiguous phrase above split terms", async () => {
  const result = await queryRows(
    [
      { question: "Phí quản lý năm 2027 là bao nhiêu?", category: "Phí quản lý" },
      { question: "Quản lý toà nhà thu phí năm 2027 thế nào?", category: "Phí quản lý" },
    ],
    "q=phi+quan+ly",
  );

  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]?.question, "Phí quản lý năm 2027 là bao nhiêu?");
  assert.ok(
    (result.items[0]?.score ?? 0) > (result.items[1]?.score ?? 0),
    "contiguous phrase must earn the substring bonus",
  );
});

test("category filtering is case- and accent-insensitive", async () => {
  const result = await queryRows(
    [
      { question: "Câu một", category: "Phí quản lý" },
      { question: "Câu hai", category: "Bảo trì" },
    ],
    "category=phi+quan+ly",
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.question, "Câu một");
});

test("from/to bounds are inclusive and filter on createdAt", async () => {
  const rows: RowSpec[] = [
    { question: "Tháng 9", createdAt: "2026-09-30", updatedAt: "2026-11-01" },
    { question: "Đầu tháng 10", createdAt: "2026-10-01", updatedAt: "2026-10-01" },
    { question: "Cuối tháng 10", createdAt: "2026-10-31", updatedAt: "2026-10-31" },
    { question: "Tháng 11", createdAt: "2026-11-01", updatedAt: "2026-11-01" },
  ];

  const result = await queryRows(rows, "from=2026-10-01&to=2026-10-31");
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.items.map((item) => item.question).sort(),
    ["Cuối tháng 10", "Đầu tháng 10"],
  );

  const exact = await queryRows(rows, "from=2026-10-01&to=2026-10-01");
  assert.deepEqual(exact.items.map((item) => item.question), ["Đầu tháng 10"]);
});

test("from/to fall back to updatedAt when createdAt is empty", async () => {
  const result = await queryRows(
    [{ question: "Không có ngày đăng", updatedAt: "2026-10-15" }],
    "from=2026-10-01&to=2026-10-31",
  );
  assert.equal(result.total, 1);
});

test("empty q returns everything sorted by updatedAt desc with score 0", async () => {
  const result = await queryRows(
    [
      { question: "Cũ", createdAt: "2026-01-01", updatedAt: "2026-09-01" },
      { question: "Mới", createdAt: "2026-01-01", updatedAt: "2026-11-01" },
      { question: "Giữa", createdAt: "2026-01-01", updatedAt: "2026-10-01" },
    ],
    "",
  );

  assert.equal(result.total, 3);
  assert.deepEqual(
    result.items.map((item) => item.question),
    ["Mới", "Giữa", "Cũ"],
  );
  assert.ok(result.items.every((item) => item.score === 0));
});

test("sorting falls back to createdAt desc when updatedAt ties", async () => {
  const result = await queryRows(
    [
      { question: "Tạo trước", createdAt: "2026-10-01", updatedAt: "2026-10-10" },
      { question: "Tạo sau", createdAt: "2026-10-05", updatedAt: "2026-10-10" },
    ],
    "",
  );
  assert.deepEqual(
    result.items.map((item) => item.question),
    ["Tạo sau", "Tạo trước"],
  );
});

test("limit and offset paginate while total stays the full match count", async () => {
  const rows: RowSpec[] = Array.from({ length: 5 }, (_, index) => ({
    question: `Câu ${index}`,
    updatedAt: `2026-10-0${index + 1}`,
  }));

  const firstPage = await queryRows(rows, "limit=2");
  assert.equal(firstPage.total, 5);
  assert.equal(firstPage.items.length, 2);
  assert.equal(firstPage.limit, 2);

  const secondPage = await queryRows(rows, "limit=2&offset=2");
  assert.equal(secondPage.total, 5);
  assert.equal(secondPage.offset, 2);
  assert.notEqual(secondPage.items[0]?.question, firstPage.items[0]?.question);
});

test("draft rows never reach search results", async () => {
  const result = await queryRows(
    [
      { question: "Câu công khai", status: "published" },
      { question: "Câu nháp", status: "draft" },
      { question: "Câu ẩn", status: "ẩn" },
    ],
    "q=cau",
  );
  assert.equal(result.total, 1);
  assert.equal(result.items[0]?.question, "Câu công khai");
});

test("search results do not leak the precomputed index", async () => {
  const result = await queryRows([{ question: "Học phí?" }], "q=hoc");
  assert.equal(result.items.length, 1);
  assert.equal("index" in (result.items[0] ?? {}), false);
});

test("parseQueryParams applies defaults and clamps", () => {
  const defaults = parseQueryParams(new URLSearchParams(""));
  assert.deepEqual(defaults, EMPTY_QUERY);

  const huge = parseQueryParams(new URLSearchParams("limit=999&offset=-4"));
  assert.equal(huge.limit, 200);
  assert.equal(huge.offset, 0);

  const invalid = parseQueryParams(new URLSearchParams("limit=abc&offset=xyz"));
  assert.equal(invalid.limit, 50);
  assert.equal(invalid.offset, 0);

  const bounds = parseQueryParams(new URLSearchParams("from=2026-01-01&to=bad"));
  assert.equal(bounds.from, "2026-01-01");
  assert.equal(bounds.to, "");
});

test("invalid date bounds are ignored rather than breaking the query", async () => {
  const result = await queryRows([{ question: "Câu hỏi", createdAt: "2026-10-01" }], "from=oops");
  assert.equal(result.total, 1);
});
