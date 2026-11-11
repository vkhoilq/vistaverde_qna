/**
 * Seed a local KV snapshot so the Worker can be exercised without a Sheets API key.
 *
 * Run this BEFORE `npm run dev`.
 *
 * Why the ordering matters: the Worker keeps the snapshot in isolate memory for
 * 60 seconds (see `MEMORY_TTL_MS` in `src/worker.ts`). A key written while the
 * dev server is already running is not picked up until that cache expires, so
 * seeding first avoids a confusing "my new fixture isn't showing" minute.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createSnapshot } from "../src/sheets.ts";

const SNAPSHOT_PATH = "/tmp/vistaverde-qna-snapshot.json";
const PERSIST_DIR = ".wrangler/state";

/** Mirrors the real sheet: Vietnamese, accents, a draft, a pending row, a ragged row. */
const FIXTURE_VALUES = [
  [
    "question",
    "answer",
    "category",
    "keywords",
    "Người hỏi",
    "Người trả lời",
    "status",
    "created_at",
    "updated_at",
  ],
  [
    "Phí quản lý căn hộ năm 2027 là bao nhiêu?",
    "Mức phí quản lý năm 2027 được BQT phê duyệt là 18.000 đồng/m2/tháng.",
    "Phí quản lý",
    "phi quan ly, phi 2027, phi dich vu",
    "Lan Trần",
    "Bộ phận Kế toán",
    "published",
    "2026-10-02",
    "2026-11-01",
  ],
  [
    "Thang máy hỏng khi nào được bảo trì?",
    "Lịch bảo trì thang máy được thông báo trước 3 ngày tại bảng tin tầng 1.",
    "Bảo trì",
    "thang may, elevator",
    "Minh Phạm",
    "Bộ phận Kỹ thuật",
    "published",
    "2026-09-15",
    "2026-09-15",
  ],
  [
    "Câu hỏi nội bộ chưa được duyệt",
    "Nội dung nháp, không nên hiển thị.",
    "Khác",
    "nội bộ",
    "Bí Thương",
    "Ban quản lý",
    "draft",
    "2026-11-05",
    "2026-11-05",
  ],
  // Ragged row (only question + answer) — must still be published.
  ["Hồ bơi mở mấy giờ?", "Hồ bơi mở từ 6:00 đến 22:00 hàng ngày."],
  // Pending row (no answer) — must NOT be published.
  ["Câu hỏi đang chờ trả lời", "", "Khác", "", "", "", "", "2026-11-06", "2026-11-06"],
];

/** Published rows: 1, 2, 4. Rows 3 (draft) and 5 (pending) are excluded. */
export const EXPECTED_PUBLISHED = 3;
export const EXPECTED_CATEGORIES = 2;

const snapshot = await createSnapshot(FIXTURE_VALUES, { sheetRange: "fixture!B5:H" });
writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot));

console.log(
  `Fixture: ${snapshot.items.length} published item(s), categories: ${snapshot.categories.join(", ") || "(none)"}`,
);

if (snapshot.items.length !== EXPECTED_PUBLISHED) {
  console.error(
    `Expected ${EXPECTED_PUBLISHED} published items but the fixture produced ${snapshot.items.length}.`,
  );
  process.exit(1);
}

console.log(`Writing snapshot to ${SNAPSHOT_PATH}…`);
execFileSync(
  "wrangler",
  [
    "kv",
    "key",
    "put",
    "--binding",
    "QACACHE",
    "--local",
    "--persist-to",
    PERSIST_DIR,
    "qa:snapshot",
    "--path",
    SNAPSHOT_PATH,
  ],
  { stdio: "inherit" },
);

console.log("Seeded local KV key `qa:snapshot`. Now run `npm run dev`, then `npm run smoke`.");
