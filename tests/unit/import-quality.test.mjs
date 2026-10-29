import { test } from "node:test";
import assert from "node:assert/strict";
import { characterAccuracy, scoreSample } from "../../fixtures/import-quality/score.mjs";
import { samples } from "../../fixtures/import-quality/corpus.mjs";

function fixture() {
  const sample = {
    id: "scorer-owned", family: "independent", group: "single", textLayer: "text", support: "content-and-structure",
    truth: {
      paragraphs: ["Alex Sample", "Education", "Sample University", "Computer Science", "Work Experience", "Example Labs", "Kept 12 backups.", "Skills", "Python SQL"],
      paragraphPages: [1, 1, 1, 1, 1, 1, 1, 1, 1],
      fields: { "basic.name": "Alex Sample", "education.0.title": "Sample University", "work.0.title": "Example Labs" },
      critical: ["basic.name", "education.0.title", "work.0.title"],
      sections: ["education", "work", "skills"], entryCounts: { education: 1, work: 1, skills: 1 },
      destinations: [
        { paragraphIndex: 3, path: "education.0.html", text: "Computer Science", disposition: "mapped" },
        { paragraphIndex: 6, path: "work.0.html", text: "Kept 12 backups.", disposition: "mapped" },
        { paragraphIndex: 8, path: "skills.0.html", text: "Python SQL", disposition: "mapped" },
      ],
    },
  };
  const observed = { extractedText: sample.truth.paragraphs.join("\n"), moduleOrder: sample.truth.sections,
    resume: { basic: { name: "Alex Sample" }, summary: "<p><br></p>",
      education: [{ title: "Sample University", html: "<p>Computer Science</p>" }],
      work: [{ title: "Example Labs", html: "<p>Kept 12 backups.</p>" }],
      skills: [{ html: "<p>Python SQL</p>" }] } };
  return { sample, observed };
}

test("import scorer requires independent editable-body destinations and exact field ownership", () => {
  const { sample, observed } = fixture();
  assert.equal(scoreSample(sample, observed).passed, true);
  const unannotated = structuredClone(sample);
  delete unannotated.truth.destinations;
  assert.equal(scoreSample(unannotated, observed).passed, false);
  for (const change of [
    result => { result.resume.work[0].html = ""; },
    result => { result.resume.education[0].html = "<p>Kept 12 backups.</p>"; result.resume.work[0].html = "<p>Computer Science</p>"; },
    result => { result.resume.skills[0].html = "<p>Python SQL</p><p>Python SQL</p>"; },
    result => { result.resume.skills[0].html = "<p>Python</p>"; },
    result => { result.resume.work[0].html = "<p>Kept 21 backups.</p>"; },
    result => { result.resume.custom = [{ html: "<p>Kept 12 backups.</p>" }]; },
    result => { result.resume.summary = "<p>Unannotated invented fact.</p>"; },
    result => { result.resume.work[0].html = '<p hidden>Kept 12 backups.</p>'; },
    result => { result.resume.work[0].html = "<script>Kept 12 backups.</script>"; },
  ]) {
    const changed = structuredClone(observed);
    change(changed);
    const result = scoreSample(sample, changed);
    assert.equal(result.accuracy, 1, "raw extracted text remains complete in these counterexamples");
    assert.equal(result.passed, false);
  }
});

