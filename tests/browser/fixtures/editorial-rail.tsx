import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceRail, type WorkspaceView } from "../../../src/ui/layout/WorkspaceRail";
import "../../../src/ui/styles/index.css";

function Fixture() {
  const [view, setView] = useState<WorkspaceView>("editor");
  return <WorkspaceRail activeView={view} onSelect={setView} documentControls={
    <div className="workspace-rail-documents"><div className="document-switcher"><button className="document-switcher-trigger" aria-label="文档"><span className="document-switcher-title">一份很长的简历名称需要在侧栏内正确截断显示</span></button></div><button>岗位</button></div>
  } />;
}

export function mountRail() {
  const root = document.createElement("div");
  document.body.append(root);
  createRoot(root).render(<Fixture />);
}
