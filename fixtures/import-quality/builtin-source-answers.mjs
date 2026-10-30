// Independent authored display answers for the six published-engine controls.
// No PDF parser, TextMap, rendering engine, or observed extraction is imported.
// Semantic seed answers stay unchanged; this describes what the release rules
// display from them, before any importer sees the PDF.
import { builtinPageAnnotation } from "./builtin-page-annotations.mjs";
export const builtinSourceRuleEvidence = Object.freeze({
  revision: "a60e2eb1874b0fa90a23156af38b5332416c0c06",
  version: "2.0.0-alpha.2",
  verifiedAgainstArchivedReceipt: ".artifacts/releases/2.0.0-alpha.2/build-native.json",
  files: [
    { path: "crates/zinecv-engine/src/lib.rs", sha256: "171ab17c948f4280117c5657d51ae3f4aec2b88ca772d966fed2d91998f777cf",
      rules: ["contact_layout_for_date", "site_label", "date_label", "range_label", "entry_meta", "inline_meta", "layout_json"] },
    { path: "crates/zinecv-engine/src/templates.typ", sha256: "46dc04967c106972b257d59988165c171213fe348e7ac7052e3e142c9d5905c1",
      rules: ["contactLine", "siteCell", "sectionHead", "entryHead", "pagedSection"] },
  ],
  scope: "Authored source-display rules only; no import, current-host, hyperlink-annotation or page-placement qualification",
});

const glyphs = Object.freeze({ phone: "\ue75b", email: "\ue74a", website: "\ue75c",
  education: "\ue76f", work: "\ue76d", skills: "\ue76b" });

function chineseMonth(value) {
  if (!value || !value.includes("-") || [...value].length < 7) return value ?? "";
  const [year, month] = value.split("-");
  return `${year}年${month}月`;
}

function plain(text, semanticParagraphIndices = []) {
  return { kind: "content", text, semanticParagraphIndices };
}

function decoration(text) {
  return { kind: "decoration", text, semanticParagraphIndices: [] };
}

