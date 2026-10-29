import { useState } from "react";
import { createRoot } from "react-dom/client";
import { registerPlatformInvoke } from "../../../src/platform/ipc";
import { nativeClient } from "../../../src/platform/workspace";
import { JobWorkspace, type JobTailoringSelection } from "../../../src/ui/app/workspace/JobWorkspace";
import { defaultSectionOrder, emptyResume, moduleTitles } from "../../../src/ui/domain/resume-model";
import { AgentOverlay } from "../../../src/ui/agent/AgentOverlay";
import type { ResumeVersionSnapshot, ResumeVersionStore } from "../../../src/ui/domain/version-model";
import type { JobMaterial } from "../../../src-tauri/src/domain/bindings/JobMaterial";
import type { DocumentJobLink } from "../../../src-tauri/src/domain/bindings/DocumentJobLink";
import "../../../src/ui/styles/index.css";

const resume = structuredClone(emptyResume);
resume.projects.push({ id: "project-fact", title: "Typed UI", role: "Developer", department: "", city: "", start: "2024.01", end: "2024.12", html: "<p>维护 TypeScript 客户端</p>" });
const fixture = {
  materials: [] as JobMaterial[], links: [] as DocumentJobLink[], revisions: [] as JobMaterial[],
  saveCommands: [] as string[], requests: [] as JobTailoringSelection[], failSaveAck: true,
  modelCalls: 0,
};
Object.assign(window, { jobFixture: fixture });
const receipts = new Map<string, unknown>();
const cursor = { documentId: "job-ui", contextId: "same-context", branchId: "main", headId: null, revision: "0" };
registerPlatformInvoke(async (command, args = {}) => {
  if (command === "document_state") return { cursor, document: { schemaVersion: 2, documentId: "job-ui" }, epoch: 4 };
  if (command === "current_account") return null;
  if (command === "job_material_list") return structuredClone({ materials: fixture.materials, links: fixture.links, revisions: fixture.revisions });
  if (command === "agent_chat") { fixture.modelCalls++; throw new Error("No model should be invoked by preparation"); }
  const request = args.request as Record<string, any>;
  if (command === "job_material_save") {
    fixture.saveCommands.push(request.commandId);
    if (receipts.has(request.commandId)) return structuredClone(receipts.get(request.commandId));
    if (request.documentId !== "job-ui" || request.expectedEpoch !== 4) throw new Error("wrong job target");
    const old = fixture.materials.find(material => material.id === request.jobMaterial?.id);
    if (old) fixture.revisions.push(structuredClone(old));
    const material: JobMaterial = { id: old?.id ?? `job:${request.commandId}`, documentId: "job-ui",
      title: request.title, company: request.company, jobDescription: request.jobDescription, sourceNote: request.sourceNote,
      revision: (old?.revision ?? 0) + 1, createdAt: "2026-10-29", updatedAt: "2026-10-29" };
    fixture.materials = [...fixture.materials.filter(item => item.id !== material.id), material];
    receipts.set(request.commandId, structuredClone(material));
    if (fixture.failSaveAck) { fixture.failSaveAck = false; throw new Error("岗位保存回执丢失"); }
    return structuredClone(material);
  }
  if (command === "job_material_link") {
    if (request.cursor.documentId !== "job-ui" || request.cursor.revision !== "0") throw new Error("wrong link target");
    const link = { id: `link:${request.commandId}`, documentId: "job-ui", jobMaterialId: request.jobMaterialId,
      jobMaterialRevision: request.jobMaterialRevision, branchId: request.branchId, createdAt: "2026-10-29" };
    fixture.links.push(link); return link;
  }
  if (command === "job_material_unlink") { fixture.links = fixture.links.filter(link => link.id !== request.linkId); return; }
  if (command === "job_material_delete") {
    fixture.materials = fixture.materials.filter(material => material.id !== request.jobMaterialId);
    fixture.links = fixture.links.filter(link => link.jobMaterialId !== request.jobMaterialId); return;
  }
  throw new Error(`Unexpected job fixture command: ${command}`);
});

function Harness() {
  const [versions, setVersions] = useState<ResumeVersionStore>({ currentBranchId: "main", branches: [{ id: "main", name: "主简历", headCommitId: null, createdAt: "" }], commits: [] });
  const [request, setRequest] = useState<JobTailoringSelection | null>(null);
  const [mode, setMode] = useState<"bot" | "composer" | "chat">("bot");
  const snapshot: ResumeVersionSnapshot = { resume, moduleOrder: defaultSectionOrder, moduleNames: moduleTitles,
    summaryTitle: "自我评价", resumeTitle: "Synthetic resume", layout: { font: "雅黑", fontSize: "14", lineHeight: "1.5", moduleSpacing: "12", pageMargin: "30", theme: "blue", dateFormat: "2021.01", titleFormat: "双行标题", separator: "使用分隔符号", textAlign: "系统默认" } };
  return <><JobWorkspace resume={resume} versions={versions} disabled={false}
    onCreateBranch={async name => { setVersions(current => ({ ...current, branches: [...current.branches, { id: "job-branch", name, headCommitId: null, createdAt: "" }] })); return true; }}
    onRequestTailoring={selection => { fixture.requests.push(structuredClone(selection)); setRequest(selection); }} />
    <AgentOverlay jobTailoringRequest={request} activeView="editor" resume={resume} moduleOrder={defaultSectionOrder}
      moduleNames={moduleTitles} summaryTitle={snapshot.summaryTitle} resumeTitle={snapshot.resumeTitle}
      activeTemplateId={null} templates={[]} versionStore={versions} workingSnapshot={snapshot} hasUncommittedChanges={false}
      layoutPreferences={{ mode, anchor: null, sizes: { chat: { width: 440, height: 600 }, composer: { width: 440, height: 200 } } }}
      onLayoutPreferenceChange={(key, value) => { if (key === "agentMode") setMode(value as typeof mode); }}
      onApplyEdit={() => { throw new Error("Draft preparation must not edit a fact"); }}
      onUndoEdit={() => false} onDeleteEntry={() => false} onApplyTemplate={async () => false}
      onCommitVersion={async () => false} onNavigateToReference={() => {}} onNativeWorkspaceReload={() => {}} />
  </>;
}

await nativeClient.load();
createRoot(document.getElementById("root")!).render(<Harness />);
