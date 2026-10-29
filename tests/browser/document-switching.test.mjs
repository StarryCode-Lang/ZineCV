import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";

// Replace only the document editor surface. Exercise the real transition root,
// picker, persistence gate, IPC transport and NativeDocumentClient together.
const editorSurface = `
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { nativeClient, registerDraftFlush } from "../../platform/workspace";
import { registerAgentShutdownGuard } from "../../platform/appUpdate";
import { DocumentSwitcher } from "./workspace/DocumentSwitcher";
import "../styles/index.css";
export default function App({ onDocumentTransition, documentTransitionBusy }) {
  const [id, setId] = useState("");
  const [text, setText] = useState("");
  const latest = useRef(text); latest.current = text;
  window.switchFixture.transition = onDocumentTransition;
  useEffect(() => {
    const fixture = window.switchFixture;
    fixture.mounts++;
    let active = true;
    void nativeClient.load().then(state => {
      if (active) { setId(state.cursor.documentId); setText(fixture.saved[state.cursor.documentId]); }
    });
    const stop = registerDraftFlush(async () => {
      fixture.events.push("draft");
      if (fixture.failSave) return { ok: false };
      fixture.saved[nativeClient.snapshot.cursor.documentId] = latest.current;
      return { ok: true };
    });
    registerAgentShutdownGuard({ settle: async () => {
      fixture.events.push("agent");
      if (fixture.holdAgent) await new Promise(resolve => { fixture.releaseAgent = resolve; });
    } });
    return () => { active = false; stop(); registerAgentShutdownGuard(null); };
  }, []);
  return <>
    <main className="app-shell" data-document-id={id}>
      <input aria-label="Synthetic draft" value={text} onChange={event => setText(event.target.value)} />
      <DocumentSwitcher onTransition={onDocumentTransition} />
    </main>
    {createPortal(<div data-agent-portal inert={documentTransitionBusy || undefined}><button>Assistant fixture</button></div>, document.body)}
  </>;
}`;

