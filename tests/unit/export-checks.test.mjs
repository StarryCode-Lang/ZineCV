import { test } from "node:test";
import assert from "node:assert/strict";
import { checkExportContent, exportDateRange } from "../../src/ui/services/export-checks.ts";

const entry = (id, start, end) => ({ id, title: "Company", role: "Engineer", department: "", city: "", start, end,
  body: [{ type: "paragraph", children: [{ type: "text", text: "Delivered a documented feature", marks: [] }] }] });
const document = entries => ({ basic: { name: "Synthetic Name", phone: "", email: "synthetic@example.invalid" },
  sections: [{ id: "work", kind: "work", title: "工作经历", visible: true, entries }], presentation: { fontSizePt: 10 } });

test("export date ranges preserve year/month uncertainty, leap days and ongoing employment", () => {
  assert.equal(new Date(exportDateRange("2024年2月").max).toISOString(), "2024-02-29T23:59:59.999Z");
  assert.equal(new Date(exportDateRange("2024-02-29").min).toISOString(), "2024-02-29T00:00:00.000Z");
  assert.equal(new Date(exportDateRange("2024-02-29").max).toISOString(), "2024-02-29T23:59:59.999Z");
  assert.equal(exportDateRange("2023-02-29"), null);
  assert.equal(exportDateRange("2024.13"), null);
  assert.equal(exportDateRange("Spring 2024"), null);
  assert.equal(exportDateRange("至今").max, Infinity);
});

test("preflight flags definite reversal but never treats overlapping year precision or parallel jobs as errors", () => {
  const value = document([entry("year", "2024", "2024.02"), entry("parallel", "2023.01", "至今")]);
  const before = structuredClone(value);
  assert.equal(checkExportContent(value).some(finding => finding.severity === "error"), false);
  assert.deepEqual(value, before);
  const reversed = checkExportContent(document([entry("reversed", "2025.01", "2024.12")]));
  assert.equal(reversed.filter(finding => finding.severity === "error").length, 1);
  assert.equal(reversed[0].field, "entry:reversed/start");
  assert.deepEqual(reversed[0].target, { kind: "module", module: "work", entryId: "reversed", fieldLabel: "经历时间" });
});

test("preflight findings point to real fields and keep empty hidden modules out of warnings", () => {
  const value = document([entry("one", "2024.01", "2024.12"), entry("two", "2024.01", "2024.12")]);
  value.basic.email = "TODO";
  value.sections.push({ id: "hidden", kind: "projects", title: "hidden", visible: false, entries: [] });
  const findings = checkExportContent(value);
  assert.ok(findings.some(finding => finding.id === "duplicate-two" && finding.target.entryId === "two"));
  assert.ok(findings.some(finding => finding.field === "basic.email" && finding.target.kind === "basic"));
  assert.equal(findings.some(finding => finding.id === "empty-hidden"), false);
});
