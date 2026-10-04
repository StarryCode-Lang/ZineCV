export const IMPORT_LIMITS = Object.freeze({
  fileBytes: 18 * 1024 * 1024,
  pages: 50,
  imagePixels: 40_000_000,
  docxExpandedBytes: 128 * 1024 * 1024,
  docxCompressionRatio: 100,
  docxEntries: 2_000,
  previewBytes: 8 * 1024 * 1024,
  reviewBytes: 2 * 1024 * 1024,
  concurrentParsers: 1,
  timeoutMs: 120_000,
});