test("import scorer preserves body and paragraph order, dates/digits, and entity text", () => {
  const { sample, observed } = fixture();
  sample.truth.paragraphs.splice(7, 0, "Then tested restore.");
  sample.truth.paragraphPages.splice(7, 0, 1);
  sample.truth.destinations[2].paragraphIndex += 1;
  sample.truth.destinations.push({ paragraphIndex: 7, path: "work.0.html", text: "Then tested restore.", disposition: "mapped" });
  observed.extractedText = sample.truth.paragraphs.join("\n");
  observed.resume.work[0].html = "<p>Kept 12 backups.</p><p>Then tested restore.</p>";
  assert.equal(scoreSample(sample, observed).passed, true);
  observed.resume.work[0].html = "<p>Then tested restore.</p><p>Kept 12 backups.</p>";
  assert.equal(scoreSample(sample, observed).passed, false);
  observed.resume.work[0].html = "<p>Kept &#49;&#50; backups.</p><p>Then tested restore.</p>";
  assert.equal(scoreSample(sample, observed).passed, true);
  assert.equal(characterAccuracy("a\u0301\r\nb", "á\nb"), 1);
  assert.equal(characterAccuracy("2024", "2025"), 0.75);
  assert.ok(characterAccuracy("second\nfirst", "first\nsecond") < 1);
  assert.equal(characterAccuracy("", ""), 1);
  assert.equal(characterAccuracy("unexpected", ""), 0);
  const reordered = structuredClone(observed);
  reordered.resume.work[0].html = "<p>Kept 12 backups.</p><p>Then tested restore.</p>";
  reordered.extractedText = [...sample.truth.paragraphs].reverse().join("\n");
  assert.equal(scoreSample(sample, reordered).passed, false);
});

test("import scorer checks HTML link destinations rather than label alone", () => {
  const { sample, observed } = fixture();
  sample.truth.destinations[2] = { paragraphIndex: 8, path: "skills.0.html", text: "Python SQL",
    links: [{ text: "Python SQL", href: "https://example.invalid/skills?x=1&y=2" }], disposition: "mapped" };
  observed.resume.skills[0].html = '<p><a href="https://example.invalid/skills?x=1&amp;y=2">Python SQL</a></p>';
  assert.equal(scoreSample(sample, observed).passed, true);
  observed.resume.skills[0].html = '<p><a href="https://wrong.invalid">Python SQL</a></p>';
  assert.equal(scoreSample(sample, observed).passed, false);
});

test("import scorer does not confuse ordinary body words with hidden HTML attributes", () => {
  const { sample, observed } = fixture();
  sample.truth.destinations[1].text = "Documented hidden cache recovery.";
  sample.truth.paragraphs[6] = sample.truth.destinations[1].text;
  observed.extractedText = sample.truth.paragraphs.join("\n");
  observed.resume.work[0].html = "<p>Documented hidden cache recovery.</p>";
  assert.equal(scoreSample(sample, observed).passed, true);
});

test("import scorer accepts only explicitly annotated unassigned content and counts unexpected modules", () => {
  const { sample, observed } = fixture();
  sample.truth.destinations[2] = { paragraphIndex: 8, path: "custom.0.html", text: "Python SQL", disposition: "unassigned" };
  observed.resume.skills[0].html = "";
  observed.resume.custom = [{ html: "<p>Python SQL</p>" }];
  assert.equal(scoreSample(sample, observed).passed, true);
  observed.resume.awards = [{ title: "Invented certification", html: "" }];
  const result = scoreSample(sample, observed);
  assert.equal(result.passed, false);
  assert.ok(result.fields.precision < 1);
});

test("import scorer permits bounded noncritical OCR transcription errors but preserves recovered text exactly", () => {
  const { sample, observed } = fixture();
  sample.textLayer = "none";
  observed.extractedText = observed.extractedText.replace("backups", "backnps");
  observed.resume.work[0].html = "<p>Kept 12 backnps.</p>";
  const result = scoreSample(sample, observed);
  assert.ok(result.accuracy >= 0.95 && result.accuracy < 1);
  assert.equal(result.fields.f1, 1);
  assert.equal(result.criticalExact, 1);
  assert.equal(result.paragraphs[6].actualSpan.text, "Kept 12 backnps.");
  assert.equal(result.passed, true);
  observed.resume.work[0].html = "<p>Kept 12 backnp.</p>";
  assert.equal(scoreSample(sample, observed).passed, false, "post-extraction loss is separate from OCR error tolerance");
});

