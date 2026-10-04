// P14 安装目录布局校验（针对 Tauri 2 NSIS 实际布局）：
// Tauri 2.11.5 的 NSIS 安装包把前端资源编译进主程序（tauri:// 内嵌资产），
// 安装目录只含主程序（zinecv-desktop.exe）与卸载器（uninstall.exe），没有 dist 散文件。
// 因此本脚本校验：
//   1) 主程序与卸载器存在；
//   2) 已安装主程序 SHA-256 == 构建产物 release exe 的 SHA-256（--expected-exe-sha256），
//      把「SBOM(dist) → 编译嵌入 exe → 打包 → 安装」的哈希链接起来；
//   3) 输出安装目录完整文件清单，供证据归档。
// 前端资源完整性由 tools/verify-installed-app.mjs 的运行时功能验证（.app-shell + 导出）兜底。
//
// 用法：node tools/verify-install-layout.mjs <安装目录> [--expected-exe-sha256 <sha>]
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, relative, sep } from "node:path";

const args = process.argv.slice(2);
const installDir = resolve(args[0] ?? "");
const shaIndex = args.indexOf("--expected-exe-sha256");
const expectedExeSha = shaIndex >= 0 ? String(args[shaIndex + 1]).toLowerCase() : null;
if (!existsSync(installDir)) {
  console.error(`install dir not found: ${installDir}`);
  process.exit(2);
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = join(dir, entry.name);
    return entry.isDirectory() ? walk(child) : [child];
  });

const files = walk(installDir).map((file) => {
  const rel = relative(installDir, file).split(sep).join("/");
  return { path: rel, bytes: statSync(file).size, sha256: sha256(file) };
});
const find = (name) => files.find((file) => file.path.toLowerCase() === name.toLowerCase());

const mainExe = find("zinecv-desktop.exe");
const uninstaller = find("uninstall.exe");
const report = {
  installDir,
  files,
  checks: {
    mainExePresent: Boolean(mainExe),
    uninstallerPresent: Boolean(uninstaller),
    installedExeSha256: mainExe?.sha256 ?? null,
    expectedExeSha256: expectedExeSha,
    exeShaMatchesBuild: Boolean(mainExe && expectedExeSha && mainExe.sha256 === expectedExeSha),
    looseDistResources: files.filter((file) => /\.(html|js|css|wasm|wasm\.js|png|woff2?|ttf|json)$/i.test(file.path) && !/^uninstall/i.test(file.path)).length,
  },
  problems: [],
};
if (!report.checks.mainExePresent) report.problems.push("missing: zinecv-desktop.exe");
if (!report.checks.uninstallerPresent) report.problems.push("missing: uninstall.exe");
if (expectedExeSha && !report.checks.exeShaMatchesBuild) report.problems.push("installed exe sha256 differs from build output");
const ok = report.problems.length === 0;
console.log(JSON.stringify({ ok, checks: report.checks, problems: report.problems, files }, null, 1));
process.exit(ok ? 0 : 1);
