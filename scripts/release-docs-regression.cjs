const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const checks = [];

function absolute(relativePath) {
  return path.join(root, relativePath);
}

function read(relativePath) {
  return fs.readFileSync(absolute(relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  checks.push(message);
}

function sha256(relativePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(absolute(relativePath)))
    .digest("hex");
}

const readme = read("README.md");
const inventory = read("docs/third-party-assets.md");
const maintenanceStatus = read("docs/maintenance-status.md");
const layoutPanel = read("src/components/toolbar/LayoutSettingsPanel.tsx");
const appHeader = read("src/components/layout/AppHeader.tsx");
const previewHeader = read("src/components/preview/PreviewHeader.tsx");
const previewSections = read("src/components/preview/PreviewSections.tsx");

assert(
  readme.includes("## 存储、导出与固定预览边界"),
  "README includes storage/export/fixed-preview boundary",
);
assert(
  readme.includes("html2canvas") &&
    readme.includes("jsPDF") &&
    readme.includes("210×297mm"),
  "README describes the image-based A4 PDF path",
);
assert(
  readme.includes("普通静态托管没有这个文件接口") &&
    readme.includes(".data/versions.json"),
  "README distinguishes browser cache from project version storage",
);
assert(
  readme.includes("预览正文外的键盘/悬停轮廓") &&
    readme.includes("Tab") &&
    readme.includes("Esc") &&
    readme.includes("不会越过相邻模块"),
  "README documents fixed-preview keyboard interaction",
);
assert(
  maintenanceStatus.includes("CURRENT_ENGINEERING_STATUS: PASS") &&
    maintenanceStatus.includes("图片、PDF 和 DOCX") &&
    maintenanceStatus.includes("顶部“格式”") &&
    maintenanceStatus.includes("PUBLISH_STATUS: LIMITED") &&
    maintenanceStatus.includes("npm run test:preview-interaction"),
  "maintenance status records current validation and publication boundary",
);
assert(
  !readme.includes("标题会按同一比例同步调整") &&
    layoutPanel.includes("调整正文基准字号；模块标题沿用现有样式"),
  "inaccurate proportional-title copy is removed and replaced",
);

for (const required of [
  "PUBLISH_STATUS: LIMITED",
  "UNKNOWN",
  "source-han-serif-cn-regular.otf",
  "source-han-serif-cn-heavy.ttf",
  "wondercv-iconfont.woff2",
  "WebsiteMark",
  "initial-resume.ts",
  ".data/versions.json",
  "项目源代码和项目文档按",
  "用户版本数据仍不进入 GitHub",
]) {
  assert(inventory.includes(required), `asset inventory records ${required}`);
}

for (const requiredPath of [
  "LICENSE",
  "NOTICE.md",
  ".github/CONTRIBUTING.md",
  ".github/CODE_OF_CONDUCT.md",
  ".github/SECURITY.md",
  "docs/CHANGELOG.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "docs/architecture.md",
  "docs/architecture.archify.json",
  "docs/design/motion-audit/README.md",
]) {
  assert(
    fs.existsSync(absolute(requiredPath)),
    `open-source project file exists: ${requiredPath}`,
  );
}

for (const obsoletePath of [
  "docs/motion-migration.md",
  "docs/next-major-version-plan.md",
  "docs/asset-sources-and-release-readiness-2026-09-13.md",
]) {
  assert(
    !fs.existsSync(absolute(obsoletePath)),
    `obsolete stage document removed: ${obsoletePath}`,
  );
}

assert(
  read(".gitignore").includes("docs/architecture.html") &&
    read(".github/workflows/code-intelligence-refresh.yml").includes(
      "code-intelligence-${{ github.sha }}",
    ),
  "generated Archify HTML is ignored locally and delivered by CI",
);

assert(
  appHeader.includes('className="brand-mark"') &&
    appHeader.includes('className="brand-product">Resume DIY'),
  "Resume DIY brand remains in the application shell",
);
assert(
  previewHeader.includes("import { WebsiteMark }") &&
    previewSections.includes('className="iconfont'),
  "shared WebsiteMark and preview iconfont remain wired",
);

const approvedUserRequestedExceptions = new Set([
  "src/components/preview/ResumePreviewPane.tsx",
  "src/app/useResumePagination.ts",
  "src/domain/initial-resume.ts",
]);
const manifestPath =
  ".audit/preview-baseline/20260912-b00-214640/manifest.json";
if (fs.existsSync(absolute(manifestPath))) {
  const manifest = JSON.parse(read(manifestPath));
  for (const protectedFile of manifest.protectedFiles) {
    if (protectedFile.path.startsWith(".data/")) {
      assert(
        fs.existsSync(absolute(protectedFile.path)),
        `protected user data exists: ${protectedFile.path}`,
      );
      continue;
    }
    if (approvedUserRequestedExceptions.has(protectedFile.path)) {
      checks.push(
        `protected explicit user-requested exception retained: ${protectedFile.path}`,
      );
      continue;
    }
    assert(
      fs.existsSync(absolute(protectedFile.path)),
      `protected file exists: ${protectedFile.path}`,
    );
    assert(
      sha256(protectedFile.path) === protectedFile.sha256,
      `protected file unchanged: ${protectedFile.path}`,
    );
  }
} else {
  checks.push(
    "local preview baseline absent in a clean public clone; protected-file hash check deferred to the maintainer workspace",
  );
}

const result = {
  status: "PASS",
  checks,
  protectedFilesChecked: fs.existsSync(absolute(manifestPath))
    ? JSON.parse(read(manifestPath)).protectedFiles.length
    : 0,
  publishStatus: "LIMITED",
};
console.log(JSON.stringify(result, null, 2));
