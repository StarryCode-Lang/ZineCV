import { test } from "node:test";
import assert from "node:assert/strict";
import { clearLightRuling, headerReviewRegions, acceptHeaderReview } from "../../src/ui/services/ocr-image-preparation.ts";

test("header review keeps fragmented name pixels together and requires stronger valid source recognition", () => {
  const lines = [
    { text: "包公上", x: 81, y: 65, width: 138, height: 28, confidence: 16 },
    { text: "7A", x: 82, y: 91, width: 86, height: 21, confidence: 39 },
    { text: "13800000000", x: 83, y: 142, width: 167, height: 20, confidence: 96 },
    { text: "fixtureS58@example.invalid", x: 72, y: 246, width: 294, height: 24, confidence: 62 },
    { text: "Education", x: 72, y: 542, width: 118, height: 18, confidence: 95 },
    { text: "body@example.invalid", x: 72, y: 600, width: 150, height: 20, confidence: 30 },
  ];
  const [name, email] = headerReviewRegions(lines);
  assert.deepEqual(name.indexes, [0, 1]);
  assert.equal(name.height, 47, "the full lower glyph fragments must enter the crop");
  assert.deepEqual(email.indexes, [3]);
  assert.equal(acceptHeaderReview(name, "洛合成\n", 90), "洛合成");
  assert.equal(acceptHeaderReview(email, "fixture58@example.invalid\n", 87), "fixture58@example.invalid");
  assert.equal(acceptHeaderReview(email, "fixture58@example.invalid", 70), null);
  assert.equal(acceptHeaderReview(email, "fixture58@example. invalid", 95), null);
  assert.equal(acceptHeaderReview(name, "name\nbody", 99), null);
  assert.deepEqual(headerReviewRegions(lines.map(line => ({ ...line, confidence: 96 }))), []);
});

test("OCR ruling cleanup preserves dark text, pale short glyphs and filled panels", () => {
  const width = 300, height = 240;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const paint = (x, y, w, h, value) => {
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      const i = (row * width + col) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
    }
  };
  paint(10, 20, 280, 2, 221); // a pale frame
  paint(20, 40, 2, 190, 221);
  paint(100, 19, 8, 6, 0); // dark text crossing the frame
  paint(35, 40, 12, 16, 221); // a pale glyph
  paint(120, 65, 150, 80, 221); // a filled panel
  paint(35, 170, 230, 2, 0); // a dark semantic stroke
  assert.ok(clearLightRuling(data, width, height) > 500);
  const pixel = (x, y) => data[(y * width + x) * 4];
  assert.equal(pixel(50, 20), 255);
  assert.equal(pixel(20, 180), 255);
  assert.equal(pixel(104, 20), 0);
  assert.equal(pixel(40, 48), 221);
  assert.equal(pixel(190, 100), 221);
  assert.equal(pixel(100, 170), 0);
});
