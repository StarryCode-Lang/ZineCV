import { test } from "node:test";
import assert from "node:assert/strict";
import { structureRecognizedLines } from "../../src/ui/services/resume-content-recognition.ts";

const recognize = lines => structureRecognizedLines(lines.map((text, index) => ({ text, page: index < 4 ? 1 : 2 })), "pdf");
const plainEntries = entries => entries.map(entry => `${entry.title}\n${entry.html.replace(/<[^>]*>/g, " ")}`).join("\n");

test("a physically wrapped numeric date range retains both dates without joining across pages or ordinary numbers", () => {
  for (const parts of [["Example University 2014-09", "- 2018-06"], ["Example University 2014-09 - 2018-", "06"]]) {
    const content = structureRecognizedLines(["Alex Sample", "Education", ...parts, "Computer Science"].map(text => ({ text, page: 1 })), "pdf");
    assert.equal(content.resume.education[0]?.title, "Example University");
    assert.equal(content.resume.education[0]?.start, "2014-09");
    assert.equal(content.resume.education[0]?.end, "2018-06");
    assert.equal(content.extractedText.replace(/\s/g, ""), ["Alex Sample", "Education", ...parts, "Computer Science"].join("").replace(/\s/g, ""));
  }
  for (const tail of [{ text: "- 2018-06", page: 2 }, { text: "200", page: 1 }, { text: "Skills", page: 1 }]) {
    const content = structureRecognizedLines([{ text: "Alex Sample", page: 1 }, { text: "Education", page: 1 }, { text: "Example University 2014-09", page: 1 }, tail], "pdf");
    assert.ok(content.extractedText.includes(`2014-09\n${tail.text}`));
  }
});

test("a uniquely truncated Chinese section label before dated evidence stays reviewable without inventing its source text", () => {
  const input = ["林合成", "13800000000", "sample@example.invalid", "育经历", "合成大学 2016-09 - 2020-06", "计算机科学",
    "工作经历", "示例科技 2020-07 - 2024-06", "维护离线数据。", "专业技能", "Python"];
  const content = structureRecognizedLines(input.map(text => ({ text, page: 1 })), "pdf");
  assert.equal(content.resume.education[0]?.title, "合成大学");
  assert.equal(content.resume.education[0].start, "2016-09");
  assert.equal(content.extractedText, input.join("\n"));
  assert.match(content.warnings.join("\n"), /育经历.*教育经历.*核对/);
  assert.notEqual(content.confidence, "high");
  for (const label of ["项目经理", "经历", "工作经厉"]) {
    const ordinary = structureRecognizedLines([{ text: "Alex Sample" }, { text: label }, { text: "Example Labs 2020-07 - 2024-06" }], "pdf");
    assert.deepEqual(ordinary.moduleOrder, ["custom"], `${label} cannot become a heading through substitution or ambiguous short text`);
    assert.ok(ordinary.extractedText.includes(label));
  }
});

test("employment dates never become a phone and missing contact has a concrete warning", () => {
  const content = recognize(["Alex Sample", "Education", "Example University 2016-09 - 2020-06",
    "Experience", "Example Labs 2020-07 - 2024-06", "Skills", "Python"]);
  assert.equal(content.resume.basic.phone, "");
  assert.equal(content.fieldProvenance["basic:phone"], undefined);
  assert.match(content.warnings.join("\n"), /联系电话.*日期和跨行数字/);
  assert.notEqual(content.confidence, "high");
  assert.equal(content.resume.education[0].start, "2016-09");
  assert.equal(content.resume.work[0].end, "2024-06");
});

test("phone candidates retain exact line evidence for Chinese and international formats", () => {
  for (const phone of ["13800000000", "+86 13800000000", "+1 (415) 555-0123", "+44 20 7946 0958", "010-88886666"]) {
    const content = recognize(["Alex Sample", `Phone: ${phone}`, "Education", "Example University 2016-09 - 2020-06"]);
    assert.equal(content.resume.basic.phone, phone);
    assert.equal(content.fieldProvenance["basic:phone"].text, `Phone: ${phone}`);
    assert.equal(content.fieldProvenance["basic:phone"].page, 1);
    assert.equal(content.resume.custom.length, 0, "consumed label must not create a false unclassified fragment");
  }
});

