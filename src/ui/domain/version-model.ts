import type {
  ModuleKey,
  ResumeState,
  SectionKey,
  ResumeLayout,
} from "./resume-model";
import type { ResumePresentation } from "./template-model";

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

