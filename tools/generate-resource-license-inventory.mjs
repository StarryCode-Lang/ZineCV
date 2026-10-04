import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "docs", "resource-license-inventory-20260930.json");
const mode = process.argv[2] ?? "--check";
if (!new Set(["--write", "--check"]).has(mode)) {
  throw new Error("Usage: node tools/generate-resource-license-inventory.mjs [--write|--check]");
}

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalize = (value) => value.split(sep).join("/");
const fileEvidence = async (relativePath) => {
  const bytes = await readFile(join(root, relativePath));
  return { path: normalize(relativePath), bytes: bytes.length, sha256: hash(bytes) };
};

async function scanDirectory(relativePath, licenseForFile = () => undefined) {
  const absolutePath = join(root, relativePath);
  try {
    await stat(absolutePath);
  } catch {
    return { path: normalize(relativePath), present: false, files: [] };
  }
  const files = [];
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const itemPath = join(directory, item.name);
      if (item.isDirectory()) await walk(itemPath);
      else if (item.isFile()) {
        const relativeFile = normalize(relative(root, itemPath));
        const evidence = await fileEvidence(relativeFile);
        const licenseRef = licenseForFile(relativeFile);
        files.push(licenseRef ? { ...evidence, licenseRef } : evidence);
      }
    }
  }
  await walk(absolutePath);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { path: normalize(relativePath), present: true, fileCount: files.length, files };
}

const packageLock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const packageNames = [
  "@tauri-apps/api", "@tiptap/extension-list", "@tiptap/pm", "@tiptap/react", "@tiptap/starter-kit",
  "docx-preview", "html2canvas", "lucide-react", "mammoth", "motion",
  "pdfjs-dist", "react", "react-dom", "tesseract.js", "tesseract.js-core",
];
const npmPackages = packageNames.map((name) => {
  const lockEntry = packageLock.packages[`node_modules/${name}`];
  if (!lockEntry) throw new Error(`missing locked production package: ${name}`);
  return {
    name,
    version: lockEntry.version,
    license: lockEntry.license ?? null,
    resolved: lockEntry.resolved,
    integrity: lockEntry.integrity,
  };
});

const licenseMappings = [
  ["docs/licenses/source-han-serif-OFL-1.1.txt", "https://github.com/adobe-fonts/source-han-serif/blob/master/LICENSE.txt"],
  ["docs/licenses/tauri-api-apache-2.0.txt", "node_modules/@tauri-apps/api/LICENSE_APACHE-2.0"],
  ["docs/licenses/tauri-api-mit.txt", "node_modules/@tauri-apps/api/LICENSE_MIT"],
  // The four @tiptap production packages declare MIT with identical text
  // ("Copyright (c) 2025, Tiptap GmbH"); their evidence path is each locked
  // package's own LICENSE file in node_modules because no docs/licenses copy exists yet.
  ["node_modules/@tiptap/extension-list/LICENSE.md", "node_modules/@tiptap/extension-list/LICENSE.md"],
  ["node_modules/@tiptap/pm/LICENSE", "node_modules/@tiptap/pm/LICENSE"],
  ["node_modules/@tiptap/react/LICENSE.md", "node_modules/@tiptap/react/LICENSE.md"],
  ["node_modules/@tiptap/starter-kit/LICENSE.md", "node_modules/@tiptap/starter-kit/LICENSE.md"],
  ["docs/licenses/docx-preview-apache.txt", "node_modules/docx-preview/LICENSE"],
  ["docs/licenses/html2canvas-mit.txt", "node_modules/html2canvas/LICENSE"],
  ["docs/licenses/lucide-react-isc-and-feather-mit.txt", "node_modules/lucide-react/LICENSE"],
  ["docs/licenses/mammoth-bsd-2-clause.txt", "node_modules/mammoth/LICENSE"],
  ["docs/licenses/motion-mit.md", "node_modules/motion/LICENSE.md"],
  ["docs/licenses/pdfjs-dist-apache-2.0.txt", "node_modules/pdfjs-dist/LICENSE"],
  ["docs/licenses/pdfjs-cmaps-bsd.txt", "node_modules/pdfjs-dist/cmaps/LICENSE"],
  ["docs/licenses/pdfjs-iccs-license.txt", "node_modules/pdfjs-dist/iccs/LICENSE"],
  ["docs/licenses/pdfjs-standard-fonts-foxit.txt", "node_modules/pdfjs-dist/standard_fonts/LICENSE_FOXIT"],
  ["docs/licenses/pdfjs-standard-fonts-liberation.txt", "node_modules/pdfjs-dist/standard_fonts/LICENSE_LIBERATION"],
  ["docs/licenses/pdfjs-wasm-jbig2.txt", "node_modules/pdfjs-dist/wasm/LICENSE_JBIG2"],
  ["docs/licenses/pdfjs-wasm-openjpeg.txt", "node_modules/pdfjs-dist/wasm/LICENSE_OPENJPEG"],
  ["docs/licenses/pdfjs-wasm-jbig2-modifications.txt", "node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_JBIG2"],
  ["docs/licenses/pdfjs-wasm-openjpeg-modifications.txt", "node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_OPENJPEG"],
  ["docs/licenses/pdfjs-wasm-qcms-modifications.txt", "node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_QCMS"],
  ["docs/licenses/pdfjs-wasm-qcms.txt", "node_modules/pdfjs-dist/wasm/LICENSE_QCMS"],
  ["docs/licenses/react-mit.txt", "node_modules/react/LICENSE"],
  ["docs/licenses/react-dom-mit.txt", "node_modules/react-dom/LICENSE"],
  ["docs/licenses/tesseract-js-apache-2.0.md", "node_modules/tesseract.js/LICENSE.md"],
  ["docs/licenses/tesseract-js-core-apache-2.0.txt", "node_modules/tesseract.js-core/LICENSE"],
  ["docs/licenses/tessdata-fast-apache-2.0.txt", "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/LICENSE", "CFC7749B96F63BD31C3C42B5C471BF756814053E847C10F3EB003417BC523D30"],
];
const licenseTexts = await Promise.all(licenseMappings.map(async ([path, source, pinnedHash]) => {
  const evidence = await fileEvidence(path);
  if (source.startsWith("node_modules/")) {
    const sourceHash = hash(await readFile(join(root, source)));
    if (sourceHash !== evidence.sha256) throw new Error(`license copy differs from locked package: ${path}`);
    return { ...evidence, copiedFrom: source, sourceSha256: sourceHash, copyMatchesSource: true };
  }
  if (pinnedHash && pinnedHash.toLowerCase() !== evidence.sha256)
    throw new Error(`license copy differs from pinned upstream bytes: ${path}`);
  return {
    ...evidence,
    copiedFrom: source,
    sourceSha256: pinnedHash?.toLowerCase() ?? null,
    copyMatchesSource: pinnedHash ? true : null,
  };
}));

