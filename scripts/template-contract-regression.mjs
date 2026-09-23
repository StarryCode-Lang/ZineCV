import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

const output = await mkdtemp(join(tmpdir(), "resume-template-contract-"));
const checks = [];

try {
  await build({
    logLevel: "silent",
    build: {
      outDir: output,
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        preserveEntrySignatures: "strict",
        input: {
          "template-model": resolve("src/domain/template-model.ts"),
          registry: resolve("src/templates/registry.ts"),
        },
        output: { entryFileNames: "[name].mjs" },
      },
    },
  });

  const model = await import(
    `${pathToFileURL(join(output, "template-model.mjs")).href}?${Date.now()}`
  );
  const registry = await import(
    `${pathToFileURL(join(output, "registry.mjs")).href}?${Date.now()}`
  );

  assert.deepEqual(model.normalizePresentation(undefined), {
    templateId: "legacy-v1",
    templateVersion: 1,
    densityPreset: "standard",
    overrides: {},
  });
  checks.push("legacy snapshots normalize in memory to legacy-v1@1");

  const unknown = model.resolvePresentation(
    {
      templateId: "future-template-v9",
      templateVersion: 9,
      densityPreset: "comfortable",
      overrides: { pageMargin: 28, bad: Number.NaN },
    },
    registry.templateVersions,
  );
  assert.equal(unknown.stored.templateId, "future-template-v9");
  assert.deepEqual(unknown.stored.overrides, { pageMargin: 28 });
  assert.equal(unknown.resolvedTemplateId, "legacy-v1");
  assert.equal(unknown.fallbackReason, "unknown-template");
  checks.push(
    "unknown template metadata is preserved while rendering falls back",
  );

  const unknownVersion = model.resolvePresentation(
    {
      templateId: "clear-single-v1",
      templateVersion: 7,
      densityPreset: "comfortable",
      overrides: {},
    },
    registry.templateVersions,
  );
  assert.equal(unknownVersion.stored.templateVersion, 7);
  assert.equal(unknownVersion.resolvedTemplateId, "legacy-v1");
  assert.equal(unknownVersion.fallbackReason, "unknown-version");
  checks.push(
    "unknown template versions do not silently claim visual recovery",
  );

  const templates = registry.listTemplates();
  assert.deepEqual(
    templates.map((template) => template.id),
    ["legacy-v1", "clear-single-v1", "compact-single-v1"],
  );
  assert.equal(new Set(templates.map((template) => template.id)).size, 3);
  templates.forEach((template) => {
    assert.ok(template.name);
    assert.ok(template.description);
    assert.ok(template.recommendedFor);
    assert.ok(template.version > 0);
    assert.ok(Number(template.defaults.fontSize) >= 10);
    assert.ok(Number(template.defaults.pageMargin) >= 20);
    assert.ok(template.allowedOverrides.includes("fontSize"));
    assert.ok(template.allowedOverrides.includes("pageMargin"));
  });
  checks.push("three templates expose complete unique registry metadata");

  assert.deepEqual(registry.templateRegistry["legacy-v1"].defaults, {
    font: "宋体",
    theme: "#000000",
    dateFormat: "2021年1月",
    titleFormat: "单行标题",
    separator: "使用分隔符号",
    textAlign: "两端对齐",
    fontSize: "13",
    headingFontSize: "13",
    lineHeight: "13",
    moduleSpacing: "0",
    paragraphSpacing: "0",
    listSpacing: "0",
    pageMargin: "30",
  });
  checks.push("legacy-v1 registry defaults match the current default layout");

  console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
} finally {
  const resolvedOutput = resolve(output);
  const resolvedTemp = resolve(tmpdir());
  const separator = process.platform === "win32" ? "\\" : "/";
  if (!resolvedOutput.startsWith(`${resolvedTemp}${separator}`))
    throw new Error(
      "Refusing to remove a test directory outside the OS temp root",
    );
  await rm(resolvedOutput, { recursive: true, force: true });
}
