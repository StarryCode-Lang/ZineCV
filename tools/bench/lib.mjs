// P13/R29 基准公共库：分位数、汇总、证据输出与参数解析。
// 设计要点：
// - percentile 必须先排序再取值（tools/bench-webview-sustain.mjs 历史上 max 曾因未排序而不可信，
//   本库以显式 sorted 数组为唯一实现，杜绝同类 bug）。
// - 证据统一写入 .artifacts/remaining/R29/，文件名前缀可指定。
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const root = resolve(import.meta.dirname, "../..");
export const evidenceRoot = join(root, ".artifacts", "remaining", "R29");
export const releaseExe = resolve(
  process.env.ZINECV_TEST_EXE ?? join(root, "src-tauri", "target", "release", "zinecv-desktop.exe"),
);

/** quantile 取值：先升序排序，再取 ceil(q*n)-1（n=1 时取唯一值）。 */
export function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
}

/** 常用汇总：count/p50/p95/max/maxIndex。全部基于排序后的数组。 */
export function summarize(values) {
  if (!values.length) return { count: 0, p50: null, p95: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
}

export function round3(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 1000) / 1000
    : value;
}

export function roundSummary(summary) {
  return Object.fromEntries(
    Object.entries(summary).map(([key, value]) => [key, round3(value)]),
  );
}

export async function writeEvidence(namePrefix, payload) {
  await mkdir(evidenceRoot, { recursive: true });
  const stamped = `${namePrefix}-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`;
  const outputPath = join(evidenceRoot, `${stamped}.json`);
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return outputPath;
}

export async function writeEvidenceExact(fileName, payload) {
  await mkdir(evidenceRoot, { recursive: true });
  const outputPath = join(evidenceRoot, fileName);
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return outputPath;
}

/** 解析 --samples N / --out path / --key value 形式的简单参数。 */
export function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else { args[key] = next; index += 1; }
    } else args._.push(token);
  }
  return args;
}

export function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** 断言 release 宿主存在，缺失时给出可执行的补救命令，不自动构建。 */
export async function assertHostExecutable() {
  const { stat } = await import("node:fs/promises");
  try {
    const info = await stat(releaseExe);
    if (!info.isFile()) throw new Error("not a file");
    return releaseExe;
  } catch {
    throw new Error(
      `未找到 release 宿主：${releaseExe}\n请先运行 npm run build:native（本脚本不自动构建）。`,
    );
  }
}