const publicFontFiles = await scanDirectory("public/fonts");
const cmaps = await scanDirectory("node_modules/pdfjs-dist/cmaps", () => "docs/licenses/pdfjs-cmaps-bsd.txt");
const iccs = await scanDirectory("node_modules/pdfjs-dist/iccs", () => "docs/licenses/pdfjs-iccs-license.txt");
const standardFonts = await scanDirectory("node_modules/pdfjs-dist/standard_fonts", (path) =>
  path.includes("Foxit") || path.endsWith("LICENSE_FOXIT")
    ? "docs/licenses/pdfjs-standard-fonts-foxit.txt"
    : "docs/licenses/pdfjs-standard-fonts-liberation.txt");
const pdfWasm = await scanDirectory("node_modules/pdfjs-dist/wasm", (path) => {
  if (/jbig2/i.test(path)) return "docs/licenses/pdfjs-wasm-jbig2.txt; docs/licenses/pdfjs-wasm-jbig2-modifications.txt";
  if (/openjpeg/i.test(path)) return "docs/licenses/pdfjs-wasm-openjpeg.txt; docs/licenses/pdfjs-wasm-openjpeg-modifications.txt";
  return "docs/licenses/pdfjs-wasm-qcms.txt; docs/licenses/pdfjs-wasm-qcms-modifications.txt";
});
const tesseractCore = await scanDirectory("node_modules/tesseract.js-core");
const tesseractRuntimeAssets = await scanDirectory("public/ocr", (path) => {
  if (path.includes("/lang/") && path.endsWith(".traineddata")) return "docs/licenses/tessdata-fast-apache-2.0.txt";
  if (path.endsWith("worker.min.js")) return "docs/licenses/tesseract-js-apache-2.0.md";
  if (path.includes("tesseract-core")) return "docs/licenses/tesseract-js-core-apache-2.0.txt";
  return undefined;
});

const projectFiles = await Promise.all([
  "package.json", "package-lock.json", "src-tauri/Cargo.lock", "vite.config.ts", "src-tauri/tauri.conf.json",
  "src/ui/services/template-import.ts", "src/ui/services/template-file-parser.worker.ts",
  "src/ui/services/import-preview-sandbox.ts", "src/ui/services/pdfjs-resources.ts",
  "src/ui/styles/preview.css",
  "src/ui/styles/template-clear-single.css", "src/ui/styles/template-compact-single.css",
  "src-tauri/src/engine.rs", "src-tauri/src/engine/templates.typ",
  "node_modules/tesseract.js/src/worker/browser/defaultOptions.js",
  "node_modules/tesseract.js/src/worker-script/index.js",
  "node_modules/tesseract.js/src/worker-script/browser/getCore.js",
].map(fileEvidence));

