// Generate regression inputs with the actual published native engine. This is
// an input-generation receipt, never qualification of the current development
// executable, frontend, or Windows end-to-end product chain.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, realpath, lstat, rm, access } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { samples, policy, validateCorpus } from "../fixtures/import-quality/corpus.mjs";
import { startNativeHost, stopNativeHost } from "../tests/native/host-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const releaseDirectory = join(root, ".artifacts/releases/2.0.0-alpha.2");
const executable = join(releaseDirectory, "zinecv-desktop.exe");
const receiptPath = join(releaseDirectory, "build-native.json");
const output = join(root, ".artifacts/import-quality/builtin-alpha2");
const publishedSha256 = "58e62da1c85bd33bb364c5ff29bdc8d943c55d783243111b118b9f9062990d35";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const jsonHash = value => sha256(Buffer.from(JSON.stringify(value)));

function assertOwnedPath(parent, child) {
  const path = relative(parent, child);
  if (!path || isAbsolute(path) || path === ".." || path.startsWith("..\\") || path.startsWith("../")) {
    throw new Error(`Refusing an unowned output/profile path: ${child}`);
  }
}

async function verifyGenerator() {
  const [bytes, receiptBytes, checksumBytes] = await Promise.all([
    readFile(executable), readFile(receiptPath), readFile(join(releaseDirectory, "SHA256SUMS.txt")),
  ]);
  const receipt = JSON.parse(receiptBytes);
  const executableSha256 = sha256(bytes);
  assert.equal(executableSha256, publishedSha256, "Archived engine differs from published alpha.2 identity");
  assert.equal(receipt.outputs?.executable?.sha256, executableSha256, "Archived receipt does not match executable");
  assert.equal(receipt.stage, "build:native");
  assert.equal(receipt.provenance?.successfulBuild, true);
  assert.equal(receipt.provenance?.exitCode, 0);
  assert.match(checksumBytes.toString("utf8"), new RegExp(`${publishedSha256}\\s+zinecv-desktop\\.exe`));
  return { kind: "published-alpha.2-native-template-export", version: "2.0.0-alpha.2", executable,
    executableSha256, buildReceipt: receiptPath, buildReceiptSha256: sha256(receiptBytes),
    buildInputDigest: receipt.inputDigest, buildIdentityDigest: receipt.identityDigest,
    receiptRecordedAt: receipt.recordedAt, currentDevelopmentQualification: false };
}

async function loadPresentationRecipes() {
  // Reuse the repository's existing Node TS resolver; no handwritten duplicate
  // template defaults. These are authored presentation inputs to the archived
  // engine, and their current source hashes are recorded independently below.
  await import("../tests/unit/register-ts-resolve.mjs");
  const [{ templateRegistry }, { resolveDensitySpacing }] = await Promise.all([
    import("../src/ui/templates/registry.ts"), import("../src/ui/domain/template-model.ts"),
  ]);
  return { templateRegistry, resolveDensitySpacing };
}

function presentationFor(sample, recipes) {
  const template = recipes.templateRegistry[sample.family];
  assert.ok(template, `Unknown builtin template: ${sample.family}`);
  const density = sample.index % 2 === 0 ? "standard" : "compact";
  const defaults = { ...template.defaults, ...recipes.resolveDensitySpacing(sample.family, density) };
  const pt = key => Number(defaults[key]) * 0.75;
  return { templateId: template.id, templateRevision: String(template.version), density,
    fontSetId: `legacy-font:${defaults.font}`, fontSizePt: pt("fontSize"), lineHeightPt: pt("lineHeight"),
    moduleGapPt: pt("moduleSpacing"), pageMarginPt: pt("pageMargin"), headingSizePt: pt("headingFontSize"),
    paragraphGapPt: pt("paragraphSpacing"), listGapPt: pt("listSpacing"), theme: defaults.theme,
    dateFormat: defaults.dateFormat, titleFormat: defaults.titleFormat, separator: defaults.separator,
    textAlign: defaults.textAlign, legacyOverrides: {} };
}

