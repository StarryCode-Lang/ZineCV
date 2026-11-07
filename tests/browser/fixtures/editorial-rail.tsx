import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceRail, type WorkspaceView } from "../../../src/ui/layout/WorkspaceRail";
import "../../../src/ui/styles/index.css";

function Fixture() {
  const [view, setView] = useState<WorkspaceView>("editor");
  return <WorkspaceRail activeView={view} onSelect={setView} />;
}

export function mountRail() {
  const root = document.createElement("div");
  document.body.append(root);
  createRoot(root).render(<Fixture />);
}
