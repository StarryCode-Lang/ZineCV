import { readFileSync } from "node:fs";

const retiredHoldouts = await Promise.all([4, 5].map(async version =>
  JSON.parse(readFileSync(new URL(`./blind-holdout-policy${version}.json`, import.meta.url), "utf8"))));

const frozenHoldout = JSON.parse(readFileSync(new URL("./blind-holdout-policy6.json", import.meta.url), "utf8"));

// Independent, anonymous answers. Do not import recognition/mapping code here.
// Recipes, rather than binary PDFs/screenshots, are the controlled source.
export const policy = Object.freeze({
  version: 5,
  normalization: "NFC; CRLF to LF; collapse horizontal whitespace; trim each line; keep digits, punctuation and paragraph order. Character accuracy is whitespace-insensitive (declared wrapping normalization: physical line breaks insert no source characters); field equality and paragraph correspondence keep the line-structured normalization",
  textAccuracy: 0.99,
  ocrAccuracy: 0.95,
  fieldF1: 0.95,
  criticalExact: true,
  license: "Project-authored synthetic material; no real personal data; repository license applies",
});

const groups = [
  ["builtin", 0, "zinecv-export", "pdf"],
  ["single", 2, "chromium-print", "pdf"],
  ["columns", 2, "chromium-print", "pdf"],
  ["complex", 2, "chromium-print", "pdf"],
  ["scan", 2, "canvas-jpeg-pdf", "pdf"],
  ["mixed", 2, "canvas-jpeg-pdf", "pdf"],
  ["docx", 1, "ooxml-package", "docx"],
  ["image", 1, "svg-canvas-raster", "png"],
];

// Family IDs are rendering recipes, not split labels or color variants. The
// same raster recipe is deliberately shared across PDF/image groups. Families
// whose failures were used for fixing (hanging-labels, cross-column,
// dashboard, raster-ledger) moved to development slots; holdout slots use the
// six unseen recipes added in policy 3.
export const familyLayouts = Object.freeze({
  ...Object.fromEntries([4, 5].flatMap(version => retiredHoldouts[version - 4].families)
    .concat(frozenHoldout.families).map(family => [family.id, { renderer: family.renderer, layout: family.layout }])),
  "html-stack": { renderer: "html", layout: "stack" },
  "html-identity-row": { renderer: "html", layout: "identity-row" },
  "html-hanging-labels": { renderer: "html", layout: "hanging-labels" },
  "html-equal-columns": { renderer: "html", layout: "equal-columns" },
  "html-sidebar": { renderer: "html", layout: "sidebar" },
  "html-cross-column": { renderer: "html", layout: "cross-column" },
  "html-three-panels": { renderer: "html", layout: "three-panels" },
  "html-time-axis": { renderer: "html", layout: "time-axis" },
  "html-dashboard": { renderer: "html", layout: "dashboard" },
  "html-banner": { renderer: "html", layout: "banner" },
  "html-right-rail": { renderer: "html", layout: "right-rail" },
  "html-footer-nav": { renderer: "html", layout: "footer-nav" },
  "raster-stack": { renderer: "raster", layout: "stack" },
  "raster-siderail": { renderer: "raster", layout: "siderail" },
  "raster-ledger": { renderer: "raster", layout: "ledger" },
  "raster-banner": { renderer: "raster", layout: "banner" },
  "raster-two-band": { renderer: "raster", layout: "two-band" },
  "raster-right-rail": { renderer: "raster", layout: "right-rail" },
  "ooxml-paragraphs": { renderer: "ooxml", layout: "paragraphs" },
  "ooxml-table": { renderer: "ooxml", layout: "table" },
  "ooxml-textbox": { renderer: "ooxml", layout: "textbox" },
  "ooxml-two-columns": { renderer: "ooxml", layout: "two-columns" },
});

const groupFamilies = {
  single: ["html-stack", "html-stack", "html-identity-row", "html-hanging-labels", "html-banner", "html-banner"],
  columns: ["html-equal-columns", "html-equal-columns", "html-sidebar", "html-cross-column", "html-right-rail", "html-right-rail"],
  complex: ["html-three-panels", "html-three-panels", "html-time-axis", "html-dashboard", "html-footer-nav", "html-footer-nav"],
  scan: ["raster-stack", "raster-stack", "raster-siderail", "raster-ledger", "raster-banner", "raster-banner"],
  mixed: ["raster-stack", "raster-stack", "raster-siderail", "raster-ledger", "raster-two-band", "raster-two-band"],
  docx: ["ooxml-paragraphs", "ooxml-paragraphs", "ooxml-table", "ooxml-paragraphs", "ooxml-textbox", "ooxml-two-columns"],
  image: ["raster-stack", "raster-stack", "raster-stack", "raster-siderail", "raster-ledger", "raster-right-rail"],
};

