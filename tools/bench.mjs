import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cpus, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";

const root = resolve(import.meta.dirname, "..");
const executable = join(root, "src-tauri", "target", "release", "examples", "typst_poc.exe");
const output = join(root, ".artifacts", "bench", "typst-poc.json");

function runOnce() {
  return new Promise((done, reject) => {
    const start = performance.now();
    const child = spawn(executable, [], { cwd: root, windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (exitCode) => {
      const elapsedMs = Math.round((performance.now() - start) * 100) / 100;
      done({ exitCode, elapsedMs, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

const runs = [];
for (let index = 0; index < 3; index += 1) {
  const result = await runOnce();
  runs.push(result);
  if (result.exitCode !== 0) throw new Error(`Typst PoC run ${index + 1} failed: ${result.stderr}`);
}
const report = {
  capturedAt: new Date().toISOString(),
  scope: "B02 release Typst PoC process wall time, including startup, font load, 1/2/5 page compile and export",
  environment: { platform: platform(), osRelease: release(), cpu: cpus()[0]?.model, totalMemoryBytes: totalmem(), node: process.version },
  executable,
  runs,
};
await mkdir(join(root, ".artifacts", "bench"), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${output}`);
console.log(`Wall times: ${runs.map((run) => `${run.elapsedMs} ms`).join(", ")}`);
