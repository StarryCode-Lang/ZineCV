import type {
  ModuleKey,
  ResumeState,
  SectionKey,
  ResumeLayout,
} from "./resume-model";
import type { ResumePresentation } from "./template-model";
import type { SourceLayoutEdits } from "../../platform/sourceLayoutEdits";

// 一次版本提交保存的完整工作区，恢复时正文、模块和排版会一起回到当时状态。
export type ResumeVersionSnapshot = {
  schemaVersion?: 2;
  presentation?: ResumePresentation;
  resume: ResumeState;
  moduleOrder: SectionKey[];
  moduleNames: Record<ModuleKey, string>;
  summaryTitle: string;
  resumeTitle: string;
  layout: ResumeLayout;
  importedTemplate?: {
    id: string;
    name: string;
    revisionHash?: string;
  } | null;
  sourceLayoutEdits?: SourceLayoutEdits | null;
  // Present only in exported backups, never in normal editor/agent snapshots.
  legacySourceArchive?: { snapshot?: unknown; rawState?: string; previous?: Array<{ snapshot?: unknown; rawState?: string }> };
};

export type ResumeCommit = {
  id: string;
  branchId: string;
  parentId: string | null;
  message: string;
  createdAt: string;
  snapshot: ResumeVersionSnapshot | null;
};

export type ResumeBranch = {
  id: string;
  name: string;
  createdAt: string;
  headCommitId: string | null;
};

export type ResumeVersionStore = {
  currentBranchId: string;
  branches: ResumeBranch[];
  commits: ResumeCommit[];
};

