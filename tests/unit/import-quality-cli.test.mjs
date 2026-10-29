import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");

function cli(args, options = {}) {
  return spawnSync(process.execPath, [...(options.preload ? ["--import", options.preload] : []), "tools/import-quality-baseline.mjs", ...args], {
    cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true,
    env: { ...process.env, ...(options.env ?? {}) },
  });
}

test("import quality CLI rejects unknown, empty, wrong-split and excluded selections before browser startup", () => {
  for (const args of [
    ["--gate", "--id", "UNKNOWN"],
    ["--gate", "--id", ""],
    ["--gate", "--id"],
    ["--gate", "--id", "IQ-01,"],
    ["--gate", "--id", "IQ-11"],
    ["--no-boundaries", "--gate", "--id", "IQ-B01"],
    ["--gate", "--check"],
    ["--holdout", "--check"],
  ]) {
    const result = cli(args);
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, /Unknown, empty, excluded or wrong-split sample ID|--check does not run a holdout|--gate and --check are mutually exclusive/);
  }
  const valid = cli(["--check", "--id", "IQ-01"]);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).inventory.valid, 48);
});

// Exercise the real CLI state machine in a child process, replacing only its
// expensive browser/materialization/scoring boundaries. No product files are
// changed, and these controls do not claim recognition or browser qualification.
function installControls(registerHooks, fsPromises) {
globalThis.__iqCliFs = fsPromises;
globalThis.__iqCliReads = new Map();
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "node:fs/promises") return {url: "iq-cli:fs", shortCircuit: true};
    return next(specifier, context);
  },
  load(url, context, next) {
    let source;
    if (url === "iq-cli:fs") source = `
      export const mkdir = globalThis.__iqCliFs.mkdir;
      export const writeFile = globalThis.__iqCliFs.writeFile;
      export const rm = globalThis.__iqCliFs.rm;
      export const stat = globalThis.__iqCliFs.stat;
      export async function readFile(path, ...args) {
        const value = await globalThis.__iqCliFs.readFile(path, ...args);
        const key = String(path);
        const count = (globalThis.__iqCliReads.get(key) ?? 0) + 1;
        globalThis.__iqCliReads.set(key, count);
        if (process.env.IQ_CLI_TEST_INPUT_CHANGE === "1" && key.replaceAll(String.fromCharCode(92), "/").endsWith("/template-import.ts") && count > 1) {
          return Buffer.isBuffer(value) ? Buffer.concat([value, Buffer.from("\\nchanged input")]) : value + "\\nchanged input";
        }
        return value;
      }
    `;
    else if (url.endsWith("/tests/browser/fixtures/browser-test-server.mjs")) source = `
      export async function createBrowserTestServer() { return { httpServer: { address: () => ({port: 1}) }, close: async () => {} }; }
      export async function listenForBrowserTestServer() {}
      export async function launchBrowserTestChromium() {
        return { close: async () => {}, newContext: async () => ({
          route: async () => {},
          newPage: async () => ({ goto: async () => {}, evaluate: async () => ({ extractedText: "owned", resume: {}, moduleOrder: [] }) }),
          newCDPSession: async () => ({ send: async () => ({usedSize: 0}) }),
        }) };
      }
    `;
    else if (url.endsWith("/fixtures/import-quality/materialize.mjs")) source = `
      export async function materializeSample() { return { bytes: Buffer.from("owned bytes"), type: "application/pdf" }; }
      export async function materializeBoundary() { return {pending: "Operation not exercised by CLI unit test"}; }
    `;
    else if (url.endsWith("/fixtures/import-quality/score.mjs")) source = `
      export function scoreSample() { return {passed: true, outcome: "CLI control fixture only"}; }
    `;
    return source === undefined ? next(url, context) : {format: "module", source, shortCircuit: true};
  },
});
}
const preload = 'import { registerHooks } from "node:module"; import * as fsPromises from "node:fs/promises"; (' + installControls.toString() + ')(registerHooks, fsPromises);';

test("import quality CLI marks selected gates as partial and rejects changed source inputs", () => {
  const parent = resolve(tmpdir());
  const directory = mkdtempSync(resolve(parent, "zinecv-import-quality-cli-"));
  try {
    const preloadPath = resolve(directory, "controls.mjs");
    writeFileSync(preloadPath, preload);
    const options = { preload: pathToFileURL(preloadPath).href };
    const stableOutput = resolve(directory, "stable");
    const stable = cli(["--gate", "--id", "IQ-01", "--no-boundaries", "--output", stableOutput], options);
    assert.equal(stable.error, undefined, stable.error?.message);
    assert.equal(stable.status, 0, stable.stderr);
    const stableReport = JSON.parse(readFileSync(resolve(stableOutput, "report.json"), "utf8"));
    assert.equal(stableReport.inputsStable, true);
    assert.equal(stableReport.phaseAcceptance, false);
    assert.equal(stableReport.scope, "selected-cases-only");
    assert.equal(stableReport.expectedValidSamples, 36);
    assert.equal(stableReport.summary.attempted, 1);

    const changedOutput = resolve(directory, "changed");
    const changed = cli(["--gate", "--id", "IQ-01", "--no-boundaries", "--output", changedOutput], {
      ...options, env: { IQ_CLI_TEST_INPUT_CHANGE: "1" },
    });
    assert.equal(changed.error, undefined, changed.error?.message);
    assert.notEqual(changed.status, 0, changed.stderr);
    assert.match(changed.stderr, /Inputs changed during run/);
    const changedReport = JSON.parse(readFileSync(resolve(changedOutput, "report.json"), "utf8"));
    assert.equal(changedReport.inputsStable, false);
    assert.equal(changedReport.phaseAcceptance, false);
  } finally {
    // Only the fresh, explicitly owned test directory can be removed.
    assert.equal(dirname(directory), parent);
    assert.ok(directory.startsWith(resolve(parent, "zinecv-import-quality-cli-")));
    rmSync(directory, { recursive: true, force: true });
  }
});
