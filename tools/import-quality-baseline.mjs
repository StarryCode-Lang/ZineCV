import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { samples, boundaryCases, policy, validateCorpus } from "../fixtures/import-quality/corpus.mjs";
import { materializeSample, materializeBoundary } from "../fixtures/import-quality/materialize.mjs";
import { scoreSample } from "../fixtures/import-quality/score.mjs";
import { builtinSourceAnswer } from "../fixtures/import-quality/builtin-source-answers.mjs";
import { Sampler } from "./lightweight/measurement-runtime.mjs";
import { deriveSamples, summarizeWindow } from "./lightweight/classify.mjs";
import { unlinkSync } from "node:fs";
import { createBrowserTestServer, listenForBrowserTestServer, launchBrowserTestChromium } from "../tests/browser/fixtures/browser-test-server.mjs";

const args = process.argv.slice(2);
const split = args.includes("--holdout") ? "holdout" : "development";
const idAt = args.indexOf("--id");
const selectedIds = idAt >= 0 ? new Set(args[idAt + 1]?.split(",")) : null;
if (args.includes("--holdout") && args.includes("--check")) throw new Error("--check does not run a holdout");
if (args.includes("--gate") && args.includes("--check")) throw new Error("--gate and --check are mutually exclusive");
if (selectedIds) {
  const available = new Set([...samples.filter(row => row.split === split),
    ...(split === "development" && !args.includes("--no-boundaries") ? boundaryCases : [])].map(row => row.id));
  if (!selectedIds.size || [...selectedIds].some(id => !available.has(id))) throw new Error("Unknown, empty, excluded or wrong-split sample ID");
}
const outputAt = args.indexOf("--output");
const output = resolve(outputAt >= 0 ? args[outputAt + 1] : `.artifacts/import-quality/${split}`);
const root = resolve(import.meta.dirname, "..");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const referenceAt = args.indexOf("--reference");
const referenceFiles = ["src/ui/services/template-import.ts", "src/ui/services/template-file-parser.worker.ts",
  "src/ui/services/resume-content-recognition.ts", "src/ui/services/resume-recognition.worker.ts",
  "src/ui/services/pdf-reading-order.ts", "src/ui/services/import-limits.ts", "src/ui/services/pdfjs-resources.ts"];
