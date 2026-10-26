import type { Dispatch, SetStateAction } from "react";
import type {
  AgentEditPatch,
  AgentEditTarget,
  AgentReference,
} from "../../agent/types";
import type {
  BasicInfo, ConfirmAction,
  Entry,
  ModuleKey,
  ResumeState, SectionKey
} from "../../domain/resume-model";
import {
  defaultSectionOrder,
  emptyResume,
  moduleTitles
} from "../../domain/resume-model";
import { type HeaderPanel } from "../../layout/AppHeader";
import {
  type WorkspaceView
} from "../../layout/WorkspaceRail";
import {
  type EditorNavigationTarget
} from "../useEditorNavigation";
export function runNavigateToEditor(context: {
  setPanel: (next: HeaderPanel, anchor?: HTMLElement | undefined) => void;
  setEditingModule: Dispatch<SetStateAction<ModuleKey | null>>;
  setEditSummaryFromHeading: Dispatch<SetStateAction<boolean>>;
  setTitleEditing: Dispatch<SetStateAction<boolean>>;
  setWorkspaceView: (next: WorkspaceView) => void;
  expandSection: (section: SectionKey | "basic") => void;
  setActiveEditorSection: Dispatch<SetStateAction<SectionKey | "basic">>;
  setOpenEntries: Dispatch<SetStateAction<Record<string, boolean>>>;
  resume: ResumeState;
  setEditorNavigationTarget: Dispatch<SetStateAction<EditorNavigationTarget | null>>;
}, target: EditorNavigationTarget): void {
  const {
    setPanel, setEditingModule, setEditSummaryFromHeading, setTitleEditing, setWorkspaceView, expandSection,
    setActiveEditorSection, setOpenEntries, resume, setEditorNavigationTarget,
  } = context;

  setPanel(null);
  setEditingModule(null);
  setEditSummaryFromHeading(false);
  setTitleEditing(false);
  setWorkspaceView("editor");
  expandSection(
    target.kind === "basic"
      ? "basic"
      : target.kind === "summary"
        ? "summary"
        : target.module,
  );
  setActiveEditorSection(
    target.kind === "basic"
      ? "basic"
      : target.kind === "summary"
        ? "summary"
        : target.module,
  );
  if (target.kind === "module") {
    setOpenEntries((current) => {
      const next = { ...current };
      for (const entry of resume[target.module]) delete next[entry.id];
      if (
        target.entryId &&
        resume[target.module].some((entry) => entry.id === target.entryId)
      )
        next[target.entryId] = true;
      return next;
    });
  }
  setEditorNavigationTarget(target);

}

export function runApplyAgentEdit(context: {
  resume: ResumeState;
  updateBasic: (key: keyof BasicInfo, value: string) => void;
  navigateToEditor: (target: EditorNavigationTarget) => void;
  setResume: Dispatch<SetStateAction<ResumeState>>;
  updateEntry: (module: ModuleKey, id: string, patch: Partial<Entry>) => void;
}, {
  target,
  patch,
  expectedValue,
}: {
  target: AgentEditTarget;
  patch: AgentEditPatch;
  expectedValue: unknown;
}): boolean {
  const { resume, updateBasic, navigateToEditor, setResume, updateEntry } = context;

  if (target.kind === "basic") {
    if (
      target.key === "avatar" ||
      !("value" in patch) ||
      typeof patch.value !== "string" ||
      resume.basic[target.key] !== expectedValue
    )
      return false;
    updateBasic(target.key, patch.value);
    navigateToEditor({ kind: "basic" });
    return true;
  }
  if (target.kind === "summary") {
    if (
      !("html" in patch) ||
      typeof patch.html !== "string" ||
      resume.summary !== expectedValue
    )
      return false;
    const summary = patch.html;
    setResume((current) => ({ ...current, summary }));
    navigateToEditor({ kind: "summary" });
    return true;
  }
  const currentEntry = resume[target.module].find(
    (entry) => entry.id === target.id,
  );
  const allowedKeys = new Set([
    "title",
    "role",
    "department",
    "city",
    "start",
    "end",
    "html",
    "college",
    "mode",
  ]);
  const patchEntries = Object.entries(patch);
  if (
    !currentEntry ||
    JSON.stringify(currentEntry) !== JSON.stringify(expectedValue) ||
    patchEntries.length === 0 ||
    patchEntries.some(
      ([key, value]) =>
        !allowedKeys.has(key) ||
        typeof value !== "string" ||
        value.length > 5000,
    )
  )
    return false;
  updateEntry(
    target.module,
    target.id,
    Object.fromEntries(patchEntries) as Partial<Entry>,
  );
  navigateToEditor({
    kind: "module",
    module: target.module,
    entryId: target.id,
  });
  return true;

}