async function generateInHost(host, sample, presentation) {
  return host.page.evaluate(async ({ sample, presentation }) => {
    const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
    let current = await invoke("document_state");
    const command = async payload => {
      const result = await invoke("apply_document_command", { envelope: {
        protocolVersion: 1, commandId: crypto.randomUUID(), documentId: current.cursor.documentId,
        contextId: current.cursor.contextId, expectedRevision: current.cursor.revision,
        expectedBranchId: current.cursor.branchId, expectedHeadId: current.cursor.headId, payload,
      } });
      if (result.durable !== true || result.cursor.documentId !== current.cursor.documentId) throw new Error("Seed command did not receive a durable target receipt");
      current = { cursor: result.cursor, document: result.document };
    };
    for (const section of current.document.sections) {
      if (Array.isArray(section.entries)) {
        for (const entry of section.entries) await command({ type: "deleteEntry", entry_id: entry.id });
      }
      await command({ type: "setSectionVisibility", section_id: section.id, visible: sample.truth.sections.includes(section.kind) });
    }
    await command({ type: "setDocumentTitle", title: sample.id });
    await command({ type: "updateBasic", patch: {
      name: sample.truth.fields["basic.name"], phone: sample.truth.fields["basic.phone"],
      email: sample.truth.fields["basic.email"], website: sample.truth.fields["basic.website"],
      city: "", wechat: "", birth: "", ethnicity: "",
    } });
    await command({ type: "setLayout", presentation });
    const headings = { education: sample.truth.paragraphs[4], work: sample.truth.paragraphs[7], skills: sample.truth.paragraphs.at(-2) };
    for (const [order, kind] of sample.truth.sections.entries()) {
      const section = current.document.sections.find(value => value.kind === kind);
      if (!section || !Array.isArray(section.entries)) throw new Error(`Missing native section: ${kind}`);
      await command({ type: "renameSection", section_id: section.id, title: headings[kind] });
      await command({ type: "moveSection", section_id: section.id, index: order });
      for (let entryIndex = 0; entryIndex < sample.truth.entryCounts[kind]; entryIndex += 1) {
        const prefix = `${kind}.${entryIndex}`;
        const body = sample.truth.destinations.filter(value => value.path === `${prefix}.html`)
          .sort((left, right) => left.paragraphIndex - right.paragraphIndex)
          .map(value => ({ type: "paragraph", children: [{ type: "text", text: value.text, marks: [] }] }));
        await command({ type: "addEntry", section_id: section.id, entry: {
          id: `${sample.id}-${kind}-${entryIndex}`, title: sample.truth.fields[`${prefix}.title`] ?? "",
          role: "", department: "", city: "", start: sample.truth.fields[`${prefix}.start`] ?? "",
          end: sample.truth.fields[`${prefix}.end`] ?? "", college: null, mode: null, body,
        } });
      }
    }
    const frozen = await invoke("document_state");
    if (JSON.stringify(frozen.cursor) !== JSON.stringify(current.cursor)) throw new Error("Document changed before input export");
    const result = await invoke("render_document_export", { cursor: frozen.cursor, product: "pdf" });
    if (JSON.stringify(result.cursor) !== JSON.stringify(frozen.cursor)) throw new Error("Frozen export target mismatch");
    const after = await invoke("document_state");
    if (JSON.stringify(after) !== JSON.stringify(frozen)) throw new Error("Read-only export changed its source");
    return { frozen, result };
  }, { sample, presentation });
}