test("document switching saves the original target, blocks repeats, remounts without page reload and preserves failed drafts", { timeout: 60_000 }, async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."), {
    sourceOverrides: new Map([["src/ui/app/App.tsx", editorSurface]]),
  });
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(async () => {
      const { registerPlatformInvoke } = await import("/src/platform/ipc.ts");
      const fixture = window.switchFixture = {
        mounts: 0, switches: 0, active: "A", epoch: 7, saved: { A: "A original", B: "B original" },
        revisions: { A: 0, B: 0 }, failSave: true, holdAgent: false, events: [], dropSwitchAck: false, failReads: 0,
      };
      const state = () => ({
        cursor: { documentId: fixture.active, contextId: "same-context", branchId: "main", headId: null, revision: String(fixture.revisions[fixture.active]) },
        document: { schemaVersion: 2, documentId: fixture.active }, epoch: fixture.epoch,
      });
      registerPlatformInvoke(async (command, args) => {
        fixture.events.push(`ipc:${command}`);
        if (command === "document_state") {
          if (fixture.failReads > 0) { fixture.failReads--; throw new Error("read unavailable"); }
          return state();
        }
        if (command === "document_list") return { activeDocumentId: fixture.active, documents: ["A", "B"].map(documentId => ({ documentId, title: "同名简历", archived: false })) };
        if (command === "switch_active_document") {
          const request = args.request;
          if (typeof request.expectedEpoch !== "number" || request.expectedEpoch !== fixture.epoch || request.expectedCurrentId !== fixture.active) throw new Error("stale request");
          fixture.revisions[fixture.active]++;
          fixture.active = request.targetDocumentId; fixture.epoch++; fixture.switches++;
          if (fixture.dropSwitchAck) { fixture.dropSwitchAck = false; throw new Error("switch acknowledgement lost"); }
          return { ...state(), documentId: fixture.active, meta: {} };
        }
        throw new Error("Unexpected fixture IPC: " + command);
      });
      await import("/tests/browser/fixtures/mount-document-workspace.tsx");
    });
    await page.waitForFunction(() => document.querySelector(".app-shell")?.dataset.documentId === "A");
    const draft = page.getByRole("textbox", { name: "Synthetic draft" });
    await draft.fill("A unsaved");
    await page.getByTitle("简历文档").click();
    await page.getByRole("menuitem").nth(1).click();
    await page.getByRole("alert").filter({ hasText: "草稿尚未保存成功" }).waitFor();
    assert.equal(await draft.inputValue(), "A unsaved");
    assert.equal(await page.evaluate(() => window.switchFixture.switches), 0);
    await page.evaluate(() => { window.switchFixture.failSave = false; window.switchFixture.holdAgent = true; });
    await page.getByRole("menuitem").nth(1).click();
    await page.waitForFunction(() => !!window.switchFixture.releaseAgent);
    const waiting = await page.evaluate(async () => {
      let rejected = false;
      try { await window.switchFixture.transition(async () => { throw new Error("must not run"); }); } catch { rejected = true; }
      return { rejected, locked: document.querySelector(".document-workspace-root").inert, portal: document.querySelector("[data-agent-portal]").inert };
    });
    assert.deepEqual(waiting, { rejected: true, locked: true, portal: true });
    await page.evaluate(() => document.querySelector('[aria-label="Synthetic draft"]').focus());
    await page.keyboard.insertText("MUST NOT ENTER");
    assert.equal(await draft.inputValue(), "A unsaved");
    await page.evaluate(() => { window.switchFixture.holdAgent = false; window.switchFixture.releaseAgent(); });
    await page.waitForFunction(() => document.querySelector(".app-shell")?.dataset.documentId === "B");
    assert.equal(await draft.inputValue(), "B original");
    assert.deepEqual(await page.evaluate(() => ({ mounts: window.switchFixture.mounts, switches: window.switchFixture.switches, saved: window.switchFixture.saved })), {
      mounts: 2, switches: 1, saved: { A: "A unsaved", B: "B original" },
    });
    await draft.fill("B edited");
    await page.getByTitle("简历文档").click();
    await page.getByRole("textbox", { name: "搜索简历" }).fill("missing");
    assert.equal(await page.getByRole("menuitem").count(), 0);
    await page.getByRole("textbox", { name: "搜索简历" }).fill("同名");
    await page.getByRole("menuitem").nth(0).click();
    await page.waitForFunction(() => document.querySelector(".app-shell")?.dataset.documentId === "A");
    assert.equal(await draft.inputValue(), "A unsaved");
    assert.equal(await page.evaluate(() => window.switchFixture.saved.B), "B edited");
    await page.evaluate(() => { window.switchFixture.dropSwitchAck = true; });
    await page.getByTitle("简历文档").click();
    await page.getByRole("menuitem").nth(1).click();
    await page.waitForFunction(() => document.querySelector(".app-shell")?.dataset.documentId === "B");
    assert.equal(await draft.inputValue(), "B edited", "a missing switch acknowledgement reconciles the real host target before editing resumes");
    await page.evaluate(() => { window.switchFixture.dropSwitchAck = true; window.switchFixture.failReads = 1; });
    await page.getByTitle("简历文档").click();
    await page.getByRole("menuitem").nth(0).click();
    await page.getByRole("alert").filter({ hasText: "切换响应未确认" }).waitFor();
    assert.equal(await page.evaluate(() => document.querySelector(".document-workspace-root").inert), true);
    await page.getByRole("button", { name: "重试读取当前简历" }).click();
    await page.waitForFunction(() => document.querySelector(".app-shell")?.dataset.documentId === "A" && !document.querySelector(".document-workspace-root").inert).catch(async reason => {
      assert.fail(`${reason.message}: ${JSON.stringify(await page.evaluate(() => ({ fixture: window.switchFixture, visible: document.body.innerText, documentId: document.querySelector(".app-shell")?.dataset.documentId })))}`);
    });
    assert.equal(await draft.inputValue(), "A unsaved");
    assert.deepEqual(errors, []);
  } finally {
    await context.close(); await browser.close(); await server.close();
  }
});

