// Independently reviewed with Poppler page rasters on 2026-10-30. Neither
// importer output nor TextMap establishes these source-page answers. A digest
// identifies the reviewed input, not a permanent freeze on future fixtures.
const annotations = {
  "IQ-01": { pdfSha256: "9e8508a6a5541058046e7279faf4b1314df5cb10c11cbde13c7d09b3382887a1", pageCount: 1, units: 11 },
  "IQ-02": { pdfSha256: "c6b9c530dd332bc4b74c2f4822014aa188732342191d5144c5ba0f72979f1442", pageCount: 1, units: 43 },
  "IQ-03": { pdfSha256: "da97020d27449038f267223961c0e45be6963af6a4737539aec6bc6011067174", pageCount: 1, units: 11 },
  // Records 01–23 finish on page 1; record 24 and Skills start on page 2.
  "IQ-04": { pdfSha256: "94e5e2c80186d094325139a6760afdb16c2dd80a3cf5092f59a73b9336a6ab64", pageCount: 2, units: 43, secondPageFrom: 32 },
  "IQ-05": { pdfSha256: "d76726f0e804aa3fbef63fa6d2429f9a58bb029ec41f088853539ffff0cc2fdc", pageCount: 1, units: 11 },
  // Record 29 spans both pages; records 30–32 and Skills start on page 2.
  "IQ-06": { pdfSha256: "d468433f68b840a6a01a2a26cea6faf147957be2667c84bdc644cad33152c9e5", pageCount: 2, units: 43, secondPageFrom: 38, spanningUnit: 37 },
};

export function builtinPageAnnotation(id, pdfSha256, units) {
  const source = annotations[id];
  if (!source || source.pdfSha256 !== pdfSha256 || source.units !== units) return null;
  return { method: "independent visual review of Poppler-rendered source PDF pages", reviewedAt: "2026-10-30",
    pdfSha256, pageCount: source.pageCount,
    paragraphPageSpans: Array.from({ length: units }, (_, index) => index === source.spanningUnit
      ? [1, 2] : [index >= (source.secondPageFrom ?? units) ? 2 : 1]),
    continuationHeadings: [],
  };
}
