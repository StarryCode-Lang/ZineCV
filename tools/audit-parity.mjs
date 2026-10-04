// P17 只读核对：逐行检查 docs/feature-parity.json 的实现路径、测试命令与证据文件是否存在。
// 只报告，不修改状态；状态升级由人工依据本报告执行。
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const rows = JSON.parse(readFileSync(join(root, "docs/feature-parity.json"), "utf8"));
const scriptRe = (() => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return new Set(Object.keys(pkg.scripts ?? {}));
})();

const report = { generatedAt: new Date().toISOString(), rows: [], summary: {} };
let missingPaths = 0, missingScripts = 0, missingEvidence = 0;

for (const row of rows) {
  const entry = { featureId: row.featureId, title: row.title, status: row.status, problems: [] };
  for (const path of row.implementationPaths ?? []) {
    const clean = path.replace(/`/g, "").split("→")[0].trim().split(" ")[0];
    if (!clean || clean.startsWith("http") || !/\.(rs|ts|tsx|typ|sql|css|mjs|json)$|^[a-z]+\/$/.test(clean)) continue;
    if (!existsSync(join(root, clean))) {
      entry.problems.push(`missing path: ${clean}`);
      missingPaths += 1;
    }
  }
  for (const test of row.tests ?? []) {
    const script = test.startsWith("npm run ") ? test.slice(8).trim() : null;
    if (script && !scriptRe.has(script)) {
      entry.problems.push(`missing npm script: ${script}`);
      missingScripts += 1;
    }
  }
  for (const evidence of row.evidence ?? []) {
    const file = evidence.split("—")[0].split("；")[0].trim();
    if (!file || file.includes("（") || !/\.(json|log|md)$/.test(file)) continue;
    if (file.includes("*")) {
      // 通配符：至少展开出一个真实文件即可
      const base = file.replace(/\*[^/]*$/, "");
      const dir = join(root, base);
      if (!existsSync(dir)) {
        entry.problems.push(`glob matched nothing: ${file}`);
        missingEvidence += 1;
      }
      continue;
    }
    const target = file.startsWith("docs/") || file.startsWith("tools/")
      ? join(root, file)
      : file.startsWith(".artifacts/")
        ? join(root, file)
        : join(root, ".artifacts/remaining", file);
    if (!existsSync(target)) {
      entry.problems.push(`missing evidence: ${file}`);
      missingEvidence += 1;
    }
  }
  report.rows.push(entry);
}

report.summary = {
  totalRows: rows.length,
  rowsWithProblems: report.rows.filter((row) => row.problems.length).length,
  missingPaths,
  missingScripts,
  missingEvidence,
};
mkdirSync(join(root, ".artifacts/remaining/R28"), { recursive: true });
writeFileSync(
  join(root, ".artifacts/remaining/R28/session4-parity-audit.json"),
  JSON.stringify(report, null, 1) + "\n",
  "utf8",
);
console.log(JSON.stringify(report.summary));
for (const row of report.rows.filter((row) => row.problems.length)) {
  console.log(`${row.featureId}: ${row.problems.join(" | ")}`);
}
