import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { startNativeHost, stopNativeHost } from "./host-fixture.mjs";

const root = resolve(import.meta.dirname, "../../.artifacts/runtime-tmp/test-evidence/R26/session3-publication");
function databaseRows(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return Object.fromEntries(tables.map(({ name }) => [name,
      database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
        .map(row => JSON.stringify(row, (_key, value) => value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value)).sort(),
    ]));
  } finally { database.close(); }
}
for (const operation of ["COMMIT", "IMPORT", "RESTORE"]) {
  for (const phase of ["before-commit", "after-commit"]) {
    test(`real ${operation} publication killed ${phase} preserves complete old/new state`, { timeout: 60_000 }, async () => {
      await mkdir(root, { recursive: true });
      const profile = await mkdtemp(join(root, "profile-"));
      assert.ok(resolve(profile).startsWith(root + sep));
      const marker = join(profile, "marker.txt");
      const executable = resolve(import.meta.dirname, "../../src-tauri/target/hooks/zinecv-desktop.exe");
      const report = { operation, phase, fixture: "synthetic isolated test-hooks host", executableSha256: createHash("sha256").update(await readFile(executable)).digest("hex"), hostPids: [] };
      let host, pending, passed = false;
      try {
        host = await startNativeHost(profile, { buildProfile: "hooks", env: {
          [`ZINECV_TEST_${operation}_PAUSE_PHASE`]: phase,
          [`ZINECV_TEST_${operation}_PAUSE_MARKER`]: marker,
        } });
        report.hostPids.push(host.child.pid);
        await host.page.getByRole("button", { name: "编辑简历名称", exact: true }).click();
        await host.page.getByLabel("简历名称", { exact: true }).fill("P06 publication fixture");
        await host.page.getByLabel("简历名称", { exact: true }).press("Enter");
        await host.page.locator(".save-state").getByText("草稿已保存").waitFor();
        let backup;
        if (operation === "RESTORE") {
          backup = await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("export_database_backup"));
          report.candidate = (await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"))).document;
          await host.page.getByRole("button", { name: "编辑简历名称", exact: true }).click();
          await host.page.getByLabel("简历名称", { exact: true }).fill("P06 live state before restore");
          await host.page.getByLabel("简历名称", { exact: true }).press("Enter");
          await host.page.locator(".save-state").getByText("草稿已保存").waitFor();
        }
        if (operation === "IMPORT") await host.page.evaluate(async () => {
          const invoke = window.__TAURI_INTERNALS__.invoke;
          // M2 起 create_import_draft 携带目标文档与宿主 epoch。
          const state = await invoke("document_state");
          await invoke("create_import_draft", { request: { draftId: "p06-draft", sourceKind: "legacy_json", displayName: "synthetic.json", sourceHash: "a".repeat(64), expectedEpoch: state.epoch, targetDocumentId: state.cursor.documentId } });
          const transition = (expectedStatus, nextStatus, candidates = null) => invoke("transition_import_draft", { request: { draftId: "p06-draft", expectedStatus, nextStatus, candidates, warnings: null, unsupportedFeatures: null, previewDataUrl: null } });
          await transition("queued", "running");
          await transition("running", "review_required", [{ id: "p06-name", label: "合成姓名", value: { type: "basicField", field: "name", value: "P06 imported name" }, evidence: { page: null, excerpt: "synthetic", sourceField: "name", confidence: "high" } }]);
        });
        report.before = await host.page.evaluate(async () => ({
          state: await window.__TAURI_INTERNALS__.invoke("document_state"),
          graph: await window.__TAURI_INTERNALS__.invoke("version_graph_detailed"),
        }));
        if (operation === "RESTORE") {
          report.oldTables = databaseRows(join(profile, "Data/zinecv.sqlite3"));
          const bytes = Buffer.from(backup.databaseBase64, "base64");
          // A standalone serialized WAL image has no WAL sidecar; use rollback
          // headers only on this independent read-only verification copy.
          bytes[18] = 1; bytes[19] = 1;
          const candidatePath = join(profile, "candidate-verification.db");
          await writeFile(candidatePath, bytes);
          report.candidateTables = databaseRows(candidatePath);
        }
        pending = host.page.evaluate(async ({ operation, backup }) => {
          const invoke = window.__TAURI_INTERNALS__.invoke;
          const state = await invoke("document_state");
          if (operation === "COMMIT") return invoke("commit_version", { cursor: state.cursor, message: "P06 atomic commit" });
          if (operation === "RESTORE") return invoke("restore_database_backup", { payload: backup });
          return invoke("apply_import", { request: { cursor: state.cursor, commandId: "p06-apply", draftId: "p06-draft", acceptedCandidateIds: ["p06-name"] } });
        }, { operation, backup }).catch(error => String(error));
        let markerText;
        const deadline = Date.now() + 12_000;
        while (Date.now() < deadline) {
          markerText = await readFile(marker, "utf8").catch(() => "");
          if (markerText) break;
          await new Promise(done => setTimeout(done, 50));
        }
        assert.equal(markerText, `${host.child.pid}:${phase}`, "real publication marker before kill");
        report.marker = markerText;
        await stopNativeHost(host); host = undefined;
        report.abortedCall = await pending;
        if (operation === "RESTORE") {
          report.publishedTables = databaseRows(join(profile, "Data/zinecv.sqlite3"));
          if (phase === "before-commit") {
            assert.deepEqual(report.publishedTables, report.oldTables);
          } else {
            // M2 起恢复后的 active 规范化与离开栅栏会原内容推进修订，并写入
            // 宿主侧 active/迁移标记；内容与候选一致、修订单调不减即等价。
            const normalize = tables => {
              const clone = structuredClone(tables);
              for (const key of ["documents", "drafts"]) {
                clone[key] = (clone[key] ?? []).map(row => {
                  const parsed = JSON.parse(row);
                  delete parsed.revision;
                  return JSON.stringify(parsed);
                });
              }
              clone.settings = (clone.settings ?? []).filter(row =>
                !["active-document-id", "workspace-preferences-migrated-v1"]
                  .includes(JSON.parse(row).key));
              return clone;
            };
            const publishedDocument = JSON.parse(report.publishedTables.documents?.[0]);
            const candidateDocument = JSON.parse(report.candidateTables.documents?.[0]);
            assert.ok(BigInt(publishedDocument.revision) >= BigInt(candidateDocument.revision),
              "restored revision must not go backwards");
            assert.deepEqual(normalize(report.publishedTables), normalize(report.candidateTables));
          }
          report.completeDatabaseTablesEqual = true;
        }
        host = await startNativeHost(profile, { buildProfile: "hooks" });
        report.hostPids.push(host.child.pid);
        report.after = await host.page.evaluate(async () => ({
          state: await window.__TAURI_INTERNALS__.invoke("document_state"),
          graph: await window.__TAURI_INTERNALS__.invoke("version_graph_detailed"),
        }));
        if (phase === "before-commit") assert.deepEqual(report.after, report.before);
        else if (operation === "COMMIT") {
          assert.deepEqual(report.after.state.document, report.before.state.document);
          assert.equal(report.after.graph.commits.length, report.before.graph.commits.length + 1);
          assert.equal(report.after.graph.commits.find(c => c.id === report.after.state.cursor.headId).message, "P06 atomic commit");
          assert.deepEqual(JSON.parse(report.after.graph.commits.find(c => c.id === report.after.state.cursor.headId).snapshotDocumentJson), report.before.state.document);
          assert.equal(BigInt(report.after.state.cursor.revision), BigInt(report.before.state.cursor.revision) + 1n);
        } else if (operation === "RESTORE") assert.deepEqual(report.after.state.document, report.candidate);
        else {
          const expected = structuredClone(report.before.state.document);
          expected.basic.name = "P06 imported name";
          assert.deepEqual(report.after.state.document, expected);
        }
        if (operation === "IMPORT") {
          report.importDraft = await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_import_draft", { draftId: "p06-draft" }));
          assert.equal(report.importDraft.status, phase === "before-commit" ? "review_required" : "committed");
          const database = new DatabaseSync(join(profile, "Data/zinecv.sqlite3"), { readOnly: true });
          try {
            report.importReceiptCount = database.prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE command_id='p06-apply'").get().count;
            assert.equal(report.importReceiptCount, phase === "before-commit" ? 0 : 1);
          } finally { database.close(); }
        }
        report.status = "passed"; passed = true;
      } catch (error) { report.status = "failed"; report.failure = String(error.stack ?? error); throw error; }
      finally {
        if (host) await stopNativeHost(host);
        await pending;
        await writeFile(join(root, `${operation.toLowerCase()}-${phase}.json`), JSON.stringify(report, null, 2));
        if (passed) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      }
    });
  }
}