const reference = referenceAt < 0 ? null : execFileSync("git", ["rev-parse", "--verify", `${args[referenceAt + 1]}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
const sourceOverrides = new Map(reference ? referenceFiles.map(path => [path,
  execFileSync("git", ["show", `${reference}:${path}`], { cwd: root, encoding: "utf8" })]) : []);
const inventory = validateCorpus();
if (args.includes("--check")) {
  console.log(JSON.stringify({ inventory, policy }, null, 2));
} else {
  const server = await createBrowserTestServer(root, { sourceOverrides });
  let browser;
  let memorySampler;
  let memoryRootPid;
  let memoryStartedAt;
  const memoryStop = resolve(output, `sampler-${process.pid}.stop`);
  const report = { schemaVersion: 1, kind: "diagnostic-baseline", split,
    scope: selectedIds ? "selected-cases-only" : "split-baseline",
    phaseAcceptance: false,
    inputStabilityScope: "explicitly listed source/fixture files only; not a build receipt or complete transitive resource freeze",
    expectedValidSamples: split === "holdout" ? 12 : 36,
    expectedBoundaryScenarios: split === "development" ? 12 : 0,
    startedAt: new Date().toISOString(),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    productReference: reference,
    referenceSourceSha256: Object.fromEntries([...sourceOverrides].map(([path, source]) => [path, sha256(source)])),
    trackedDiffSha256: sha256(execFileSync("git", ["diff", "--binary"], { cwd: root })),
    fixtureFiles: {}, policy, inventory, samples: [], boundaries: [],
    limits: { processPeakMemory: "not measured; CDP sampled JS heap excludes OCR workers/WASM/native memory",
      correctionTime: "not measured", windowsInstalledChain: "not run", holdout: "not tuning input" } };
  for (const relative of ["fixtures/import-quality/corpus.mjs", "fixtures/import-quality/score.mjs", "fixtures/import-quality/materialize.mjs",
    "fixtures/import-quality/encrypt-pdf.py", "fixtures/import-quality/builtin-source-answers.mjs",
    "tools/import-quality-baseline.mjs", "tests/browser/fixtures/browser-test-server.mjs",
    ...referenceFiles]) {
    report.fixtureFiles[relative] = sha256(await readFile(resolve(root, relative)));
  }
  await mkdir(output, { recursive: true });
  const checkpoint = async () => {
    report.summary = { attempted: report.samples.filter(row => !row.pending).length,
      passed: report.samples.filter(row => row.score?.passed).length,
      pending: report.samples.filter(row => row.pending).map(row => row.id),
      boundaryPassed: report.boundaries.filter(row => row.passed).length,
      boundaryPending: report.boundaries.filter(row => row.pending).map(row => row.id) };
    await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  };
  try {
    await listenForBrowserTestServer(server);
    browser = await launchBrowserTestChromium({ headless: true });
    const context = await browser.newContext();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const externalRequests = [];
    await context.route("**/*", route => {
      const url = route.request().url();
      if (url.startsWith(origin + "/") || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
      externalRequests.push(url);
      return route.abort();
    });
    const generationPage = await context.newPage();
    const recognitionPage = await context.newPage();
    await recognitionPage.goto(`${origin}/__zinecv_browser_test_page.html`);
    const cdp = await context.newCDPSession(recognitionPage);
    await cdp.send("Runtime.enable");
    const recognize = async (material, name) => {
      let sampledPeakJsHeap = 0;
      const sampleHeap = async () => {
        const value = await cdp.send("Runtime.getHeapUsage").catch(() => null);
        if (value) sampledPeakJsHeap = Math.max(sampledPeakJsHeap, value.usedSize);
      };
      const sampler = setInterval(() => { void sampleHeap(); }, 250);
      const started = performance.now();
      try {
        const result = await recognitionPage.evaluate(async ({ base64, name, type }) => {
          const { recognizeTemplate, importedTemplateFieldProvenance } = await import("/src/ui/services/template-import.ts");
          const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 120000);
          const progress = [];
          try {
            const template = await recognizeTemplate(new File([bytes], name, { type }), message => progress.push(message), controller.signal);
            return { extractedText: template.extractedText, resume: template.resume, moduleOrder: template.moduleOrder,
              confidence: template.recognitionConfidence, warnings: template.recognitionWarnings,
              provenance: importedTemplateFieldProvenance(template), progress };
          } catch (error) { return { error: String(error.message), errorName: error.name, progress }; }
          finally { clearTimeout(timer); }
        }, { base64: material.bytes.toString("base64"), name, type: material.type });
        await sampleHeap();
        return { ...result, elapsedMs: performance.now() - started, sampledPeakJsHeap };
      } finally { clearInterval(sampler); }
    };
    // ---- Operation scenarios (IQ-B09..B12) --------------------------------
    // These four boundaries execute real operations against the production
    // services; none is satisfied by a file rejection and no threshold or
    // budget is relaxed: IMPORT_LIMITS.timeoutMs/concurrentParsers stay as
    // shipped and are asserted at execution time.
    const slotError = "当前已有导入任务运行，请等待或取消后重试";
    const probeRecognition = async (page, name, bytes) => {
      const attempt = page.evaluate(async ({ base64, name, type }) => {
        const { recognizeTemplate } = await import("/src/ui/services/template-import.ts");
        const fileBytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
        try {
          const template = await recognizeTemplate(new File([fileBytes], name, { type }), () => {}, new AbortController().signal);
          return { rejected: false, extractedTextLength: template.extractedText?.length ?? 0, hasResume: Boolean(template.resume),
            previewIsDataUrl: typeof template.previewDataUrl === "string" && template.previewDataUrl.startsWith("data:") };
        } catch (error) { return { rejected: true, error: String(error.message), errorName: error.name }; }
      }, { base64: bytes.toString("base64"), name, type: "application/pdf" });
      let guard;
      return await Promise.race([attempt,
        new Promise(resolve => { guard = setTimeout(() =>
          resolve({ rejected: true, error: "probe recognition did not settle", errorName: "ProbeGuard" }), 90000); }),
      ]).finally(() => clearTimeout(guard));
    };
    const completeProbe = probe => Boolean(probe && probe.rejected === false && probe.hasResume && probe.extractedTextLength > 0 && probe.previewIsDataUrl);
    const withRealTimeGuard = (attempt, message, guardMs) => {
      let guard;
      return Promise.race([attempt,
        new Promise(resolve => { guard = setTimeout(() => resolve({ rejected: true, error: message, errorName: "OperationGuard" }), guardMs); }),
      ]).finally(() => clearTimeout(guard));
    };
    const openBoundaryPage = async clock => {
      const page = await context.newPage();
      try {
        if (clock) await page.clock.install();
        await page.goto(`${origin}/__zinecv_browser_test_page.html`);
        return page;
      } catch (error) { await page.close(); throw error; }
    };
    const runTimeoutScenario = async (row, material) => {
      const entry = { ...row, scope: "end-to-end-browser-operation",
        method: "Dedicated page with Playwright page.clock virtual time: the production recognizeTemplate 120s deadline timer is fired with fastForward(120000) while OCR is mid-flight; IMPORT_LIMITS.timeoutMs is asserted to still be 120000 at execution time",
        inputSha256: sha256(material.bytes), bytes: material.bytes.length };
      const page = await openBoundaryPage(true);
      try {
        const start = await page.evaluate(async ({ base64, name }) => {
          const [{ recognizeTemplate }, { IMPORT_LIMITS }] = await Promise.all([
            import("/src/ui/services/template-import.ts"), import("/src/ui/services/import-limits.ts")]);
          if (IMPORT_LIMITS.timeoutMs !== 120000) return { ocrInFlight: false, budgetMismatch: IMPORT_LIMITS.timeoutMs };
          const fileBytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
          const progress = [];
          const controller = new AbortController();
          let settled = false;
          globalThis.__iqTimeoutOutcome = (async () => {
            try {
              const template = await recognizeTemplate(new File([fileBytes], name, { type: "image/png" }),
                message => progress.push(message), controller.signal);
              return { rejected: false, progressLength: progress.length };
            } catch (error) {
              return { rejected: true, error: String(error.message), errorName: error.name, progressLength: progress.length };
            }
          })();
          globalThis.__iqTimeoutOutcome.then(() => { settled = true; }, () => { settled = true; });
          const began = performance.now();
          while (!settled && !progress.some(message => message.includes("正在加载中英文 OCR") || message.includes("正在识别"))) {
            if (performance.now() - began > 60000) return { ocrInFlight: false, progress: [...progress], settled };
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          return { ocrInFlight: !settled, progress: [...progress], settled };
        }, { base64: material.bytes.toString("base64"), name: `${row.id}.png` });
        const advanced = { virtualAdvanceMs: 0, realMsAroundAdvance: null };
        let observed = null;
        if (start.ocrInFlight) {
          const advancedAt = Date.now();
          await page.clock.fastForward(120000);
          advanced.virtualAdvanceMs = 120000;
          advanced.realMsAroundAdvance = Date.now() - advancedAt;
          observed = await withRealTimeGuard(page.evaluate(() => globalThis.__iqTimeoutOutcome),
            "timeout outcome did not settle after the virtual deadline", 90000);
        }
        const probe = await probeRecognition(page, `${row.id}-probe.pdf`, material.probe.bytes);
        const internalTimerFired = Boolean(observed && observed.rejected && observed.errorName === "AbortError"
          && observed.error === "导入超过两分钟限额");
        return { ...entry, passed: Boolean(internalTimerFired && completeProbe(probe)),
          evidence: { start, virtualAdvance: advanced, observed, probe,
            slotReleasedAfterTimeout: probe.rejected === false && probe.error !== slotError },
          note: "导入超过两分钟限额 can only originate from recognizeTemplate's internal IMPORT_LIMITS.timeoutMs branch, so the rejection proves the real 120s timer path fired; the follow-up recognition on the same page proves the concurrency slot was released while concurrentParsers remains 1" };
      } finally { await page.close(); }
    };
    const runCancelScenario = async (row, material) => {
      const entry = { ...row, scope: "end-to-end-browser-operation",
        method: "Caller abort fired synchronously inside the OCR progress callback after the 正在识别 progress appeared; the same page then recognizes a valid input to prove slot and OCR session release",
        inputSha256: sha256(material.bytes), bytes: material.bytes.length };
      const page = await openBoundaryPage(false);
      try {
        const observed = await withRealTimeGuard(page.evaluate(async ({ base64, name }) => {
          const { recognizeTemplate } = await import("/src/ui/services/template-import.ts");
          const fileBytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
          const controller = new AbortController();
          const progress = [];
          let abortedOnProgress = null;
          const began = performance.now();
          try {
            const template = await recognizeTemplate(new File([fileBytes], name, { type: "image/png" }), message => {
              progress.push(message);
              if (!abortedOnProgress && message.includes("正在识别")) {
                abortedOnProgress = message;
                controller.abort();
              }
            }, controller.signal);
            return { rejected: false, abortedOnProgress, progress, elapsedMs: performance.now() - began };
          } catch (error) {
            return { rejected: true, error: String(error.message), errorName: error.name, abortedOnProgress,
              progress, elapsedMs: performance.now() - began };
          }
        }, { base64: material.bytes.toString("base64"), name: `${row.id}.png` }),
          "abort did not surface within the real-time guard window", 120000);
        const probe = await probeRecognition(page, `${row.id}-probe.pdf`, material.probe.bytes);
        const cancelledDuringOcr = Boolean(observed.rejected && observed.errorName === "AbortError"
          && observed.error === "导入已取消" && observed.abortedOnProgress
          && observed.progress.some(message => message.includes("正在识别")));
        return { ...entry, passed: Boolean(cancelledDuringOcr && completeProbe(probe)),
          evidence: { observed: { ...observed, progress: observed.progress.slice(-6) }, probe,
            slotReleasedAfterCancel: probe.rejected === false && probe.error !== slotError },
          note: "导入已取消 distinguishes the caller abort from the internal 120s deadline; the retry only succeeds when activeRecognitions returned to 0 and the aborted OCR session no longer holds the parser slot (concurrentParsers is 1)" };
      } finally { await page.close(); }
    };
    const runRetryScenario = async (row, material) => {
      const entry = { ...row, scope: "end-to-end-browser-operation",
        method: "Two consecutive truncated-PDF parser failures on one page, then one valid input; the third success proves activeRecognitions was released after each failure",
        inputs: { corrupt: { inputSha256: sha256(material.corrupt.bytes), bytes: material.corrupt.bytes.length },
          valid: { inputSha256: sha256(material.valid.bytes), bytes: material.valid.bytes.length } } };
      const page = await openBoundaryPage(false);
      try {
        const attempts = [];
        for (const label of ["failure-1", "failure-2"]) {
          attempts.push({ label, ...(await probeRecognition(page, `${row.id}-${label}.pdf`, material.corrupt.bytes)) });
        }
        const recovery = await probeRecognition(page, `${row.id}-valid.pdf`, material.valid.bytes);
        const parserFailures = attempts.every(attempt => attempt.rejected
          && attempt.errorName !== "AbortError" && attempt.error !== slotError);
        return { ...entry, passed: Boolean(parserFailures && completeProbe(recovery)),
          evidence: { attempts, recovery,
            slotReleasedAfterFailures: recovery.rejected === false && recovery.error !== slotError },
          note: "the truncated PDF fails inside recognizeTemplate after the concurrency slot is taken, so a leaked counter would reject the valid third attempt with the concurrency-gate message instead" };
      } finally { await page.close(); }
    };
    const runTargetScenario = async row => {
      const command = ["--test", "--test-name-pattern", "IQ-B12", "tests/unit/import-safety-operations.test.mjs"];
      let outcome;
      try {
        const stdout = execFileSync(process.execPath, command, { cwd: root, encoding: "utf8", timeout: 120000, windowsHide: true });
        outcome = { command: `node ${command.join(" ")}`, exitCode: 0,
          output: stdout.trim().split(/\r?\n/).slice(-14).join("\n") };
      } catch (error) {
        outcome = { command: `node ${command.join(" ")}`, exitCode: error.status ?? null,
          output: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split(/\r?\n/).slice(-14).join("\n") };
      }
      return { ...row, scope: "unit-evidence",
        method: "tests/unit/import-safety-operations.test.mjs loads the production apply path (runApplyImportDraft in src/ui/app/workspace/documents.tsx) with a mocked native client and asserts late confirmations never reach a switched target; the browser page cannot inject IPC mocks, so no end-to-end claim is made",
        passed: outcome.exitCode === 0,
        evidence: { ...outcome,
          assertedProtections: ["target switch rejected before any native write",
            "resume edited during review rejected at the re-check before applyImport",
            "apply receipt belonging to a switched editing source refused instead of overwriting the editor",
            "result expired between receipt and adoption never reaches the editor",
            "unchanged target still applies the candidates to the captured cursor"] } };
    };
    for (const sample of samples.filter(row => row.split === split && (!selectedIds || selectedIds.has(row.id)))) {
      const material = await materializeSample(sample, generationPage);
      if (material.pending) {
        report.samples.push({ id: sample.id, pending: material.pending });
      } else {
        const observed = await recognize(material, `${sample.id}.${sample.extension}`);
        const sourceAnswer = sample.group === "builtin" ? builtinSourceAnswer(sample) : null;
        const scoringSample = sourceAnswer ? { ...sample, truth: { ...sample.truth,
          paragraphs: sourceAnswer.paragraphs, paragraphPages: sourceAnswer.paragraphPages,
          fields: sourceAnswer.fields ?? sample.truth.fields,
          destinations: sourceAnswer.bodyDestinations.map(destination => ({ ...destination,
            paragraphIndex: destination.sourceReadingUnitIndex })) } } : sample;
        report.samples.push({ id: sample.id, family: sample.family, source: sample.source, language: sample.language,
          inputSha256: sha256(material.bytes), bytes: material.bytes.length, expectedPageCount: sample.pageCount,
          generation: material.generation,
          sourceAnswerSha256: sourceAnswer ? sha256(JSON.stringify(sourceAnswer)) : null,
          sourceAnswerEvidence: sourceAnswer?.evidence,
          observed, score: scoreSample(scoringSample, observed) });
        console.log(`${sample.id}: ${report.samples.at(-1).score.outcome}; ${observed.elapsedMs.toFixed(0)}ms`);
      }
      await checkpoint();
    }
    if (split === "development" && !args.includes("--no-boundaries")) {
      const imagePrototype = samples.find(sample => sample.group === "image");
      for (const row of boundaryCases.filter(row => !selectedIds || selectedIds.has(row.id))) {
        const material = await materializeBoundary(row, generationPage, imagePrototype);
        let entry;
        if (material.pending) entry = { ...row, pending: material.pending };
        else if (material.operation === "timeout") entry = await runTimeoutScenario(row, material);
        else if (material.operation === "cancel") entry = await runCancelScenario(row, material);
        else if (material.operation === "retry") entry = await runRetryScenario(row, material);
        else if (material.operation === "target") entry = await runTargetScenario(row);
        else {
          const observed = await recognize(material, `${row.id}.${material.extension}`);
          entry = { ...row, inputSha256: sha256(material.bytes), bytes: material.bytes.length,
            observed, passed: Boolean(observed.error) };
        }
        report.boundaries.push(entry);
        if (entry.pending) console.log(`${row.id}: pending`);
        else if (material.operation) console.log(`${row.id}: ${entry.passed ? "operation passed" : "OPERATION FAILED"} (${entry.scope})`);
        else console.log(`${row.id}: ${entry.observed.error ? "rejected" : "UNEXPECTED ACCEPT"}`);
        await checkpoint();
      }
    }
    report.externalRequests = externalRequests;
    report.inputsStable = true;
    for (const [relative, digest] of Object.entries(report.fixtureFiles)) {
      if (sha256(await readFile(resolve(root, relative))) !== digest) report.inputsStable = false;
    }
    report.finishedAt = new Date().toISOString();
    await checkpoint();
    console.log(JSON.stringify(report.summary));
    if (externalRequests.length) throw new Error("Unexpected external requests in offline import");
    if (!report.inputsStable) throw new Error("Inputs changed during run; results cannot prove a frozen-input gate");
    if (args.includes("--gate") && ((!report.samples.length && !report.boundaries.length)
      || report.samples.some(row => row.pending || !row.score?.passed)
      || report.boundaries.some(row => row.pending || !row.passed))) process.exitCode = 1;
  } finally {
    await browser?.close();
    await server.close();
  }
}
