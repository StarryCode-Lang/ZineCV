import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ResumeEditor } from "../../../src/ui/editor/ResumeEditor";
import { AppMotionProvider } from "../../../src/ui/motion";
import { createEmptyEntry, emptyResume, moduleTitles } from "../../../src/ui/domain/resume-model";
import type { SectionKey } from "../../../src/ui/domain/resume-model";
import "../../../src/ui/styles/index.css";

function Harness() {
  const [resume, setResume] = useState(() => ({ ...structuredClone(emptyResume), work: Array.from({ length: 12 }, (_, i) => ({ ...createEmptyEntry("work", `entry-${i}`), title: `合成经历${i}`, html: `<p>保留正文${i}</p>` })) }));
  const [order, setOrder] = useState<SectionKey[]>(["work", "education", "summary"]);
  const [collapsed, setCollapsed] = useState(new Set<"basic" | SectionKey>(["basic", "education", "summary"]));
  const scroll = useRef<HTMLDivElement>(null);
  const noOp = () => {};
  return <main className="editor-workspace-pane" style={{ height: 720, width: 640 }}>
    <output data-testid="order-state" style={{ display: "none" }}>{JSON.stringify({ resume, order })}</output>
    <ResumeEditor resume={resume} moduleOrder={order} moduleNames={moduleTitles} summaryTitle="自我评价" richEditorResetKey={0} activeSectionKey="work"
      collapsedSections={collapsed} expandSection={noOp} toggleOpenSection={section => setCollapsed(current => { const next = new Set(current); if (next.has(section)) next.delete(section); else next.add(section); return next; })}
      openEntries={{}} updateBasic={noOp} updateAvatar={noOp} onSaveDraft={noOp} commitModuleOrder={setOrder} setDraggingModule={noOp}
      setEditSummaryFromHeading={noOp} setPanel={noOp} setResume={setResume} setEditingModule={noOp} toggleEntry={noOp}
      updateEntry={noOp} removeEntry={noOp} addEntry={noOp} editorScrollRef={scroll} overflowWarning={null} onNavigateToEditor={noOp} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<AppMotionProvider><Harness /></AppMotionProvider>);
