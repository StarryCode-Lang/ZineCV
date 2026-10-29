import { test } from "node:test";
import assert from "node:assert/strict";
import { mergePdfPageLines } from "../../src/ui/services/pdf-import-content.ts";
import { structureRecognizedLines } from "../../src/ui/services/resume-content-recognition.ts";

const geometry = { width: 600, height: 800, scale: 2 };
const native = (text, x, top, width = 200, page = 2) => ({ text, x, y: 800 - top - 14, fontSize: 14, width, page });
const ocr = (text, x, top, width = 200, page = 2) => ({ text, x: x * 2, y: top * 2, width: width * 2, height: 28, page });
const texts = result => result.lines.map(line => line.text);

test("native section headings win at the same coordinates despite OCR spelling errors", () => {
  const result = mergePdfPageLines([
    native("Education", 30, 80), native("Work Experience", 30, 220), native("Skills", 30, 380),
  ], [
    ocr("Education", 30, 80), ocr("Sample University 2016-09 - 2020-06", 30, 110),
    ocr("Work Experiencc", 30, 220), ocr("Example Labs 2020-07 - 2024-06", 30, 250),
    ocr("Built offline storage.", 30, 280), ocr("Skills", 30, 380), ocr("Python", 30, 410),
  ], geometry);
  assert.deepEqual(texts(result), ["Education", "Sample University 2016-09 - 2020-06", "Work Experience",
    "Example Labs 2020-07 - 2024-06", "Built offline storage.", "Skills", "Python"]);
  assert.equal(result.uncertain, false);
  const structured = structureRecognizedLines(result.lines, "pdf");
  assert.equal(structured.resume.education.length, 1);
  assert.equal(structured.resume.work.length, 1);
  assert.equal(structured.resume.work[0].title, "Example Labs");
  assert.ok(structured.resume.work[0].html.includes("Built offline storage."));
  assert.equal(structured.fieldProvenance["section:work"].page, 2);
});

test("native fragments missed by OCR are inserted at their true page position", () => {
  const result = mergePdfPageLines([
    native("Work Experience", 30, 80), native("Example Labs 2020-07 - 2024-06", 30, 110),
    native("Skills", 30, 220),
  ], [ocr("Built offline storage.", 30, 140), ocr("Python SQL", 30, 250)], geometry);
  assert.deepEqual(texts(result), ["Work Experience", "Example Labs 2020-07 - 2024-06", "Built offline storage.", "Skills", "Python SQL"]);
  assert.equal(result.uncertain, false);
});

test("same-name native lines and OCR-only repeats at different positions are never collapsed", () => {
  const result = mergePdfPageLines([
    native("Example Labs", 30, 80), native("Example Labs", 30, 180),
  ], [ocr("Example Labs", 30, 80), ocr("Example Labs", 30, 180), ocr("Example Labs", 30, 280)], geometry);
  assert.deepEqual(texts(result), ["Example Labs", "Example Labs", "Example Labs"]);
  assert.equal(result.uncertain, false);
});

test("two-column native order and image-only bodies stay within their own columns", () => {
  const result = mergePdfPageLines([
    native("Education", 30, 80, 160), native("First University", 30, 110, 160), native("Left qualification", 30, 140, 160),
    native("Work Experience", 340, 80, 180), native("Example Labs", 340, 110, 180), native("Right role", 340, 140, 180),
  ], [ocr("Left body", 30, 170, 160), ocr("Right body", 340, 170, 180)], geometry);
  assert.deepEqual(texts(result), ["Education", "First University", "Left qualification", "Left body",
    "Work Experience", "Example Labs", "Right role", "Right body"]);
  assert.equal(result.uncertain, false);
});

test("sparse side-by-side evidence warns rather than claiming a reliable column order", () => {
  const result = mergePdfPageLines([native("Left title", 30, 80, 100)], [ocr("Right body", 340, 80, 100)], geometry);
  assert.equal(result.lines.length, 2);
  assert.equal(result.uncertain, true);
  assert.match(result.warnings.join("\n"), /多栏阅读顺序/);
});

test("a wider OCR line containing additional image words is not replaced by a native label", () => {
  const result = mergePdfPageLines([native("Contact", 30, 80, 55)], [ocr("Contact plus image-only evidence", 30, 80, 250)], geometry);
  assert.ok(texts(result).includes("Contact plus image-only evidence"));
  assert.ok(texts(result).includes("Contact"));
  assert.equal(result.uncertain, true);
  assert.match(result.warnings.join("\n"), /局部重叠/);
});

test("missing coordinates preserve all evidence and explicitly withhold reliable ordering", () => {
  const result = mergePdfPageLines([{ text: "Native", page: 4 }], [ocr("OCR", 30, 80, 200, 4)], geometry);
  assert.deepEqual(texts(result), ["Native", "OCR"]);
  assert.equal(result.uncertain, true);
  assert.ok(result.lines.every(line => line.page === 4));
  assert.match(result.warnings.join("\n"), /缺少完整坐标/);
});

test("viewport transform handles a cropped native coordinate origin", () => {
  const cropped = { ...geometry, transform: [2, 0, 0, -2, -40, 1640] };
  const result = mergePdfPageLines([
    { text: "Work Experience", x: 50, y: 726, width: 200, fontSize: 14, page: 3 },
  ], [ocr("Work Experiencc", 30, 80, 200, 3), ocr("Image-only body", 30, 110, 200, 3)], cropped);
  assert.deepEqual(texts(result), ["Work Experience", "Image-only body"]);
  assert.ok(result.lines.every(line => line.page === 3));
  assert.equal(result.uncertain, false);
});

test("blank OCR lines cannot hide an empty OCR result or add fabricated paragraphs", () => {
  const result = mergePdfPageLines([native("Source header", 30, 80)], [{ text: "  " }, { text: "\n" }], geometry);
  assert.deepEqual(texts(result), ["Source header"]);
  assert.equal(result.uncertain, false);
});

test("geometric ordering never silently overrides the native parser's known order", () => {
  const result = mergePdfPageLines([
    native("Native first", 340, 80, 100), native("Native second", 30, 80, 100),
  ], [ocr("Image-only body", 30, 140, 100)], geometry);
  assert.deepEqual(result.lines.filter(line => line.text.startsWith("Native")).map(line => line.text), ["Native first", "Native second"]);
  assert.equal(result.uncertain, true);
  assert.match(result.warnings.join("\n"), /原文字层栏序冲突/);
  assert.ok(texts(result).includes("Image-only body"));
});

test("a rotated PDF viewport maps native boxes into the same physical OCR space", () => {
  const rotated = { width: 800, height: 600, scale: 2, transform: [0, 2, 2, 0, 0, 0] };
  const result = mergePdfPageLines([
    { text: "Rotated native", x: 10, y: 20, width: 100, fontSize: 14, page: 5 },
  ], [
    { text: "Rotatcd nativc", x: 40, y: 20, width: 28, height: 200, page: 5 },
  ], rotated);
  assert.deepEqual(texts(result), ["Rotated native"]);
  assert.equal(result.lines[0].page, 5);
  assert.equal(result.uncertain, false);
});