test("duplicating through the picker flushes the source and keeps both drafts independent across a page reopen", { timeout: 60_000 }, async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."), {
    sourceOverrides: new Map([["src/ui/app/App.tsx", editorSurface]]),
  });
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const url = `http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`;
    // The host below is deliberately simulated. This test proves browser
    // wiring; m2_boundary_tests owns the real SQLite close/reopen assertion.
    const mount = () => page.evaluate(async () => {
      const { registerPlatformInvoke } = await import("/src/platform/ipc.ts");
      const key = "zinecv.copy-reopen.fixture";
      const persisted = window.localStorage.getItem(key);
      const fixture = window.switchFixture = {
        ...(persisted ? JSON.parse(persisted) : {
          active: "A", epoch: 7, saved: { A: "source initial" }, revisions: { A: 0 },
          documents: [{ documentId: "A", title: "原件", archived: false }], creates: [],
        }),
        mounts: 0, events: [], switches: 0, failSave: false, holdAgent: false,
      };
      const persist = () => window.localStorage.setItem(key, JSON.stringify({
        active: fixture.active, epoch: fixture.epoch, saved: fixture.saved,
        revisions: fixture.revisions, documents: fixture.documents, creates: fixture.creates,
      }));
      const state = () => ({
        cursor: { documentId: fixture.active, contextId: `context:${fixture.active}`, branchId: `main:${fixture.active}`,
          headId: null, revision: String(fixture.revisions[fixture.active]) },
        document: { schemaVersion: 2, documentId: fixture.active }, epoch: fixture.epoch,
      });
      registerPlatformInvoke(async (command, args) => {
        fixture.events.push(`ipc:${command}`);
        if (command === "document_state") { persist(); return state(); }
        if (command === "document_list") return { activeDocumentId: fixture.active, documents: fixture.documents };
        if (command === "document_create") {
          const request = args.request;
          if (request.payload.kind !== "duplicate" || request.payload.sourceDocumentId !== fixture.active ||
            request.expectedCurrentId !== fixture.active || request.expectedEpoch !== fixture.epoch) throw new Error("invalid duplicate target");
          const id = `doc:${request.commandId}`;
          fixture.creates.push(structuredClone(request));
          fixture.saved[id] = fixture.saved[request.payload.sourceDocumentId];
          fixture.revisions[fixture.active]++;
          fixture.revisions[id] = 0;
          fixture.documents.push({ documentId: id, title: request.payload.initialTitle, archived: false });
          fixture.active = id; fixture.epoch++;
          persist();
          return { receipt: { commandId: request.commandId, documentId: id }, activeState: state() };
        }
        if (command === "switch_active_document") {
          const request = args.request;
          if (request.expectedEpoch !== fixture.epoch || request.expectedCurrentId !== fixture.active ||
            !fixture.documents.some(item => item.documentId === request.targetDocumentId)) throw new Error("invalid switch target");
          fixture.revisions[fixture.active]++;
          fixture.active = request.targetDocumentId; fixture.epoch++; fixture.switches++;
          persist();
          return { ...state(), documentId: fixture.active, meta: {} };
        }
        throw new Error("Unexpected copy fixture IPC: " + command);
      });
      await import("/tests/browser/fixtures/mount-document-workspace.tsx");
    });
    const waitForDocument = id => page.waitForFunction(expected => document.querySelector(".app-shell")?.dataset.documentId === expected, id);
    const switchTo = async (title, id) => {
      await page.getByTitle("简历文档").click();
      await page.getByRole("menuitem", { name: title, exact: true }).click();
      await waitForDocument(id);
    };
    await page.goto(url);
    await mount();
    await waitForDocument("A");
    const draft = page.getByRole("textbox", { name: "Synthetic draft" });
    await draft.fill("source saved just before copying");
    await page.getByTitle("简历文档").click();
    await page.getByRole("button", { name: "新建 / 复制", exact: true }).click();
    await page.getByPlaceholder("新简历标题").fill("副本");
    await page.getByRole("button", { name: "复制当前", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".app-shell")?.dataset.documentId.startsWith("doc:"));
    const copyId = await page.evaluate(() => window.switchFixture.active);
    assert.equal(await draft.inputValue(), "source saved just before copying", "copy uses the draft flushed by the real transition gate");
    const creation = await page.evaluate(() => ({ requests: window.switchFixture.creates, events: window.switchFixture.events }));
    assert.equal(creation.requests.length, 1);
    assert.equal(creation.requests[0].payload.sourceDocumentId, "A");
    assert.equal(creation.requests[0].expectedCurrentId, "A");
    assert.ok(creation.events.indexOf("draft") < creation.events.indexOf("ipc:document_create"));
    await draft.fill("copy independently edited");
    await switchTo("原件", "A");
    assert.equal(await draft.inputValue(), "source saved just before copying");
    await draft.fill("source independently edited");
    await switchTo("副本", copyId);
    assert.equal(await draft.inputValue(), "copy independently edited");
    await page.reload();
    await mount();
    await waitForDocument(copyId);
    assert.equal(await draft.inputValue(), "copy independently edited");
    await switchTo("原件", "A");
    assert.equal(await draft.inputValue(), "source independently edited");
    assert.equal(await page.evaluate(() => window.switchFixture.creates.length), 1, "reopening does not repeat creation");
    assert.deepEqual(errors, []);
  } finally {
    await context.close(); await browser.close(); await server.close();
  }
});

