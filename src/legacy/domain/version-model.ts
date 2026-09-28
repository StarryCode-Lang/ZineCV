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
  } | null;
};

export type ResumeCommit = {
  id: string;
  branchId: string;
  parentId: string | null;
  message: string;
  createdAt: string;
  snapshot: ResumeVersionSnapshot;
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

export const VERSION_STORAGE_KEY = "resume-diy-version-store-v1";

// 新版本库始终从不可删除的默认分支开始。
export function createEmptyVersionStore(): ResumeVersionStore {
  return {
    currentBranchId: "main",
    branches: [
      {
        id: "main",
        name: "默认版本",
        createdAt: new Date().toISOString(),
        headCommitId: null,
      },
    ],
    commits: [],
  };
}
