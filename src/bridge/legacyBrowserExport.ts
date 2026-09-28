const expectedOrigin = "http://127.0.0.1:5173";
const maxExportLength = 64 * 1024 * 1024;
const fixedKeys = new Set([
  "resume-diy-active-imported-template",
  "resume-diy-agent-mode-v1",
  "resume-diy-agent-position-v1",
  "resume-diy-agent-size-v1",
  "resume-diy-editor-pane-width",
  "resume-diy-imported-templates-v1",
  "resume-diy-layout-consistency-v1",
  "resume-diy-module-names",
  "resume-diy-modules",
  "resume-diy-preferences",
  "resume-diy-presentation-v1",
  "resume-diy-section-order-v2",
  "resume-diy-smart-fit-signature-v3",
  "resume-diy-state",
  "resume-diy-summary-title",
  "resume-diy-template-library-v1",
  "resume-diy-title",
  "resume-diy-version-project-revision",
  "resume-diy-version-store-v1",
  "resume-diy-version-store-v1-backup",
]);

export type LegacyBrowserExportIssue = {
  issueType: "invalidFormat" | "invalidEntry" | "duplicateKey" | "hashMismatch" | "resourceLimit" | "unrecognizedAppKey";
  path: string;
  severity: "error" | "review";
};

export type LegacyBrowserExportInspection = {
  valid: boolean;
  readyForMigration: boolean;
  sourceHash: string | null;
  entries: Array<[string, string]> | null;
  issues: LegacyBrowserExportIssue[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recognizedKey(key: string): boolean {
  return fixedKeys.has(key) ||
    key.startsWith("resume-diy-agent-sessions-v2:") ||
    key.startsWith("resume-diy-source-preview-dismissed:");
}

export async function inspectLegacyBrowserExport(rawJson: string): Promise<LegacyBrowserExportInspection> {
  const issues: LegacyBrowserExportIssue[] = [];
  const rejected = (): LegacyBrowserExportInspection => ({
    valid: false, readyForMigration: false, sourceHash: null, entries: null, issues,
  });
  if (rawJson.length > maxExportLength) {
    issues.push({ issueType: "resourceLimit", path: "file", severity: "error" });
    return rejected();
  }
  let parsed: unknown;
  try { parsed = JSON.parse(rawJson); }
  catch {
    issues.push({ issueType: "invalidFormat", path: "file", severity: "error" });
    return rejected();
  }
  if (!isRecord(parsed) || parsed.format !== "zinecv-legacy-browser-export" || parsed.version !== 1 ||
      parsed.origin !== expectedOrigin || typeof parsed.exportedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.exportedAt)) ||
      typeof parsed.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(parsed.sourceHash) ||
      !Array.isArray(parsed.entries)) {
    issues.push({ issueType: "invalidFormat", path: "manifest", severity: "error" });
    return rejected();
  }
  const entries: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (let index = 0; index < parsed.entries.length; index += 1) {
    const entry: unknown = parsed.entries[index];
    const path = `entries[${index}]`;
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" ||
        typeof entry[1] !== "string" || !entry[0].startsWith("resume-diy-")) {
      issues.push({ issueType: "invalidEntry", path, severity: "error" });
      continue;
    }
    if (seen.has(entry[0])) issues.push({ issueType: "duplicateKey", path, severity: "error" });
    seen.add(entry[0]);
    if (!recognizedKey(entry[0])) issues.push({ issueType: "unrecognizedAppKey", path, severity: "review" });
    entries.push([entry[0], entry[1]]);
  }
  if (issues.some((issue) => issue.severity === "error")) return rejected();
  if (entries.some(([key], index) => index > 0 && entries[index - 1][0].localeCompare(key) > 0)) {
    issues.push({ issueType: "invalidEntry", path: "entries", severity: "error" });
    return rejected();
  }
  const bytes = new TextEncoder().encode(JSON.stringify(entries));
  const actualHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actualHash !== parsed.sourceHash) {
    issues.push({ issueType: "hashMismatch", path: "sourceHash", severity: "error" });
    return rejected();
  }
  return {
    valid: true,
    readyForMigration: issues.length === 0,
    sourceHash: actualHash,
    entries,
    issues,
  };
}