test("import scorer rejects a missing or duplicated short paragraph even above the full-document OCR threshold", () => {
  const { sample, observed } = fixture();
  sample.textLayer = "none";
  sample.truth.paragraphs[6] = "Maintained local backups for offline profiles. ".repeat(8).trim();
  sample.truth.destinations[1].text = sample.truth.paragraphs[6];
  observed.resume.work[0].html = `<p>${sample.truth.paragraphs[6]}</p>`;
  observed.extractedText = sample.truth.paragraphs.join("\n");
  assert.equal(scoreSample(sample, observed).passed, true);

  const missing = structuredClone(observed);
  missing.extractedText = sample.truth.paragraphs.slice(0, -1).join("\n");
  const missingResult = scoreSample(sample, missing);
  assert.ok(missingResult.accuracy >= 0.95);
  assert.equal(missingResult.passed, false);
  assert.equal(missingResult.paragraphs.at(-1).trustworthy, false);

  const duplicate = structuredClone(observed);
  duplicate.extractedText += "\nPython SQL";
  duplicate.resume.skills[0].html = "<p>Python SQL</p><p>Python SQL</p>";
  const duplicateResult = scoreSample(sample, duplicate);
  assert.ok(duplicateResult.accuracy >= 0.95);
  assert.equal(duplicateResult.passed, false);
});

test("import scorer rejects similar paragraphs that exchange positions", () => {
  const { sample, observed } = fixture();
  sample.textLayer = "none";
  sample.truth.paragraphs[6] = "Completed local backups.";
  sample.truth.paragraphs[8] = "Completed local restores.";
  sample.truth.destinations[1].text = sample.truth.paragraphs[6];
  sample.truth.destinations[2].text = sample.truth.paragraphs[8];
  const switched = [...sample.truth.paragraphs];
  [switched[6], switched[8]] = [switched[8], switched[6]];
  observed.extractedText = switched.join("\n");
  observed.resume.work[0].html = `<p>${switched[6]}</p>`;
  observed.resume.skills[0].html = `<p>${switched[8]}</p>`;
  const result = scoreSample(sample, observed);
  assert.equal(result.passed, false);
  assert.ok(!result.alignment.complete || result.paragraphs.some(paragraph => !paragraph.trustworthy));
});

function correctObservation(sample) {
  const resume = { basic: {} };
  for (const [section, count] of Object.entries(sample.truth.entryCounts)) resume[section] = Array.from({ length: count }, () => ({}));
  for (const [path, value] of Object.entries(sample.truth.fields)) {
    const keys = path.split(".");
    let target = resume;
    for (const key of keys.slice(0, -1)) target = target[key] ??= {};
    target[keys.at(-1)] = value;
  }
  const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  for (const destination of sample.truth.destinations) {
    const keys = destination.path.split(".");
    let target = resume;
    for (const key of keys.slice(0, -1)) target = target[key] ??= {};
    target[keys.at(-1)] = (target[keys.at(-1)] ?? "") + `<p>${escape(destination.text)}</p>`;
  }
  return { extractedText: sample.truth.paragraphs.join("\n"), moduleOrder: sample.truth.sections, resume };
}

test("import scorer resolves actual builtin long samples without increasing the unresolved-block budget", () => {
  const long = samples.filter(sample => sample.group === "builtin" && sample.lengthVariant === "long");
  assert.equal(long.length, 3);
  for (const sample of long) {
    const observed = correctObservation(sample);
    assert.ok((observed.extractedText.length + 1) ** 2 > 4000000, "regression truly exceeds the former whole-document matrix budget");
    const result = scoreSample(sample, observed);
    assert.equal(result.accuracy, 1);
    assert.equal(result.fields.f1, 1);
    assert.equal(result.passed, true, `${sample.id}: ${JSON.stringify(result.alignment)}`);
    assert.equal(result.alignment.maximumAlignmentCells, 4000000);
    assert.ok(result.alignment.maximumUndecidedBlockCells <= 4000000);

    const changed = structuredClone(observed);
    const original = sample.truth.paragraphs[10];
    const replacement = original.replace("合成交付", "合城交付").replace("Synthetic delivery", "Synthelic delivery");
    assert.notEqual(replacement, original);
    changed.extractedText = changed.extractedText.replace(original, replacement);
    changed.resume.work[0].html = changed.resume.work[0].html.replace(original, replacement);
    const changedResult = scoreSample(sample, changed);
    assert.equal(changedResult.passed, true, `${sample.id}: ${JSON.stringify(changedResult.alignment)}`);
    assert.ok(changedResult.accuracy >= 0.99 && changedResult.accuracy < 1);
    assert.ok(changedResult.alignment.maximumUndecidedBlockCells <= 4000000);
  }
});

