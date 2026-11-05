import { useState } from "react";
import { createRoot } from "react-dom/client";
import { registerPlatformInvoke } from "../../../src/platform/ipc";
import { LegacyArchivesDialog } from "../../../src/ui/app/LegacyArchivesDialog";
import "../../../src/ui/styles/index.css";

let fail = false;
registerPlatformInvoke(async (command) => {
  if (command !== "list_legacy_edit_archives") throw new Error("Unexpected command");
  if (fail) throw new Error("归档分块不完整");
  return [{ key: "resume-diy-imported-text-v1:synthetic", raw: '{"p1-b10":"first","p1-b2":"","unknown":{"keep":true}}' }];
});
Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
  writeText: async (value: string) => { (window as unknown as { copied: string }).copied = value; },
} });

function Fixture() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => { fail = false; setOpen(true); }}>打开归档</button>
    <button onClick={() => { fail = true; setOpen(true); }}>打开损坏归档</button>
    {open ? <LegacyArchivesDialog onClose={() => setOpen(false)} /> : null}</>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
