import { useState } from "react";
import { createRoot } from "react-dom/client";
import { EditorSectionNav } from "../../../src/ui/editor/EditorSectionNav";
import { emptyResume, moduleTitles } from "../../../src/ui/domain/resume-model";
import "../../../src/ui/styles/index.css";

function Fixture() {
  const [target, setTarget] = useState("none");
  return <main className="app-shell"><div className="editor-scroll">
    <EditorSectionNav resume={emptyResume} moduleOrder={["work", "summary"]} moduleNames={moduleTitles}
      summaryTitle="自我评价" activeKey="basic" onNavigateToEditor={value => setTarget(JSON.stringify(value))} />
    <output aria-label="定位目标">{target}</output>
  </div></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
