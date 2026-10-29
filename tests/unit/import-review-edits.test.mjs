import { test } from "node:test";
import assert from "node:assert/strict";
import { importBodyFromText, importBodyText, mergeImportEntries, splitImportEntry } from "../../src/ui/services/import-review-edits.ts";

const entry = (id, text) => ({ id, title: "Institution", role: "Engineer", department: "", city: "",
  start: "2024.01", end: "2024.12", college: null, mode: null, body: importBodyFromText(text) });

test("review splitting uses the chosen caret and preserves the source without sharing mutable blocks", () => {
  const source = entry("source", "First paragraph\n第二段事实🙂");
  const before = structuredClone(source);
  const split = splitImportEntry(source, "First paragraph\n".length);
  assert.equal(importBodyText(split[0].body) + importBodyText(split[1].body), importBodyText(source.body));
  assert.notEqual(split[0].id, split[1].id);
  assert.deepEqual(source, before);
  split[0].body[0].children[0].text = "changed review";
  assert.deepEqual(source, before);
});

test("review splitting rejects empty halves and UTF-16 surrogate cuts", () => {
  const source = entry("source", "A🙂B");
  for (const offset of [0, 2, 4, -1, 1.5]) assert.throws(() => splitImportEntry(source, offset));
  assert.throws(() => splitImportEntry(entry("spaces", "A   "), 1));
});

test("merging retains conflicting second-entry metadata as visible text and preserves rich source bodies", () => {
  const first = entry("first", "First evidence"), next = entry("next", "Second evidence");
  next.title = "Other institution"; next.start = "2022.01";
  next.body[0].children[0].marks = [{ type: "strong" }];
  const before = structuredClone([first, next]);
  const merged = mergeImportEntries(first, next);
  assert.equal(merged.title, first.title);
  assert.match(importBodyText(merged.body), /Other institution/);
  assert.match(importBodyText(merged.body), /2022\.01/);
  assert.match(importBodyText(merged.body), /First evidence[\s\S]*Second evidence/);
  assert.deepEqual(merged.body.at(-1), next.body[0]);
  assert.deepEqual([first, next], before);
});
