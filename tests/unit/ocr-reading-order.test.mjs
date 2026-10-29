import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { orderImageLines } from "../../src/ui/services/pdf-reading-order.ts";
import { mergePdfPageLines } from "../../src/ui/services/pdf-import-content.ts";

const recorded = JSON.parse(await readFile(new URL("./fixtures/ocr-label-rail-words.json", import.meta.url), "utf8"));

test("OCR label rails preserve section/body bands and never amputate a wrapped header URL", () => {
  const result = orderImageLines(recorded.lines, recorded.width);
  assert.deepEqual(result.map(item => item.text.trim()), recorded.lines.map(item => item.text.trim()));
});

test("mixed PDF ordering keeps sparse label-rail headings before their OCR bodies", () => {
  const geometry = { width: 900, height: 1100, scale: 1 };
  const native = { text: "Example Labs 2022-01 - 2023-12", x: 50, y: 1100 - 35 - 18,
    width: 278, fontSize: 18, page: 3 };
  const scanned = [
    { ...native, y: 35, height: 18 },
    { text: "Maintained a separate local project.", x: 225, y: 302, width: 559, height: 21, page: 3 },
    { text: "Skills", x: 41, y: 399, width: 52, height: 17, page: 3 },
    { text: "JavaScript Python SQL", x: 224, y: 448, width: 236, height: 21, page: 3 },
  ];
  const result = mergePdfPageLines([native], scanned, geometry);
  assert.deepEqual(result.lines.map(item => item.text), scanned.map(item => item.text));
});

test("an OCR-only rotated page keeps the upright reading order after mapping source boxes back", () => {
  const input = [
    { text: "Synthetic owner", x: 800, y: 200, width: 38, height: 180, page: 1 },
    { text: "Education", x: 700, y: 60, width: 38, height: 160, page: 1 },
    { text: "Example University", x: 620, y: 300, width: 38, height: 200, page: 1 },
  ];
  assert.deepEqual(mergePdfPageLines([], input, { width: 1100, height: 900, scale: 1 }).lines, input);
});