function answer(language, serial, variant) {
  const chinese = language !== "en";
  const name = chinese ? "林合成" : "Alex Sample";
  const university = chinese ? "合成大学" : "Sample University";
  const employer = chinese ? "示例科技" : "Example Labs";
  const work = chinese ? "工作经历" : "Work Experience";
  const education = chinese ? "教育经历" : "Education";
  const skills = chinese ? "专业技能" : "Skills";
  const body = language === "zh" ? "维护离线排版与数据备份。" : "Maintained offline typography and data backups.";
  const email = `sample${serial}@example.invalid`;
  const website = `https://example.invalid/portfolio/${serial}?view=resume`;
  const noDates = variant === 1;
  const englishMonths = variant === 2;
  const multiple = variant === 3;
  const paragraphs = [name, "13800000000", email, website, education,
    noDates ? university : `${university} 2016-09 - 2020-06`, chinese ? "计算机科学" : "Computer Science", work,
    noDates ? employer : englishMonths ? `${employer} Jan 2020 - Jun 2024` : `${employer} 2020-07 - 2024-06`, body];
  if (multiple) paragraphs.push(`${employer} 2022-01 - 2023-12`, chinese ? "同期维护独立的本地搜索项目。" : "Maintained a separate local search project concurrently.");
  paragraphs.push(skills, "JavaScript Python SQL");
  const fields = { "basic.name": name, "basic.phone": "13800000000", "basic.email": email,
    "basic.website": website, "education.0.title": university, "work.0.title": employer };
  if (!noDates) Object.assign(fields, { "education.0.start": "2016-09", "education.0.end": "2020-06",
    "work.0.start": englishMonths ? "2020-01" : "2020-07", "work.0.end": "2024-06" });
  if (multiple) Object.assign(fields, { "work.1.title": employer, "work.1.start": "2022-01", "work.1.end": "2023-12" });
  const destinations = [
    { paragraphIndex: 6, path: "education.0.html", text: paragraphs[6], disposition: "mapped" },
    { paragraphIndex: 9, path: "work.0.html", text: paragraphs[9], disposition: "mapped" },
    ...(multiple ? [{ paragraphIndex: 11, path: "work.1.html", text: paragraphs[11], disposition: "mapped" }] : []),
    { paragraphIndex: paragraphs.length - 1, path: "skills.0.html", text: paragraphs.at(-1), disposition: "mapped" },
  ];
  return {
    paragraphs,
    fields, destinations,
    critical: Object.keys(fields).filter(path => path !== "basic.website"),
    sections: ["education", "work", "skills"],
    entryCounts: { education: 1, work: multiple ? 2 : 1, skills: 1 },
    dimensions: { noDates, englishMonths, sameEmployer: multiple, overlappingDates: multiple, multipleEntries: multiple },
  };
}

