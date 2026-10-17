import { after } from "node:test";
import { enableSharedBrowserTestServers, closeSharedBrowserTestServers } from "../tests/browser/fixtures/browser-test-server.mjs";

// One test process shares only Vite's immutable fixture/configuration source.
// Each existing test still launches and closes its own Chromium and context.
enableSharedBrowserTestServers();
after(closeSharedBrowserTestServers);

const files = [
  "document-bridge.test.mjs",
  "editor-ordering.test.mjs",
  "engine-preview.test.mjs",
  "import-preview-sandbox.test.mjs",
  "import-quality-golden.test.mjs",
  "legacy-export.test.mjs",
  "legacy-richtext.test.mjs",
  "legacy-snapshot.test.mjs",
  "local-ocr-assets.test.mjs",
  "pagination-long-entry.test.mjs",
  "pagination-spacing.test.mjs",
  "pdf-column-import.test.mjs",
  "rich-editor.test.mjs",
  "shell.test.mjs",
  "synthetic-docx-import.test.mjs",
  "synthetic-pdf-import.test.mjs",
];
try {
  for (const file of files) await import(`../tests/browser/${file}`);
} catch (error) {
  await closeSharedBrowserTestServers();
  throw error;
}
