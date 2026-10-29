import { createElement } from "react";
import { createRoot } from "react-dom/client";
export const React = { createElement };
export { createRoot };
export { ExportReviewHost, useExportHost } from "../../../src/ui/app/ExportReviewHost";
export { registerPlatformInvoke } from "../../../src/platform/ipc";
export { nativeClient } from "../../../src/platform/workspace";
import "../../../src/ui/styles/export-review.css";
