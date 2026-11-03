import { createRoot } from "react-dom/client";
import { BranchTree } from "../../../src/ui/versioning/BranchTree";
import type { ResumeVersionStore } from "../../../src/ui/domain/version-model";
import "../../../src/ui/styles/index.css";

const store: ResumeVersionStore = {
  currentBranchId: "main:doc",
  branches: [
    { id: "main:doc", name: "主分支", createdAt: "2026-01-01", headCommitId: "head" },
    { id: "fork", name: "求职分支", createdAt: "2026-01-02", headCommitId: "fork-head" },
    { id: "empty", name: "空分支", createdAt: "2026-01-03", headCommitId: null },
  ],
  commits: [
    { id: "head", branchId: "main:doc", parentId: null, message: "主版本", createdAt: "2026-01-01", snapshot: null },
    { id: "fork-head", branchId: "fork", parentId: "head", message: "分支版本", createdAt: "2026-01-02", snapshot: null },
  ],
};

declare global { interface Window { branchActions: string[] } }
window.branchActions = [];
createRoot(document.getElementById("root")!).render(<main className="app-shell"><div className="workspace">
  <div className="editor-scroll version-scroll" style={{ width: 1000, height: 800 }}>
    <BranchTree store={store} importedTemplateNames={{}} dirty={false} disabled={false}
      onLoad={commit => window.branchActions.push(`load:${commit.id}`)}
      onDelete={commit => window.branchActions.push(`delete:${commit.id}`)}
      onDeleteBranch={branch => window.branchActions.push(`branch:${branch.id}`)} />
  </div>
</div></main>);
