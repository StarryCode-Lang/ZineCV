import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { useAppUpdate } from "../../../src/ui/app/useAppUpdate";
import { registerAgentShutdownGuard } from "../../../src/platform/appUpdate";
import { registerPlatformInvoke } from "../../../src/platform/ipc";
import { registerDraftFlush } from "../../../src/platform/workspace";
import { TemplateWorkspace } from "../../../src/ui/templates/TemplateWorkspace";
import { UpdatePanel } from "../../../src/ui/overlays/UpdatePanel";
import { FloatingSurface } from "../../../src/ui/overlays/FloatingSurface";
import "../../../src/ui/styles/index.css";

const state = {
  events: [] as string[], saved: [] as string[], installs: 0, failSave: true,
  holdAgent: true, releaseAgent: null as (() => void) | null,
  install: null as (() => Promise<unknown>) | null,
  unmountTemplate: null as (() => void) | null, appliedTemplates: 0,
  closeUpdatePanel: null as (() => void) | null,
};
Object.assign(window, { updateInstallFixture: state });
localStorage.setItem("resume-diy-update-auto-check-v1", "0");
registerPlatformInvoke(async command => {
  if (command === "app_update_install") { state.installs += 1; return; }
  throw new Error(`Unexpected fixture IPC: ${command}`);
});

function Harness() {
  const [text, setText] = useState("synthetic latest edit");
  const [error, setError] = useState("");
  const [showTemplate, setShowTemplate] = useState(true);
  const [showUpdatePanel, setShowUpdatePanel] = useState(true);
  state.closeUpdatePanel = () => setShowUpdatePanel(false);
  const latest = useRef(text);
  latest.current = text;
  const controller = useAppUpdate({ isExporting: () => false, notify: () => {} });
  const install = async () => {
    const result = await controller.install();
    setError(result.error ?? "");
    return result;
  };
  state.install = install;
  state.unmountTemplate = () => setShowTemplate(false);
  useEffect(() => {
    const unregister = registerDraftFlush(async () => {
      state.events.push("draft-flush");
      if (state.failSave) return { ok: false };
      state.saved.push(latest.current);
      return { ok: true };
    });
    registerAgentShutdownGuard({ settle: async () => {
      state.events.push("agent-cancel-requested");
      if (state.holdAgent) await new Promise<void>(resolve => { state.releaseAgent = resolve; });
      state.events.push("agent-finished-and-saved");
    } });
    return () => { unregister(); registerAgentShutdownGuard(null); };
  }, []);
  return <>
    {showUpdatePanel ? <FloatingSurface anchor={null} onClose={() => setShowUpdatePanel(false)}><UpdatePanel controller={controller} /></FloatingSurface> : null}
    <main className="app-shell" inert={controller.installPending || undefined}>
      <input aria-label="Synthetic draft" value={text} onChange={event => setText(event.target.value)} />
      <button onClick={() => void install()}>Install fixture update</button>
      <output role="alert">{error}</output>
      {showTemplate ? <TemplateWorkspace importedTemplates={[]} currentTemplateId="legacy-v1" currentPageCount={1}
        selectedTemplateId={null} onApplyImported={async () => { state.appliedTemplates += 1; return true; }}
        prepareImportTarget={async () => { throw new Error("Not a review fixture"); }} onApplyImport={async () => {}}
        onRenameImported={() => {}} onBack={() => setShowTemplate(false)} /> : null}
    </main>
    {createPortal(<div data-agent-portal inert={controller.installPending || undefined}>
      <button>Portaled assistant action</button>
    </div>, document.body)}
    {controller.installPending ? <p role="status">Preparing update</p> : null}
  </>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
