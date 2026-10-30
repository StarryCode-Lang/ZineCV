import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { samples, validateCorpus, familyLayouts } from "../../fixtures/import-quality/corpus.mjs";

const frozenBytes = readFileSync(new URL("../../fixtures/import-quality/blind-holdout-policy5.json", import.meta.url));
const frozen = JSON.parse(frozenBytes);

test("policy5 preserves all original 60 samples and freezes twelve new independent holdouts", () => {
  assert.equal(createHash("sha256").update(frozenBytes).digest("hex"), "916e4810f8221af4a184f7c8a93fdd63c57f17447249c66b0cf4ac11cf20ff29");
  assert.equal(createHash("sha256").update(JSON.stringify(samples.slice(0, 60).map(({ split, ...row }) => row))).digest("hex"), "0dfda262cebff5a65a93e254fa44cb7762fc30ca8fc7d8e32e471178661446a7");
  assert.deepEqual(validateCorpus(), {valid:84,boundary:12,development:72,holdout:12,externalFamilies:40,sources:["chromium-print","canvas-jpeg-pdf","ooxml-package","svg-canvas-raster"]});
  assert.equal(samples.filter(row => row.split === "development").length, 72);
  assert.equal(new Set(samples.map(row => row.id)).size, 84);
  const holdout = samples.filter(row => frozen.samples.some(original => original.id === row.id));
  assert.deepEqual(holdout, frozen.samples.map(row => ({ ...row, split: "development" })));
  assert.equal(new Set(holdout.map(row => row.family)).size, 6);
  for (const geometry of frozen.families) {
    assert.deepEqual(holdout.filter(row => row.family === geometry.id).map(row => row.language).sort(), ["en", "zh"]);
    assert.equal(samples.slice(0, 60).some(row => row.family === geometry.id), false);
    assert.equal(familyLayouts[geometry.id].layout, geometry.id);
  }
});

test("policy5 truth fields, body destinations, pages and nonoverlapping paragraph boxes agree", () => {
  for (const sample of frozen.samples) {
    const geometry = frozen.families.find(row => row.id === sample.family);
    const { truth } = sample;
    assert.deepEqual(sample.recipe.paragraphBoxes, geometry.paragraphBoxes);
    assert.deepEqual(geometry.paragraphBoxes.map(row => row.paragraphIndex).sort((a,b)=>a-b), truth.paragraphs.map((_,index)=>index));
    for (const value of Object.values(truth.fields)) assert.ok(truth.paragraphs.some(text => text.includes(value)));
    for (const path of truth.critical) assert.ok(Object.hasOwn(truth.fields, path));
    for (const destination of truth.destinations) {
      assert.equal(truth.paragraphs[destination.paragraphIndex], destination.text);
      const [section,index] = destination.path.split(".");
      assert.ok(Number(index) < truth.entryCounts[section]);
    }
    for (const [index, box] of geometry.paragraphBoxes.entries()) {
      assert.equal(truth.paragraphPages[box.paragraphIndex], box.page);
      assert.ok(box.page >= 1 && box.page <= sample.pageCount);
      const size = geometry.pageGeometries.find(row => row.page === box.page);
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height);
      for (const other of geometry.paragraphBoxes.slice(index + 1)) {
        assert.ok(box.page !== other.page || box.x + box.width <= other.x || other.x + other.width <= box.x || box.y + box.height <= other.y || other.y + other.height <= box.y);
      }
    }
  }
});