test("cross-line digit fragments and standalone birth dates stay unclassified", () => {
  const content = recognize(["Alex Sample", "138", "00138000", "1994-01-01", "Education", "Example University"]);
  assert.equal(content.resume.basic.phone, "");
  assert.equal(content.fieldProvenance["basic:phone"], undefined);
  const residual = plainEntries(content.resume.custom);
  for (const fragment of ["138", "00138000", "1994-01-01"]) assert.ok(residual.includes(fragment));
});

test("contact and name lines retain unconsumed same-line narrative", () => {
  const content = recognize(["Alex Sample • Open source maintainer",
    "电话：13800000000 Github contributor", "Email: sample@example.invalid Community mentor",
    "网站：https://example.invalid/portfolio Local-first tooling", "Education", "Example University 2016-09 - 2020-06"]);
  assert.equal(content.resume.basic.name, "Alex Sample");
  assert.equal(content.resume.basic.phone, "13800000000");
  assert.equal(content.resume.basic.email, "sample@example.invalid");
  assert.equal(content.resume.basic.website, "https://example.invalid/portfolio");
  const residual = plainEntries(content.resume.custom);
  for (const fragment of ["Open source maintainer", "Github contributor", "Community mentor", "Local-first tooling"]) assert.ok(residual.includes(fragment));
  assert.match(content.warnings.join("\n"), /头部有未归类文字/);
  assert.ok(content.extractedText.includes("13800000000 Github contributor"));
});

test("a later header line starting with the person's name is not silently discarded", () => {
  const content = recognize(["Alex Sample", "13800000000", "Alex Sample founded an offline tools community",
    "Education", "Example University 2016-09 - 2020-06"]);
  assert.ok(plainEntries(content.resume.custom).includes("Alex Sample founded an offline tools community"));
});

test("an institution followed by a separate date line stays one editable experience", () => {
  const content = recognize(["Alex Sample", "Experience", "Example Labs", "2020-01 - 2024-06", "Built offline storage."]);
  assert.equal(content.resume.work.length, 1);
  assert.equal(content.resume.work[0].title, "Example Labs");
  assert.equal(content.resume.work[0].start, "2020-01");
  assert.equal(content.resume.work[0].end, "2024-06");
  assert.ok(content.resume.work[0].html.includes("Built offline storage."));
});

test("separate date lines preserve two institutions and their own body paragraphs", () => {
  const content = recognize(["Alex Sample", "Experience", "First Labs", "2018-01 - 2020-06", "Built the first editor.",
    "Second Labs", "2020-07 - 2024-06", "Built offline storage."]);
  assert.equal(content.resume.work.length, 2);
  assert.equal(content.resume.work[0].title, "First Labs");
  assert.equal(content.resume.work[0].end, "2020-06");
  assert.ok(content.resume.work[0].html.includes("Built the first editor."));
  assert.equal(content.resume.work[1].title, "Second Labs");
  assert.equal(content.resume.work[1].start, "2020-07");
  assert.ok(content.resume.work[1].html.includes("Built offline storage."));
  assert.match(content.warnings.join("\n"), /相邻标题分段/);
});

test("repeated title text in the body is retained and body dates do not split entries", () => {
  const content = recognize(["Alex Sample", "Experience", "Example Labs 2020-01 - 2024-06", "Example Labs",
    "- Maintained the 2021-01 - 2022-06 rollout.", "Built offline storage."]);
  assert.equal(content.resume.work.length, 1);
  assert.equal(content.resume.work[0].title, "Example Labs");
  assert.ok(content.resume.work[0].html.includes("Example Labs"));
  assert.ok(content.resume.work[0].html.includes("2021-01 - 2022-06"));
});

test("a job intent does not consume contact lines that follow it", () => {
  const content = recognize(["林合成", "求职意向：前端工程师", "电话：13800000000", "sample@example.invalid",
    "教育经历", "合成大学 2016-09 - 2020-06"]);
  const residual = plainEntries(content.resume.custom);
  assert.ok(residual.includes("意向职位：前端工程师"));
  assert.ok(!residual.includes("电话"));
  assert.ok(!residual.includes("sample@example.invalid"));
});