test("the real agent shell keeps old proposal cards bound to their document and distinguishes confirmation from safe undo", { timeout: 60_000 }, async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(() => import("/tests/browser/fixtures/mount-proposal-target-shell.tsx"));
    const pending = page.getByRole("region", { name: "宿主保存的待审阅提议", exact: true });
    const undo = page.getByRole("region", { name: "撤回已确认的 Agent 修改", exact: true });
    await pending.waitFor();
    const accept = pending.getByRole("button", { name: "确认所选 2 项", exact: true });
    const undoButton = undo.getByRole("button", { name: "撤回这次修改", exact: true });
    assert.equal(await accept.isDisabled(), true, "same-name documents do not grant confirmation authority");
    assert.equal(await undoButton.isDisabled(), true, "same-name documents do not grant undo authority");
    assert.match(await pending.innerText(), /目标简历：同名简历/);
    assert.match(await undo.innerText(), /目标简历：同名简历/);
    await pending.getByRole("button", { name: "拒绝", exact: true }).click();
    await pending.getByRole("button", { name: "切回此提议的简历", exact: true }).click();
    await undo.getByRole("button", { name: "返回这次修改的简历", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => ({ returned: window.proposalCardFixture.returned, rejected: window.proposalCardFixture.rejected,
      accepted: window.proposalCardFixture.accepted, undone: window.proposalCardFixture.undone })), {
      returned: ["doc:original", "doc:original"], rejected: ["proposal:original"], accepted: [], undone: [],
    });
    await page.evaluate(() => window.proposalCardFixture.setCursor({ revision: "5" }));
    await page.waitForFunction(() => ![...document.querySelectorAll("button")].find(button => button.textContent === "撤回这次修改")?.disabled);
    assert.equal(await accept.isDisabled(), true, "confirmation requires the exact original revision");
    assert.equal(await undoButton.isDisabled(), false, "a later revision alone does not block guarded undo");
    assert.equal(await pending.getByRole("button", { name: "切回此提议的简历", exact: true }).count(), 0);
    await undoButton.click();
    assert.deepEqual(await page.evaluate(() => window.proposalCardFixture.undone), ["receipt:original"]);
    for (const patch of [{ contextId: "context:other" }, { branchId: "branch:other" }]) {
      await page.evaluate(value => window.proposalCardFixture.setCursor(value), patch);
      await page.waitForFunction(() => [...document.querySelectorAll("button")].find(button => button.textContent === "撤回这次修改")?.disabled);
      assert.equal(await accept.isDisabled(), true);
      assert.equal(await undoButton.isDisabled(), true, "the same document must still match context and branch");
    }
    await page.evaluate(() => window.proposalCardFixture.setCursor({}));
    await page.waitForFunction(() => ![...document.querySelectorAll("button")].find(button => button.textContent === "确认所选 2 项")?.disabled);
    const items = pending.getByRole("checkbox");
    await items.nth(1).uncheck();
    await pending.getByRole("button", { name: "确认所选 1 项", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.proposalCardFixture.accepted), [{ id: "proposal:original", items: ["item:name"] }]);
    await items.nth(0).uncheck();
    assert.equal(await pending.getByRole("button", { name: "确认所选 0 项", exact: true }).isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally {
    await context.close(); await browser.close(); await server.close();
  }
});