test("import scorer uses exact linear-space alignment rather than guessed repeated anchors", () => {
  const sample = structuredClone(samples.find(row => row.group === "builtin" && row.lengthVariant === "long"));
  const repeated = "Repeated synthetic delivery record. ".repeat(8).trim();
  for (let index = 10; index < 42; index += 1) sample.truth.paragraphs[index] = repeated;
  for (const destination of sample.truth.destinations) {
    if (destination.paragraphIndex >= 10 && destination.paragraphIndex < 42) destination.text = repeated;
  }
  const correct = correctObservation(sample);
  assert.equal(scoreSample(sample, correct).passed, true, "an identical complete block needs no guessed anchor");
  const replacement = repeated.replace("synthetic", "synthelic");
  correct.extractedText = correct.extractedText.replace(repeated, replacement);
  correct.resume.work[0].html = correct.resume.work[0].html.replace(repeated, replacement);
  const result = scoreSample(sample, correct);
  assert.equal(result.passed, true);
  assert.equal(result.alignment.complete, true);
  assert.ok(result.alignment.linearSpaceBlocks > 0);
  assert.ok(result.alignment.maximumRowCells <= 4000000);
  assert.ok(result.alignment.maximumUndecidedBlockCells <= 4000000);
  assert.equal(result.alignment.maximumAlignmentCells, 4000000);

  const missing = correctObservation(sample);
  missing.extractedText = missing.extractedText.replace(repeated + "\n", "");
  missing.resume.work[0].html = missing.resume.work[0].html.replace(`<p>${repeated}</p>`, "");
  sample.textLayer = "none";
  const missingResult = scoreSample(sample, missing);
  assert.ok(missingResult.accuracy >= 0.95);
  assert.equal(missingResult.passed, false);
  assert.ok(missingResult.paragraphs.some(paragraph => !paragraph.trustworthy));
});

test("import scorer aligns actual IQ-04/06 long bodies wrapped every 50 characters with one OCR error", () => {
  for (const id of ["IQ-04", "IQ-06"]) {
    const sample = samples.find(row => row.id === id);
    const observed = correctObservation(sample);
    for (let index = 10; index < 42; index += 1) {
      const original = sample.truth.paragraphs[index];
      const points = [...original];
      if (index === 10) points[points.length - 3] = points[points.length - 3] === "x" ? "y" : "x";
      const chunks = [];
      for (let start = 0; start < points.length; start += 50) chunks.push(points.slice(start, start + 50).join(""));
      const wrapped = chunks.join("\n");
      observed.extractedText = observed.extractedText.replace(original, wrapped);
      observed.resume.work[0].html = observed.resume.work[0].html.replace(original, chunks.join("<br>"));
    }
    const result = scoreSample(sample, observed);
    assert.equal(result.alignment.complete, true, `${id}: ${JSON.stringify(result.alignment)}`);
    assert.ok(result.alignment.linearSpaceBlocks > 0);
    assert.ok(result.alignment.maximumUndecidedBlockCells <= 4000000);
    assert.ok(result.alignment.maximumRowCells <= 4000000);
    assert.equal(result.criticalExact, 1);
    assert.equal(result.fields.f1, 1);
    assert.equal(result.destinations.passed, true);
    assert.ok(result.paragraphs.every(paragraph => paragraph.trustworthy));
    assert.equal(result.passed, result.accuracy >= result.threshold,
      "physical newlines retain their declared character cost; alignment must not relax the text threshold");
  }
});
