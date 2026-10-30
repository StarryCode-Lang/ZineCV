import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { orderImageLines, pdfLines } from "../../src/ui/services/pdf-reading-order.ts";
import { mergePdfPageLines } from "../../src/ui/services/pdf-import-content.ts";
import { structureRecognizedLines } from "../../src/ui/services/resume-content-recognition.ts";
import { scoreSample } from "../../fixtures/import-quality/score.mjs";

const recorded = JSON.parse(await readFile(new URL("./fixtures/ocr-label-rail-words.json", import.meta.url), "utf8"));

test("recorded OCR changing columns, metadata rows and continuations preserve independently authored content and fields", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/ocr-changing-regions.json", import.meta.url), "utf8"));
  const frozen = JSON.parse(await readFile(new URL("../../fixtures/import-quality/blind-holdout-policy4.json", import.meta.url), "utf8"));
  for (const sample of fixture.cases) {
    const lines = sample.pages.flatMap((page, index) => orderImageLines(page.lines, page.width).map(line => ({ ...line, page: index + 1 })));
    const observed = structureRecognizedLines(lines, "pdf");
    assert.equal(scoreSample(frozen.samples.find(row => row.id === sample.id), observed).passed, true, sample.id);
  }
});

test("native PDF record cards and metadata/body rows preserve full-width section boundaries", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/pdf-record-bands.json", import.meta.url), "utf8"));
  const frozen = JSON.parse(await readFile(new URL("../../fixtures/import-quality/blind-holdout-policy4.json", import.meta.url), "utf8"));
  const normalize = text => text.replace(/\s+/g, "");
  for (const sample of fixture.cases) {
    const actual = sample.pages.flatMap(page => pdfLines(page.items, page.page, page.width));
    assert.equal(normalize(actual.map(line => line.text).join("\n")),
      normalize(frozen.samples.find(row => row.id === sample.id).truth.paragraphs.join("\n")), sample.id);
    const { resume } = structureRecognizedLines(actual, "pdf");
    for (const [path, value] of Object.entries(frozen.samples.find(row => row.id === sample.id).truth.fields)) {
      assert.equal(path.split(".").reduce((part, key) => part?.[key], resume), value, `${sample.id}: ${path}`);
    }
  }
});

test("OCR label rails preserve section/body bands and never amputate a wrapped header URL", () => {
  const result = orderImageLines(recorded.lines, recorded.width);
  assert.deepEqual(result.map(item => item.text.trim()), recorded.lines.map(item => item.text.trim()));
});

test("an OCR continuation page with one label keeps prior content before the next section and its body", async () => {
  const page = JSON.parse(await readFile(new URL("./fixtures/ocr-single-label-continuation.json", import.meta.url), "utf8"));
  assert.deepEqual(orderImageLines(page.lines, page.width).map(line => line.text.trim()), page.lines.map(line => line.text.trim()));
});

test("an indented OCR header above a dated entry is not a column through the entry date", async () => {
  const page = JSON.parse(await readFile(new URL("./fixtures/ocr-header-date-band.json", import.meta.url), "utf8"));
  assert.deepEqual(orderImageLines(page.lines, page.width).map(line => line.text.trim()), page.lines.map(line => line.text.trim()));
});

test("splitting a merged OCR row uses each word's original occurrence, including repeated date punctuation", () => {
  const word = (text, x, width) => ({ text, box: { x, y: 100, width, height: 20 }, lineX: 40 });
  const line = (text, x, y) => ({ text, x, y, width: 80, height: 20 });
  const lines = [
    { text: "Example 2016-09 - 2020-06", x: 40, y: 100, width: 570, height: 20,
      words: [word("Example", 40, 70), word("2016-09", 130, 90), word("-", 500, 8), word("2020-06", 520, 90)] },
    line("Profile", 40, 200), line("Notes", 40, 300), line("Alpha", 500, 200), line("Beta", 500, 300),
  ];
  assert.deepEqual(orderImageLines(lines, 1000).map(line => line.text),
    ["Example 2016-09", "Profile", "Notes", "- 2020-06", "Alpha", "Beta"]);
});

test("real merged OCR columns retain both columns when only a header or continuation body starts on the right", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/ocr-column-bands.json", import.meta.url), "utf8"));
  const expected = {
    "IQ-27": ["计算机科学", "工作经历", "示例科技 Jan 2020 - Jun 2024", "Maintained offline typography and data backups", "专业技能", "JavaScript Python SQL"],
    "IQ-46": ["Alex Sample", "13800000000", "sample46@example.invalid", "https://example.invalid/portfolio/46?view=resume", "Education", "Sample University 2016-09 - 2020-06", "Computer Science", "Work Experience", "Example Labs 2020-07 - 2024-06", "Maintained offline typography and data backups.", "Example Labs 2022-01 - 2023-12", "Maintained a separate local search project concurrently.", "Skills", "JavaScript Python SQL"],
    "IQ-48": ["林合成", "13800000000", "sample48@example.invalid", "https://example.invalid/portfolio/48?view=resume", "教育经历", "合成大学 2016-09 - 2020-06", "计算机科学", "工作经历", "示例科技 2020-07 - 2024-06", "Maintained offline typography and data backups.", "专业技能", "JavaScript Python SQL"],
  };
  for (const page of fixture.cases) assert.deepEqual(orderImageLines(page.lines, page.width).map(line => line.text.trim()), expected[page.id], page.id);
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

test("a native header does not reorder an OCR metadata/body record before the following section", () => {
  const geometry = { width: 800, height: 1100, scale: 1 };
  const native = { text: "Source header", x: 40, y: 1050, width: 200, fontSize: 18, page: 2 };
  const scanned = [
    { text: "Example Labs 2018-07 - 2021-02", x: 40, y: 150, width: 250, height: 18, page: 2 },
    { text: "Linked scans to editable documents.", x: 360, y: 150, width: 350, height: 18, page: 2 },
    { text: "Maintained source references.", x: 360, y: 180, width: 300, height: 18, page: 2 },
    { text: "Skills", x: 40, y: 620, width: 70, height: 18, page: 2 },
    { text: "Python SQL Git", x: 40, y: 700, width: 200, height: 18, page: 2 },
  ];
  assert.deepEqual(mergePdfPageLines([native], scanned, geometry).lines.map(line => line.text),
    [native.text, ...scanned.map(line => line.text)]);
});