export function runUndoAgentEdit(context: {
  resume: ResumeState;
  setResume: Dispatch<SetStateAction<ResumeState>>;
}, {
  target,
  originalValue,
  expectedValue,
}: {
  target: AgentEditTarget;
  originalValue: unknown;
  expectedValue: unknown;
}): boolean {
  const { resume, setResume } = context;

  if (target.kind === "basic") {
    if (resume.basic[target.key] !== expectedValue) return false;
    setResume((current) => ({
      ...current,
      basic: { ...current.basic, [target.key]: originalValue },
    }));
    return true;
  }
  if (target.kind === "summary") {
    if (resume.summary !== expectedValue) return false;
    setResume((current) => ({
      ...current,
      summary: String(originalValue),
    }));
    return true;
  }
  const currentEntry = resume[target.module].find(
    (entry) => entry.id === target.id,
  );
  if (
    !currentEntry ||
    JSON.stringify(currentEntry) !== JSON.stringify(expectedValue)
  )
    return false;
  setResume((current) => ({
    ...current,
    [target.module]: current[target.module].map((entry) =>
      entry.id === target.id ? (originalValue as Entry) : entry,
    ),
  }));
  return true;

}

export function runNavigateToAgentReference(context: {
  setPanel: (next: HeaderPanel, anchor?: HTMLElement | undefined) => void;
  setWorkspaceView: (next: WorkspaceView) => void;
  navigateToEditor: (target: EditorNavigationTarget) => void;
}, reference: AgentReference): void {
  const { setPanel, setWorkspaceView, navigateToEditor } = context;

  setPanel(null);
  if (reference.kind === "feature") {
    setWorkspaceView(reference.view ?? "editor");
  } else if (reference.kind === "basic-field") {
    navigateToEditor({ kind: "basic" });
  } else if (reference.kind === "summary") {
    navigateToEditor({ kind: "summary" });
  } else if (reference.kind === "module" && reference.module) {
    navigateToEditor({ kind: "module", module: reference.module });
  } else if (
    reference.kind === "entry" &&
    reference.module &&
    reference.entry
  ) {
    navigateToEditor({
      kind: "module",
      module: reference.module,
      entryId: reference.entry.id,
    });
  } else if (reference.kind === "template") {
    setWorkspaceView("templates");
  } else if (
    reference.kind === "version" ||
    reference.kind === "draft" ||
    reference.kind === "branch"
  ) {
    setWorkspaceView("versions");
  }

}

export function runResetResume(context: {
  requestConfirmation: (action: ConfirmAction) => void;
  setResume: Dispatch<SetStateAction<ResumeState>>;
  setModuleOrder: Dispatch<SetStateAction<SectionKey[]>>;
  setModuleNames: Dispatch<SetStateAction<Record<ModuleKey, string>>>;
  setOpenEntries: Dispatch<SetStateAction<Record<string, boolean>>>;
  setResumeTitle: Dispatch<SetStateAction<string>>;
  setSummaryTitle: Dispatch<SetStateAction<string>>;
  notify: (message: string) => void;
}): void {
  const {
    requestConfirmation, setResume, setModuleOrder, setModuleNames, setOpenEntries, setResumeTitle,
    setSummaryTitle, notify,
  } = context;

  requestConfirmation({
    title: "清空当前简历？",
    description:
      "所有已填写内容都会被清空，并恢复默认模块结构。此操作无法撤销。",
    confirmLabel: "确认清空",
    onConfirm: () => {
      setResume(emptyResume);
      setModuleOrder(defaultSectionOrder);
      setModuleNames({ ...moduleTitles });
      setOpenEntries({});
      setResumeTitle("resume DIY");
      setSummaryTitle("自我评价");
      notify("简历已清空");
    },
  });

}

export function runSmartSort(context: {
  setResume: Dispatch<SetStateAction<ResumeState>>;
  notify: (message: string) => void;
}): void {
  const { setResume, notify } = context;

  const byDate = (left: Entry, right: Entry) =>
    `${right.end}${right.start}`.localeCompare(`${left.end}${left.start}`);
  setResume((current) => ({
    ...current,
    ...Object.fromEntries(
      (Object.keys(moduleTitles) as ModuleKey[]).map((module) => [
        module,
        [...current[module]].sort(byDate),
      ]),
    ),
  }));
  notify("经历已按结束时间排序");

}
