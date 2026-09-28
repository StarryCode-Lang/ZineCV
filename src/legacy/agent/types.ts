import type {
  BasicInfo,
  Entry,
  ModuleKey,
  ResumeState,
  SectionKey,
} from "../domain/resume-model";

export type AgentView = "editor" | "templates" | "versions";

export type AgentReference = {
  id: string;
  view?: AgentView;
  kind:
    | "basic-field"
    | "summary"
    | "entry"
    | "module"
    | "template"
    | "version"
    | "draft"
    | "branch"
    | "feature";
  label: string;
  detail: string;
  module?: ModuleKey;
  entry?: Entry;
  basicKey?: keyof BasicInfo;
  templateId?: string;
  versionId?: string;
  featureDescription?: string;
};

export type AgentEditTarget =
  | { kind: "basic"; key: keyof BasicInfo }
  | { kind: "summary" }
  | { kind: "entry"; module: ModuleKey; id: string };

export type AgentEditPatch =
  { value: string } | { html: string } | Partial<Omit<Entry, "id">>;

export type AgentProposal =
  | {
      id: string;
      kind: "resume-edit";
      title: string;
      explanation: string;
      target: AgentEditTarget;
      patch: AgentEditPatch;
      expectedValue: unknown;
      expectedSnapshotSignature: string;
      expectedBranchId: string;
      expectedHeadId: string | null;
      sourceView: AgentView;
      sourceRefs: string[];
    }
  | {
      id: string;
      kind: "resume-delete";
      title: string;
      explanation: string;
      target: { module: ModuleKey; id: string };
      expectedValue: Entry;
      expectedSnapshotSignature: string;
      expectedBranchId: string;
      expectedHeadId: string | null;
      sourceView: AgentView;
      sourceRefs: string[];
    }
  | {
      id: string;
      kind: "apply-template";
      title: string;
      explanation: string;
      templateId: string;
      effects: string[];
      expectedSnapshotSignature: string;
      expectedTemplateSignature: string;
      expectedBranchId: string;
      expectedHeadId: string | null;
      sourceView: AgentView;
      sourceRefs: string[];
    }
  | {
      id: string;
      kind: "save-version";
      title: string;
      explanation: string;
      message: string;
      branchId: string;
      expectedHeadId: string | null;
      expectedSnapshotSignature: string;
      sourceView: AgentView;
      sourceRefs: string[];
    };

export type AgentMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  sourceView?: AgentView;
  sourceRefs?: string[];
};

export type AgentProviderInfo = {
  name: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  capability: "chat" | "structured";
};

export type AgentProviderStatus = {
  configured: boolean;
  provider: AgentProviderInfo | null;
  keyStorage: "memory-only" | "local-account";
  authRequired?: boolean;
  account?: { id: string; email: string } | null;
  sessionToken?: string;
};

export type AgentResumeContext = {
  resume: ResumeState;
  moduleOrder: SectionKey[];
  moduleNames: Record<ModuleKey, string>;
  summaryTitle: string;
};