async function main() {
  assert.ok(process.argv.slice(2).every(arg => arg === "--check-inputs"), "Only --check-inputs is accepted");
  const generator = await verifyGenerator();
  const inventory = validateCorpus();
  const builtin = samples.filter(sample => sample.group === "builtin");
  assert.equal(builtin.length, 6);
  const recipes = await loadPresentationRecipes();
  const inputs = builtin.map(sample => ({ id: sample.id, template: sample.family, lengthVariant: sample.lengthVariant,
    truthSha256: jsonHash(sample.truth), presentation: presentationFor(sample, recipes) }));
  if (process.argv.includes("--check-inputs")) {
    console.log(JSON.stringify({ generator, inventory, inputs, nativeStarted: false }, null, 2));
    return;
  }
  await mkdir(output, { recursive: true });
  const outputReal = await realpath(output);
  assertOwnedPath(await realpath(root), outputReal);
  const profile = await mkdtemp(join(outputReal, "profile-"));
  const profileReal = await realpath(profile);
  assertOwnedPath(outputReal, profileReal);
  const manifest = { schemaVersion: 1, startedAt: new Date().toISOString(), generator, policy,
    inputs: {}, generated: [], cleanup: { profile, stopped: false, deleted: false },
    qualification: "Only true published-engine input generation; no current-native, import, or release qualification",
    sourcePageAnnotations: "pending review against actual PDF; TextMap remains generation evidence, not independent content answers" };
  for (const file of ["fixtures/import-quality/corpus.mjs", "tools/generate-import-builtin.mjs",
    "src/ui/templates/registry.ts", "src/ui/domain/template-model.ts", "tests/native/host-fixture.mjs"]) {
    manifest.inputs[file] = sha256(await readFile(join(root, file)));
  }
  let host, failure;
  try {
    host = await startNativeHost(profileReal, { executable, dataDir: join(profileReal, "Data"), buildProfile: "published-alpha2" });
    manifest.hostPid = host.child.pid;
    for (const sample of builtin) {
      const presentation = presentationFor(sample, recipes);
      const { frozen, result } = await generateInHost(host, sample, presentation);
      const bytes = Buffer.from(result.data.pdfBase64, "base64");
      assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-");
      assert.equal(sha256(bytes), result.data.pdfSha256);
      assert.ok(Number.isInteger(result.data.pageCount) && result.data.pageCount > 0);
      const pdfName = `${sample.id}.pdf`;
      await writeFile(join(outputReal, pdfName), bytes);
      assert.equal(sha256(await readFile(join(outputReal, pdfName))), result.data.pdfSha256);
      await writeFile(join(outputReal, `${sample.id}.frozen.json`), JSON.stringify(frozen, null, 2) + "\n");
      await writeFile(join(outputReal, `${sample.id}.textmap.json`), JSON.stringify(result.data.textMap, null, 2) + "\n");
      manifest.generated.push({ id: sample.id, template: sample.family, density: presentation.density,
        lengthVariant: sample.lengthVariant, fixtureTruthSha256: jsonHash(sample.truth), presentation,
        cursor: frozen.cursor, renderKey: result.renderKey, frozenDocumentSha256: jsonHash(frozen.document),
        frozenDocumentEncoding: "SHA256 of JSON.stringify(frozen.document); distinct from Rust canonical_hash",
        pdf: pdfName, pdfSha256: result.data.pdfSha256, bytes: bytes.length, pageCount: result.data.pageCount,
        expectedPageCount: sample.pageCount, independentPageAnnotations: "pending" });
      await writeFile(join(outputReal, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
      console.log(`${sample.id}: ${sample.family} / ${presentation.density} / ${sample.lengthVariant}; ${result.data.pageCount} pages`);
    }
  } catch (error) {
    failure = error;
    manifest.error = String(error.stack ?? error);
  } finally {
    try {
      if (host) await stopNativeHost(host);
      manifest.cleanup.stopped = true;
      const info = await lstat(profileReal);
      assert.equal(info.isSymbolicLink(), false, "Profile was replaced by a link");
      assertOwnedPath(outputReal, await realpath(profileReal));
      await rm(profileReal, { recursive: true, force: false, maxRetries: 20, retryDelay: 200 });
      await assert.rejects(access(profileReal), error => error.code === "ENOENT");
      manifest.cleanup.deleted = true;
    } catch (error) {
      manifest.cleanup.error = String(error.stack ?? error);
      failure ??= error;
    }
    manifest.finishedAt = new Date().toISOString();
    manifest.completed = !failure && manifest.generated.length === builtin.length && manifest.cleanup.deleted;
    await writeFile(join(outputReal, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  }
  if (failure) throw failure;
}

await main();
