import { after, describe } from "node:test";
import { enableSharedBrowserTestServers, closeSharedBrowserTestServers } from "../tests/browser/fixtures/browser-test-server.mjs";

// Only independent Chromium tests overlap. Each test retains fresh isolated
// contexts, storage and teardown; real WebView2/native tests remain serial.
const concurrency = Number(process.env.ZINECV_BROWSER_CONCURRENCY ?? 4);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
  throw new Error("ZINECV_BROWSER_CONCURRENCY must be an integer from 1 to 4");
}

const files = [
  "branch-magazine.test.mjs",
  "document-bridge.test.mjs",
  "document-switching.test.mjs",
  "editor-ordering.test.mjs",
  "editorial-brief.test.mjs",
  "editorial-command.test.mjs",
  "editorial-navigation.test.mjs",
  "editorial-preview.test.mjs",
  "editorial-rail.test.mjs",
  "engine-preview.test.mjs",
  "export-output.test.mjs",
  "import-page-completeness.test.mjs",
  "import-preview-sandbox.test.mjs",
  "import-quality-golden.test.mjs",
  "import-review-corrections.test.mjs",
  "imported-layout-components.test.mjs",
  "jobs.test.mjs",
  "legacy-export.test.mjs",
  "legacy-richtext.test.mjs",
  "legacy-snapshot.test.mjs",
  "local-ocr-assets.test.mjs",
  "pagination-long-entry.test.mjs",
  "pagination-spacing.test.mjs",
  "pdf-column-import.test.mjs",
  "rich-editor.test.mjs",
  "shell.test.mjs",
  "source-layout-pdf.test.mjs",
  "source-layout-word.test.mjs",
  "source-layout-workspace.test.mjs",
  "synthetic-docx-import.test.mjs",
  "synthetic-pdf-import.test.mjs",
  "update-install-guard.test.mjs",
  "zinebot-mark.test.mjs",
];
describe("isolated browser regression", { concurrency }, async () => {
  enableSharedBrowserTestServers();
  after(closeSharedBrowserTestServers);
  try {
    // Start the independent long cases first so they do not form a serial tail.
    // The canonical inventory above remains complete and sorted for auditing.
    const priority = ["local-ocr-assets", "rich-editor", "pagination-long-entry"];
    const rank = file => {
      const index = priority.indexOf(file.replace(/\.test\.mjs$/, ""));
      return index < 0 ? priority.length : index;
    };
    for (const file of [...files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
      await import(`../tests/browser/${file}`);
    }
  } catch (error) {
    await closeSharedBrowserTestServers();
    throw error;
  }
});