export const samples = groups.flatMap(([group, reserved, source, extension], groupIndex) =>
  Array.from({ length: 6 }, (_, index) => {
    // Preserve the original policy-3 variant decision when retiring all 48 to development.
    const originalSplit = index >= 6 - reserved ? "holdout" : "development";
    const split = "development";
    const serial = groupIndex * 6 + index + 1;
    const language = ["en", "zh", "mixed"][index % 3];
    const family = group === "builtin" ? ["legacy-v1", "clear-single-v1", "compact-single-v1"][Math.floor(index / 2)] : groupFamilies[group][index];
    const truth = answer(language, serial, group !== "builtin" && originalSplit === "development" ? index : 0);
    const lengthVariant = group === "builtin" && index % 2 === 1 ? "long" : "short";
    if (group === "builtin" && lengthVariant === "long") {
      const insertion = truth.paragraphs.length - 2;
      const records = Array.from({ length: 32 }, (_, paragraph) => {
        const label = String(paragraph + 1).padStart(2, "0");
        return language === "en"
          ? `Synthetic delivery record ${label}: Maintained offline document storage and typography. Reviewed deterministic backups and local search. Preserved explicit source references and reversible edits for every release.`
          : `合成交付记录${label}：维护离线文档存储与排版流程，核对可重复恢复的备份及本地搜索结果。每次交付保留明确的内容来源和可撤回修改，逐项复查匿名测试资料的字段归属、日期和导出正文。`;
      });
      truth.paragraphs.splice(insertion, 0, ...records);
      for (const destination of truth.destinations) {
        if (destination.paragraphIndex >= insertion) destination.paragraphIndex += records.length;
      }
      truth.destinations.push(...records.map((text, paragraph) => ({ paragraphIndex: insertion + paragraph,
        path: "work.0.html", text, disposition: "mapped" })));
    }
    // Scan and mixed PDFs really contain two or three pages. Text pages and
    // image pages have disjoint answer ranges; answers never come from OCR.
    const pageCount = group === "builtin" ? null : group === "scan" || group === "mixed" ? (index === 3 ? 3 : 2) : group === "single" && index === 3 || group === "docx" && index === 3 ? 2 : 1;
    const paragraphsPerPage = Math.ceil(truth.paragraphs.length / pageCount);
    const paragraphPages = truth.paragraphs.map((_, row) => pageCount === null ? null : Math.min(pageCount, Math.floor(row / paragraphsPerPage) + 1));
    if (group === "docx" && index === 3) truth.paragraphs.forEach((_, row) => { paragraphPages[row] = row < 9 ? 1 : 2; });
    const layout = familyLayouts[family]?.layout ?? family;
    const pdfPageKinds = group === "scan" ? Array(pageCount).fill("image") : group === "mixed"
      ? index < 2 ? ["text", "image"] : index < 4 ? Array(pageCount).fill("image-with-text-header") : ["image", "text"] : undefined;
    return { id: `IQ-${String(serial).padStart(2, "0")}`, group, split, family, source, extension,
      language, pageCount, index, lengthVariant, license: policy.license,
      textLayer: group === "scan" || group === "image" ? "none" : group === "mixed" ? "mixed" : "text",
      support: group === "complex" ? "explicit-degradation" : "content-and-structure",
      truth: { ...truth, paragraphPages },
      recipe: { layout, pdfPageKinds, columns: group === "columns" ? 2 : group === "complex" ? 3 : 1,
        rotated: group === "scan" && index === 3 || group === "image" && index === 4,
        lowContrast: group === "scan" && index === 2,
        smallText: group === "image" && index === 1,
        longImage: group === "image" && index === 2,
        transparent: group === "image" && index === 3,
        headerOnlyText: group === "mixed" && index >= 2 && index < 4 },
    };
  })).concat(...retiredHoldouts.map(version => structuredClone(version.samples)
      .map(sample => ({ ...sample, split: "development" }))),
    structuredClone(frozenHoldout.samples));

export const boundaryCases = [
  ["empty", "Empty input"], ["corrupt", "Truncated PDF"],
  ["encrypted", "Password-protected PDF"], ["mismatch", "PNG bytes named PDF"],
  ["zip-ratio", "DOCX compression ratio exceeds 100"], ["size", "Input exceeds 18 MiB"],
  ["pages", "PDF exceeds 50 pages"], ["pixels", "Image exceeds 40 million pixels"],
  ["timeout", "120 second timeout"], ["cancel", "Cancel during OCR and retry"],
  ["retry", "Repeated parser failure releases task"], ["target", "Switch document during import"],
].map(([kind, description], index) => ({ id: `IQ-B${String(index + 1).padStart(2, "0")}`, kind, description,
  split: "boundary", expected: "reject-or-safe-operation" }));

export function validateCorpus() {
  if (samples.length !== 84 || boundaryCases.length !== 12) throw new Error("Expected 84+12 cases");
  if (samples.filter(row => row.split === "holdout").length !== 12) throw new Error("Expected 12 external holdouts");
  const families = new Map();
  const geometries = new Map();
  for (const sample of samples) {
    if (families.has(sample.family) && families.get(sample.family) !== sample.split) throw new Error(`Family leakage: ${sample.family}`);
    families.set(sample.family, sample.split);
    const geometry = sample.group === "builtin" ? `builtin:${sample.family}` : JSON.stringify(familyLayouts[sample.family]);
    if (!geometry) throw new Error(`Unknown rendering recipe: ${sample.family}`);
    if (geometries.has(geometry) && geometries.get(geometry) !== sample.split) throw new Error(`Geometry leakage: ${sample.family}`);
    geometries.set(geometry, sample.split);
    if (sample.truth.paragraphPages.length !== sample.truth.paragraphs.length) throw new Error("Missing page annotations");
    if (sample.split === "holdout" && sample.group === "builtin") throw new Error("Internal holdout");
    if (sample.group === "mixed" && (!sample.recipe.pdfPageKinds.some(kind => kind !== "image") || !sample.recipe.pdfPageKinds.some(kind => kind !== "text"))) throw new Error(`Invalid mixed layers: ${sample.id}`);
    for (const destination of sample.truth.destinations) {
      if (sample.truth.paragraphs[destination.paragraphIndex] !== destination.text) throw new Error(`Invalid destination: ${sample.id}`);
    }
  }
  return { valid: 84, boundary: 12, development: 72, holdout: 12,
    externalFamilies: new Set(samples.filter(row => row.group !== "builtin").map(row => row.family)).size,
    sources: [...new Set(samples.filter(row => row.group !== "builtin").map(row => row.source))] };
}