export function builtinSourceAnswer(sample, pdfSha256) {
  if (sample.group !== "builtin" || !["legacy-v1", "clear-single-v1", "compact-single-v1"].includes(sample.family)) {
    throw new Error("Builtin source answers apply only to the three declared published templates");
  }
  const semantic = sample.truth;
  const readingUnits = [];
  const destinationsMapping = {};
  const semanticSpans = [];
  const append = (kind, fragments, semanticParagraphIndices, details = {}) => {
    const index = readingUnits.length;
    // Geometric gaps between separate template cells are represented by one
    // comparison space. Physical wrapping/newline positions are not authored
    // paragraph boundaries and must be normalized by the evaluator separately.
    const text = fragments.map(fragment => fragment.text).filter(Boolean).join(" ");
    readingUnits.push({ index, kind, text, fragments, semanticParagraphIndices, ...details });
    for (const semanticParagraphIndex of semanticParagraphIndices) {
      destinationsMapping[semanticParagraphIndex] = index;
      semanticSpans.push({ semanticParagraphIndex, sourceReadingUnitIndex: index,
        fragments: fragments.filter(fragment => fragment.semanticParagraphIndices.includes(semanticParagraphIndex)) });
    }
    return index;
  };
  append("name", [plain(semantic.fields["basic.name"], [0])], [0]);
  // Both values are in one source contact row, in this order. The icon glyphs
  // are explicit known source decoration, not permission to strip arbitrary PUA.
  append("contact-row", [decoration(glyphs.phone), plain(semantic.fields["basic.phone"], [1]),
    decoration(glyphs.email), plain(semantic.fields["basic.email"], [2])], [1, 2]);
  const targetUrl = semantic.fields["basic.website"];
  const websiteLabel = targetUrl.replace(/^https?:\/\//, "");
  append("website", [decoration(glyphs.website), plain(websiteLabel, [3])], [3], {
    displayedLabel: websiteLabel, targetUrl,
    targetEvidence: "Semantic seed URL; PDF link-annotation presence is a separate output check",
  });
  const sectionGlyphsShown = sample.family !== "clear-single-v1";
  const sectionHeader = (kind, semanticParagraphIndex) => append("section-heading", [
    ...(sectionGlyphsShown ? [decoration(glyphs[kind])] : []),
    plain(semantic.paragraphs[semanticParagraphIndex], [semanticParagraphIndex]),
  ], [semanticParagraphIndex], { section: kind });
  const entryHeading = (kind, paragraphIndex, showFullTime) => {
    const title = semantic.fields[`${kind}.0.title`];
    const start = semantic.fields[`${kind}.0.start`] ?? "";
    const end = semantic.fields[`${kind}.0.end`] ?? "";
    const dates = `${chineseMonth(start)} - ${chineseMonth(end)}`;
    return append("entry-heading", [plain(title, [paragraphIndex]),
      ...(showFullTime ? [plain("- 全日制", [paragraphIndex])] : []),
      plain(dates, [paragraphIndex])], [paragraphIndex], {
      section: kind, displayedDates: { start: chineseMonth(start), end: chineseMonth(end) },
      semanticDates: { start, end }, displayedDefaultMode: showFullTime ? "全日制" : null,
      defaultReason: showFullTime ? "Seed education.mode is null; release entry_meta defaults it to 全日制" : null,
    });
  };
  sectionHeader("education", 4);
  entryHeading("education", 5, true);
  append("body", [plain(semantic.paragraphs[6], [6])], [6], { target: "education.0.html" });
  sectionHeader("work", 7);
  entryHeading("work", 8, false);
  const skillHeadingIndex = semantic.paragraphs.length - 2;
  for (let index = 9; index < skillHeadingIndex; index += 1) {
    append("body", [plain(semantic.paragraphs[index], [index])], [index], { target: "work.0.html" });
  }
  sectionHeader("skills", skillHeadingIndex);
  const skillsBodyIndex = semantic.paragraphs.length - 1;
  append("body", [plain(semantic.paragraphs[skillsBodyIndex], [skillsBodyIndex])], [skillsBodyIndex], { target: "skills.0.html" });

  const paragraphs = readingUnits.map(unit => unit.text);
  const pageAnnotation = builtinPageAnnotation(sample.id, pdfSha256, paragraphs.length);
  return { schemaVersion: 1, sampleId: sample.id, evidence: builtinSourceRuleEvidence,
    // Editable-field display form: the release engine renders the website
    // without its protocol (site_label). Other semantic fields survive the
    // source rules unchanged (dates are re-normalized by the evaluator).
    fields: { ...semantic.fields, "basic.website": websiteLabel },
    paragraphs, sourceParagraphs: [...paragraphs], readingUnits,
    paragraphPages: paragraphs.map((_, index) => pageAnnotation?.paragraphPageSpans[index][0] ?? null),
    pageAnnotation, destinationsMapping, semanticSpans,
    bodyDestinations: semantic.destinations.map(destination => ({ ...destination,
      semanticParagraphIndex: destination.paragraphIndex,
      sourceReadingUnitIndex: destinationsMapping[destination.paragraphIndex] })),
    decorations: { literalGlyphs: glyphs, sectionGlyphsShown,
      policy: "Explicit fragments only; never globally erase private-use, punctuation, numbers or duplicate text" },
    pagination: { expectedPageCount: pageAnnotation?.pageCount ?? null,
      pagePlacement: pageAnnotation ? "independently reviewed source pages; spanning paragraphs retain all pages in pageAnnotation"
        : "pending independent annotation for these exact PDF bytes",
      continuationHeadingRule: "pagedSection repeats that section heading only at page continuation; score only after a page-scoped annotation identifies it",
      repeatableSectionHeadings: semantic.sections.map(section => ({ section,
        sourceReadingUnitIndex: readingUnits.find(unit => unit.kind === "section-heading" && unit.section === section).index,
        maximumPerContinuationPage: 1, requiresPageScopedMatching: true })) },
    comparison: { textOrder: "readingUnits order is authoritative; physical line wrapping is not a semantic boundary",
      whitespace: "One comparison space between declared adjacent source fragments; evaluator must report its own predeclared wrapping normalization",
      dates: "Source Chinese YYYY年MM月, including zero-padded month; semantic dates remain original YYYY-MM",
      website: "Source displays URL without http(s) prefix; semantic target is recorded separately without asserting a PDF annotation" },
  };
}