const windowsFontsDirectory = join(process.env.WINDIR ?? "C:/Windows", "Fonts");
const georgiaFiles = [];
for (const fileName of ["georgia.ttf", "georgiab.ttf", "georgiai.ttf", "georgiaz.ttf"]) {
  try {
    const fullPath = join(windowsFontsDirectory, fileName);
    const bytes = await readFile(fullPath);
    georgiaFiles.push({ path: fullPath, bytes: bytes.length, sha256: hash(bytes), versionObserved: "5.59" });
  } catch {
    georgiaFiles.push({ path: join(windowsFontsDirectory, fileName), present: false });
  }
}

const manifest = {
  schemaVersion: 1,
  package: "R02",
  capturedAt: "2026-10-01",
  sourceRevision: "07a874b994aa57287e373c95ede5a691818df7c4 plus protected pre-existing worktree and R16 changes",
  dataClassification: "resource and license metadata only; no user resume, credentials, or .data read",
  sourceLocks: {
    packageLock: await fileEvidence("package-lock.json"),
    cargoLock: await fileEvidence("src-tauri/Cargo.lock"),
    packages: npmPackages,
    rootProjectLicense: {
      packageJsonDeclaration: JSON.parse(await readFile(join(root, "package.json"), "utf8")).license ?? null,
      evidence: "No root LICENSE/LICENCE/COPYING/NOTICE file was present at inventory time; first-party release terms remain to be set by the owner.",
    },
  },
  resources: {
    sourceHanSerif: {
      source: "Adobe Source Han Serif; font metadata version 1.000, copyright 2017 Adobe Systems Incorporated",
      sourceUrl: "https://github.com/adobe-fonts/source-han-serif",
      license: "SIL Open Font License 1.1; binary metadata declares Reserved Font Name 'Source'",
      licenseCopy: "docs/licenses/source-han-serif-OFL-1.1.txt",
      licenseStatus: "identified; full upstream license text copied; must be shipped with any font redistribution",
      files: publicFontFiles.files.filter((file) => /source-han-serif-cn-(regular\.otf|heavy\.ttf)$/i.test(file.path)),
      observations: [
        "The TTF named 'heavy' reports family Source Han Serif CN, style Bold.",
        "No font bytes were changed in R02.",
      ],
    },
    wondercvIconfont: {
      source: "Font metadata says 'Created by iconfont', version 1.0, generated by svg2ttf from a Fontello project; upstream author/source project not identified in this checkout.",
      files: publicFontFiles.files.filter((file) => /wondercv-iconfont\.(css|woff2|ttf)$/i.test(file.path)),
      licenseStatus: "unknown; no license text, copyright owner, original glyph source, or redistribution grant found; release blocker",
      conversionNote: "The WOFF2-to-TTF conversion does not establish permission for either font file.",
    },
    georgia: {
      role: "The clear template CSS names Georgia for title roles; current Typst engine does not bundle Georgia and falls back to Source Han Serif.",
      source: "This machine's Windows Fonts directory only; not a project asset.",
      observedStyles: georgiaFiles,
      embeddedMetadata: "Microsoft Corporation copyright 2016; Georgia trademark; Windows font embedding notice limits use to terms of the supplied Microsoft product/service/content.",
      licenseSource: "https://learn.microsoft.com/en-us/typography/fonts/font-faq",
      licenseStatus: "not bundled by ZineCV; do not copy to an app package without separate application redistribution rights",
    },
    lucide: {
      package: "lucide-react",
      lockedVersion: npmPackages.find((item) => item.name === "lucide-react").version,
      license: "ISC; the copied package license also contains the Feather-derived icon MIT notice",
      licenseCopy: "docs/licenses/lucide-react-isc-and-feather-mit.txt",
      usedGeometry: ["Award", "FileText"],
      implementation: "Path data is embedded and recolored by src-tauri/src/engine.rs; npm package remains a direct UI dependency.",
      licenseStatus: "license identified and notice copied; include notice in runtime distribution if these assets remain shipped",
    },
    projectTemplates: {
      files: projectFiles.filter((file) => /src\/ui\/styles\/(preview|template-clear-single|template-compact-single)\.css|src-tauri\/src\/engine\/templates\.typ/.test(file.path)),
      classification: "project-maintained template sources; no third-party license found in the inspected files",
      projectLicenseStatus: "repository root has no declared license or notice; owner must set release terms",
    },
    pdfJs: {
      package: "pdfjs-dist",
      lockedVersion: npmPackages.find((item) => item.name === "pdfjs-dist").version,
      packageLicense: "Apache-2.0",
      packageLicenseCopy: "docs/licenses/pdfjs-dist-apache-2.0.txt",
      usageEvidence: projectFiles.find((file) => file.path === "src/ui/services/template-import.ts"),
      runtimeConfig: "PDF.js worker URL is bundled; cMapUrl and standardFontDataUrl resolve under the app-local /pdfjs/ path, and both directories plus their source license files are copied into dist.",
      assets: {
        cmaps,
        iccs,
        standardFonts,
        wasm: pdfWasm,
      },
      distributionEvidence: ".artifacts/remaining/R30/session4/p14-evidence.json (see the current slice for installer scope and limits)",
      licenseStatus: "package and resource license texts copied; per-file package hashes recorded; CMap and standard-font resolution is wired to dist; installed-package resolution remains unverified",
    },
    tesseractOcr: {
      packages: npmPackages.filter((item) => ["tesseract.js", "tesseract.js-core"].includes(item.name)),
      runtimeCode: projectFiles.filter((file) => file.path.includes("node_modules/tesseract.js/src/worker")),
      requestedLanguages: ["chi_sim", "eng"],
      languageDataPackage: "tesseract-ocr/tessdata_fast at immutable commit 87416418657359cb625c412a48b6e1d6d41c29bd",
      languageDataSources: [
        "https://github.com/tesseract-ocr/tessdata_fast/blob/87416418657359cb625c412a48b6e1d6d41c29bd/chi_sim.traineddata",
        "https://github.com/tesseract-ocr/tessdata_fast/blob/87416418657359cb625c412a48b6e1d6d41c29bd/eng.traineddata",
        "https://github.com/tesseract-ocr/tessdata_fast/blob/87416418657359cb625c412a48b6e1d6d41c29bd/LICENSE",
      ],
      languageDataLicense: "Apache-2.0 per the pinned repository README and LICENSE; notice copied into docs/licenses and public/ocr",
      languageDataLicenseStatus: "identified and copied; model commit and per-file SHA-256 recorded",
      languageDataPresentLocally: tesseractRuntimeAssets.files.some((file) => file.path.endsWith("chi_sim.traineddata")) && tesseractRuntimeAssets.files.some((file) => file.path.endsWith("eng.traineddata")),
      languageDataSha256: tesseractRuntimeAssets.files.filter((file) => file.path.endsWith(".traineddata")),
      defaultBehavior: "workerPath, corePath, and langPath resolve only to app-local /ocr/ assets; workerBlobURL is disabled and gzip is disabled for the pinned raw traineddata files.",
      coreWasmAssets: tesseractCore,
      runtimeAssets: tesseractRuntimeAssets,
      licenseStatus: "engine and language-data Apache-2.0 notices are copied; worker, non-SIMD LSTM WASM, and chi_sim/eng models are in public/ocr; installed-package OCR still needs R30 verification",
    },
  },
  thirdPartyLicenseTexts: licenseTexts,
  externalRequirements: [
    { item: "WonderCV iconfont source and redistribution grant", affected: ["R02", "R30", "R32", "F44", "D03"], status: "missing" },
    { item: "Georgia app redistribution rights or approved equivalent with visual review", affected: ["R02", "R10", "R30", "F44", "D03"], status: "missing" },
    { item: "Offline PDF CMap/standard-font/worker and OCR resource verification in an installed package", affected: ["R16", "R30", "D02", "D03"], status: "app-dist integration implemented; installed-package verification pending" },
    { item: "First-party project release license/notice", affected: ["R02", "R28", "R30", "R32"], status: "root declaration absent" },
  ],
};

const output = `${JSON.stringify(manifest, null, 2)}\n`;
if (mode === "--write") {
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, output);
  console.log(`R02_LICENSE_INVENTORY mode=${mode} packages=${npmPackages.length} licenseTexts=${licenseTexts.length} cmaps=${cmaps.fileCount} standardFonts=${standardFonts.fileCount} tesseractFiles=${tesseractCore.fileCount}`);
} else {
  try {
    const existing = await readFile(destination, "utf8");
    if (existing !== output) {
      console.error("R02 resource/license inventory differs; regenerate only after reviewing the source and license status changes.");
      process.exitCode = 1;
    } else {
      console.log(`R02_LICENSE_INVENTORY mode=${mode} packages=${npmPackages.length} licenseTexts=${licenseTexts.length} cmaps=${cmaps.fileCount} standardFonts=${standardFonts.fileCount} tesseractFiles=${tesseractCore.fileCount} mismatches=0`);
    }
  } catch {
    console.error("R02 resource/license inventory is missing; run with --write after reviewing the source and license status.");
    process.exitCode = 1;
  }
}
