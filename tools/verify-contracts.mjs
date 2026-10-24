import { access, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { validateAcceptanceIds, decodeFeatureMatrix, decodeEvidenceBundle } from "./acceptance-matrix.mjs";

const root = resolve(import.meta.dirname, "..");
const matrix = decodeFeatureMatrix(JSON.parse(await readFile(resolve(root, "docs/feature-parity.json"), "utf8")));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const fixture = JSON.parse(await readFile(resolve(root, "contracts/poc-contract-v1.json"), "utf8"));
const [rustHost, commandType, errorType, capability] = await Promise.all([
  readFile(resolve(root, "src-tauri/src/lib.rs"), "utf8"),
  readFile(resolve(root, "src-tauri/src/domain/bindings/NativeIpcCommandName.ts"), "utf8"),
  readFile(resolve(root, "src-tauri/src/domain/bindings/ErrorCode.ts"), "utf8"),
  readFile(resolve(root, "src-tauri/capabilities/default.json"), "utf8").then(JSON.parse),
]);
const mandatoryIds = validateAcceptanceIds(matrix);
const ids = new Set(matrix.map((entry) => entry.featureId));
const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const evidenceKinds = new Set(["U", "B", "N", "V", "M", "D", "R"]);
const ensureRepositoryFile = async (reference, label, featureId) => {
  const localPath = reference.split("#", 1)[0];
  if (!isNonEmptyString(localPath) || localPath.includes("://") || localPath.includes(":") || isAbsolute(localPath)) {
    throw new Error(`${label} for ${featureId} must be a repository-relative path`);
  }
  const absolutePath = resolve(root, localPath);
  const repositoryRelative = relative(root, absolutePath);
  if (repositoryRelative === ".." || repositoryRelative.startsWith(`..${sep}`) || isAbsolute(repositoryRelative)) {
    throw new Error(`${label} for ${featureId} escapes the repository`);
  }
  await access(absolutePath);
  return absolutePath;
};
for (const entry of matrix) {
  if (!["pending", "in_progress", "passed", "blocked", "failed"].includes(entry.status)) {
    throw new Error(`Invalid status for ${entry.featureId}`);
  }
  for (const field of ["implementationPaths", "tests", "evidence", "remainingIssues"]) {
    if (!Array.isArray(entry[field]) || entry[field].some((value) => !isNonEmptyString(value))) {
      throw new Error(`${entry.featureId}.${field} must be an array of non-empty strings`);
    }
  }
  if (entry.status === "passed") {
    if (!isNonEmptyString(entry.revision) || !entry.implementationPaths.length || !entry.tests.length || !entry.evidence.length) {
      throw new Error(`Passed item ${entry.featureId} lacks revision, implementation path, test or evidence`);
    }
    if (!entry.environment || typeof entry.environment !== "object" || Array.isArray(entry.environment)) {
      throw new Error(`Passed item ${entry.featureId} lacks a structured environment record`);
    }
    if (entry.remainingIssues.length) throw new Error(`Passed item ${entry.featureId} still lists remaining issues`);
    for (const reference of entry.implementationPaths) {
      await ensureRepositoryFile(reference, "implementation path", entry.featureId);
    }
    for (const reference of entry.evidence) {
      const evidencePath = await ensureRepositoryFile(reference, "evidence path", entry.featureId);
      if (!evidencePath.endsWith(".json")) {
        throw new Error(`Passed item ${entry.featureId} evidence must be a JSON evidence record`);
      }
      const data = JSON.parse(await readFile(evidencePath, "utf8"));
      const fragment = reference.includes("#") ? reference.slice(reference.indexOf("#") + 1) : null;
      const bundle = fragment ? decodeEvidenceBundle(data) : null;
      const record = fragment ? bundle.records[fragment] : data;
      if (!record) throw new Error(`Missing evidence record ${reference}`);
      if (record.schemaVersion !== 1 || record.featureId !== entry.featureId || record.revision !== entry.revision) {
        throw new Error(`Evidence record ${reference} does not apply to ${entry.featureId} revision ${entry.revision}`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(record.recordedAt ?? "") || !Array.isArray(record.checks) || record.checks.length === 0) {
        throw new Error(`Evidence record ${reference} lacks a date or typed verification checks`);
      }
      for (const sourceCheck of record.checks) {
        const check = {...sourceCheck, fixture:sourceCheck.fixture ?? bundle?.shared?.fixture};
        if (!evidenceKinds.has(check.kind)
          || !isNonEmptyString(check.command)
          || (check.kind !== "M" && check.exitCode !== 0)
          || (check.kind === "M" && (check.result !== "accepted" || !isNonEmptyString(check.reviewer)))
          || !check.fixture || !isNonEmptyString(check.fixture.path)
          || (check.fixture.sha256 !== undefined && !/^[a-f\d]{64}$/i.test(check.fixture.sha256))
          || !check.environment || typeof check.environment !== "object" || Array.isArray(check.environment) || !Object.keys(check.environment).length
          || (["B", "V"].includes(check.kind) && !check.environment.viewport)) {
          throw new Error(`Evidence record ${reference} has an incomplete or non-passing check for ${entry.featureId}`);
        }
        // A recorded digest identifies a historical run. It is not a lock on today's input.
        await ensureRepositoryFile(check.fixture.path, "fixture path", entry.featureId);
      }
    }
    for (const test of entry.tests) {
      const script = test.match(/^npm run ([^\s#]+)/)?.[1];
      if (script && !packageJson.scripts[script]) {
        throw new Error(`Passed item ${entry.featureId} refers to missing npm script ${script}`);
      }
    }
  }
}
if (fixture.contractVersion !== "poc-contract-v1") throw new Error("Unexpected PoC contract version");
if (fixture.document.documentId !== fixture.renderRequest.documentId) throw new Error("Render target mismatch");
if (fixture.renderRequest.purpose !== "preview") throw new Error("Unexpected sample render purpose");
const handlerBlock = rustHost.match(/tauri::generate_handler!\[([\s\S]*?)\]/)?.[1];
if (!handlerBlock) throw new Error("Tauri invoke handler list is missing");
const handlers = new Set(handlerBlock.split(",").map((name) => name.trim()).filter(Boolean)
  // generate_handler! 允许模块路径（app_update::app_update_state），IPC 命令名只用函数短名。
  .map((name) => name.split("::").pop()));
const generatedNames = new Set([...commandType.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]));
const generatedErrorCodes = new Set([...errorType.matchAll(/"([A-Z][A-Z_]*)"/g)].map((match) => match[1]));
const capabilityNames = new Set(capability.permissions
  .filter((permission) => permission.startsWith("allow-"))
  .map((permission) => permission.slice("allow-".length).replaceAll("-", "_")));
const sameSet = (left, right) => left.size === right.size && [...left].every((value) => right.has(value));
if (!sameSet(handlers, generatedNames)) throw new Error("Rust handler list and generated IPC command names differ");
if (!sameSet(handlers, capabilityNames)) throw new Error("Rust handler list and main-window capabilities differ");
if (capability.windows.length !== 1 || capability.windows[0] !== "main") {
  throw new Error("Business IPC capability must remain restricted to the main window");
}
const uiErrorCodes = new Set([
  "VALIDATION", "CONFLICT", "NOT_FOUND", "PERMISSION", "STORAGE_FULL",
  "STORAGE_CORRUPT", "UNSUPPORTED_SCHEMA", "RESOURCE_LIMIT", "CANCELLED",
  "ENGINE_FAILURE", "MIGRATION_PARTIAL", "PROVIDER_FAILURE", "IPC_FAILURE",
]);
if (!sameSet(generatedErrorCodes, uiErrorCodes)) throw new Error("Rust-generated AppError codes and UI runtime validation differ");
process.stdout.write(`${mandatoryIds.size} mandatory acceptance IDs and ${ids.size - mandatoryIds.size} supplemental IDs, poc-contract-v1, and ${handlers.size} Rust/UI/window IPC names verified; no feature status was promoted.\n`);
