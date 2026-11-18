import { Worker } from "node:worker_threads";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

// Unit test runner: identical test files, assertions and per-file serial
// execution to `node --test`, but shards stay resident in worker threads so
// the TypeScript loader, compile cache and shared modules load once per worker
// instead of once per test file. Shards are balanced with per-file timings
// measured by earlier runs, cached in the ignored .artifacts directory; the
// first run falls back to an even round-robin split.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const unitDirectory = join(root, "tests/unit");
const registerUrl = pathToFileURL(join(unitDirectory, "register-ts-resolve.mjs")).href;
const workerUrl = new URL("./unit-runner-worker.mjs", import.meta.url);
const timingCache = join(root, ".artifacts", "unit-timings.json");

const names = (await readdir(unitDirectory)).filter((name) => name.endsWith(".test.mjs")).sort();
if (!names.length) throw new Error(`No unit test files found in ${unitDirectory}`);

const requested = Number(process.env.ZINECV_UNIT_WORKERS ?? 8);
const workerCount = Math.max(1, Math.min(Number.isFinite(requested) ? Math.trunc(requested) : 8, names.length));

const previous = await readFile(timingCache, "utf8").then((text) => JSON.parse(text)).catch(() => ({}));
const files = names.map((name) => ({ name, url: pathToFileURL(join(unitDirectory, name)).href, seconds: Number(previous[name]) || 1 }));
const shards = Array.from({ length: workerCount }, () => ({ seconds: 0, files: [] }));
for (const file of [...files].sort((a, b) => b.seconds - a.seconds)) {
  shards.sort((a, b) => a.seconds - b.seconds);
  shards[0].files.push(file);
  shards[0].seconds += file.seconds;
}

const started = Date.now();
const results = await Promise.all(shards.filter((shard) => shard.files.length).map((shard) => new Promise((done) => {
  const worker = new Worker(workerUrl, { workerData: { registerUrl, files: shard.files }, stdout: true, stderr: true });
  let output = "";
  worker.stdout.on("data", (chunk) => { output += chunk; });
  worker.stderr.on("data", (chunk) => { output += chunk; });
  worker.on("error", (error) => done({ code: 2, output: `${output}\n[unit] worker crashed\n${error?.stack ?? error}` }));
  worker.on("exit", (code) => done({ code, output }));
})));
const seconds = ((Date.now() - started) / 1000).toFixed(2);

const combined = results.map((result) => result.output).join("");
const summary = (label) => {
  const matches = [...combined.matchAll(new RegExp(`\\u2139 ${label} (\\d+)`, "g"))];
  return matches.reduce((total, match) => total + Number(match[1]), 0);
};
const failed = summary("fail");
const crashed = results.filter((result) => result.code !== 0).length;

const measured = {};
for (const match of combined.matchAll(/[✔✖] file (\S+\.test\.mjs) \(([\d.]+)(ms|s)\)/g)) {
  measured[match[1]] = Number(match[2]) / (match[3] === "s" ? 1 : 1000);
}
if (Object.keys(measured).length === names.length) {
  await mkdir(dirname(timingCache), { recursive: true })
    .then(() => writeFile(`${timingCache}.tmp`, `${JSON.stringify(measured, null, 2)}\n`))
    .then(() => rename(`${timingCache}.tmp`, timingCache))
    .catch(() => {});
}

process.stdout.write(combined);
process.stdout.write(`\n[unit] ${names.length} files in ${workerCount} workers, ${seconds}s, ` +
  `${summary("pass")} passed, ${failed} failed${crashed ? `, ${crashed} worker(s) exited non-zero` : ""}\n`);

process.exitCode = crashed || failed ? 1 : 0;