test("conflicting phones and undated experiences carry distinct actionable warnings", () => {
  const content = recognize(["Alex Sample", "Phone: 13800000000", "Phone: 13900000000", "sample@example.invalid",
    "Education", "Example University", "Experience", "Example Labs", "Skills", "Python"]);
  assert.equal(content.resume.basic.phone, "13800000000");
  assert.ok(plainEntries(content.resume.custom).includes("13900000000"));
  assert.match(content.warnings.join("\n"), /多个电话候选/);
  assert.match(content.warnings.join("\n"), /未识别到起止日期/);
  assert.equal(content.confidence, "medium");
});

test("complete unambiguous contact and dated structure can still reach high confidence", () => {
  const content = recognize(["Alex Sample", "13800000000", "sample@example.invalid", "https://example.invalid/portfolio",
    "Education", "Example University 2016-09 - 2020-06", "Experience", "Example Labs 2020-07 - 2024-06",
    "Built offline storage.", "Skills", "Python SQL"]);
  assert.equal(content.confidence, "high");
  assert.deepEqual(content.warnings, []);
});

test("English month names and abbreviations map dates without leaking the range into the institution", () => {
  for (const [range, start, end] of [
    ["Jan 2020 - Jun 2024", "2020-01", "2024-06"],
    ["JANUARY 2020 – june 2024", "2020-01", "2024-06"],
    ["Feb. 2020 — Sept. 2024", "2020-02", "2024-09"],
    ["March 2020 - September 2024", "2020-03", "2024-09"],
    ["Apr 2020 - PRESENT", "2020-04", "至今"],
    ["October 2020 - 2024", "2020-10", "2024"],
    ["2020 - November 2024", "2020", "2024-11"],
    ["2020 - 2024", "2020", "2024"],
  ]) {
    const content = recognize(["Alex Sample", "Experience", `Example Labs ${range}`, "Built offline storage."]);
    assert.equal(content.resume.work.length, 1, range);
    assert.equal(content.resume.work[0].title, "Example Labs", range);
    assert.equal(content.resume.work[0].start, start, range);
    assert.equal(content.resume.work[0].end, end, range);
    assert.ok(content.resume.work[0].html.includes("Built offline storage."));
    assert.equal(content.resume.basic.phone, "", "English employment years are not a phone");
    assert.ok(content.extractedText.includes(range));
    assert.equal(content.fieldProvenance["section:work"].text, `Example Labs ${range}`);
    assert.equal(content.fieldProvenance["section:work"].page, 1);
  }
});

test("all twelve English month spellings retain their own month number", () => {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  for (const [index, month] of months.entries()) {
    const content = recognize(["Alex Sample", "Education", `Example University ${month} 2016 - ${month} 2020`]);
    assert.equal(content.resume.education[0].start, `2016-${String(index + 1).padStart(2, "0")}`);
    assert.equal(content.resume.education[0].end, `2020-${String(index + 1).padStart(2, "0")}`);
  }
});

test("same-name institutions with separate English date lines keep independent experiences", () => {
  const content = recognize(["Alex Sample", "Experience", "Example Labs", "Jan 2018 - Jun 2020", "Built the first editor.",
    "Example Labs", "July 2021 - Present", "Built offline storage."]);
  assert.equal(content.resume.work.length, 2);
  assert.deepEqual(content.resume.work.map(entry => [entry.title, entry.start, entry.end]), [
    ["Example Labs", "2018-01", "2020-06"], ["Example Labs", "2021-07", "至今"],
  ]);
  assert.ok(content.resume.work[0].html.includes("Built the first editor."));
  assert.ok(content.resume.work[1].html.includes("Built offline storage."));
});

test("undated and incomplete English date text stays editable without inventing dates", () => {
  for (const line of ["Example Labs", "Example Labs January", "Example Labs Jan 2020", "Example Labs Winter 2020 - Summer 2024"]) {
    const content = recognize(["Alex Sample", "Experience", line, "Built offline storage."]);
    assert.equal(content.resume.work[0].title, line);
    assert.equal(content.resume.work[0].start, "");
    assert.equal(content.resume.work[0].end, "");
    assert.match(content.warnings.join("\n"), /未识别到起止日期/);
    assert.ok(content.extractedText.includes(line));
  }
});
