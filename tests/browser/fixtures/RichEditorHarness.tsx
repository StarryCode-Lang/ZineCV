import { useEffect, useRef, useState } from "react";
import { ResumeEditor } from "../../../src/ui/editor/ResumeEditor";
import {
  createEmptyEntry,
  emptyResume,
  moduleTitles,
} from "../../../src/ui/domain/resume-model";
import type {
  Entry,
  ModuleKey,
  ResumeState,
  SectionKey,
} from "../../../src/ui/domain/resume-model";
import type { HeaderPanel } from "../../../src/ui/layout/AppHeader";
import "../../../src/ui/styles/index.css";

const modules: ModuleKey[] = [
  "education",
  "skills",
  "work",
  "projects",
  "orgs",
  "research",
  "awards",
  "other",
  "portfolio",
  "custom",
];
const allModulesExpanded = new Set<"basic" | SectionKey>();
const noOp = () => {};
const startingText =
  "<p>粗体 斜体 下划线 删除线 链接目标 文本输入</p><ol start=\"4\"><li><p>列表项</p><ul><li><p>嵌套项</p></li></ul></li></ol>";

function createResumeFixture(): ResumeState {
  const resume: ResumeState = {
    ...emptyResume,
    basic: { ...emptyResume.basic },
    summary: startingText,
  };
  for (const module of modules) {
    resume[module] = [
      {
        ...createEmptyEntry(module, "same-id"),
        title: "同名经历",
        html: "<p>同名经历</p>",
      },
    ];
  }
  resume.work.push({
    ...createEmptyEntry("work", "second-same-name"),
    title: "同名经历",
    html: "<p>同名经历</p>",
  });
  return resume;
}

export default function RichEditorHarness() {
  const [resume, setResume] = useState(createResumeFixture);
  const [resetKey, setResetKey] = useState(0);
  const [changeCount, setChangeCount] = useState(0);
  const [summaryCommitCount, setSummaryCommitCount] = useState(0);
  const lastSummary = useRef(resume.summary);
  const editorScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (lastSummary.current === resume.summary) return;
    lastSummary.current = resume.summary;
    setSummaryCommitCount((count) => count + 1);
  }, [resume.summary]);
  const moduleOrder: SectionKey[] = [...modules, "summary"];
  const openEntries = Object.fromEntries(
    modules.flatMap((module) => resume[module].map((entry) => [entry.id, true])),
  );

  const updateBasic = (key: keyof ResumeState["basic"], value: string) => {
    setResume((current) => ({
      ...current,
      basic: { ...current.basic, [key]: value },
    }));
    setChangeCount((count) => count + 1);
  };
  const updateEntry = (module: ModuleKey, id: string, patch: Partial<Entry>) => {
    setResume((current) => ({
      ...current,
      [module]: current[module].map((entry) =>
        entry.id === id ? { ...entry, ...patch } : entry,
      ),
    }));
    setChangeCount((count) => count + 1);
  };
  const updateAvatar = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      setResume((current) => ({
        ...current,
        basic: { ...current.basic, avatar: reader.result as string },
      }));
      setChangeCount((count) => count + 1);
    };
    reader.readAsDataURL(file);
  };

  return (
    <main className="editor-workspace-pane" data-testid="rich-editor-harness">
      <button
        type="button"
        aria-label="载入外部正文"
        onClick={() => setResume((current) => ({ ...current, summary: "<p>外部正文</p>" }))}
      >
        载入外部正文
      </button>
      <button
        type="button"
        aria-label="切换编辑来源"
        onClick={() => setResetKey((current) => current + 1)}
      >
        切换编辑来源
      </button>
      <output aria-label="正文变更次数">{changeCount}</output>
      <output aria-label="自我评价提交次数">{summaryCommitCount}</output>
      <output aria-label="当前正文">{resume.summary}</output>
      <output aria-label="第一段同名经历">
        {resume.work.find((entry) => entry.id === "same-id")?.html}
      </output>
      <output aria-label="第二段同名经历">
        {resume.work.find((entry) => entry.id === "second-same-name")?.html}
      </output>
      <ResumeEditor
        resume={resume}
        moduleOrder={moduleOrder}
        moduleNames={moduleTitles}
        summaryTitle="自我评价"
        richEditorResetKey={resetKey}
        activeSectionKey="basic"
        collapsedSections={allModulesExpanded}
        expandSection={noOp}
        toggleOpenSection={noOp}
        openEntries={openEntries}
        updateBasic={updateBasic}
        updateAvatar={updateAvatar}
        onSaveDraft={noOp}
        commitModuleOrder={noOp}
        setDraggingModule={noOp}
        setEditSummaryFromHeading={noOp}
        setPanel={noOp as (panel: HeaderPanel) => void}
        setResume={setResume}
        setEditingModule={noOp}
        toggleEntry={noOp}
        updateEntry={updateEntry}
        removeEntry={noOp}
        addEntry={noOp}
        editorScrollRef={editorScrollRef}
        overflowWarning={null}
        onNavigateToEditor={noOp}
      />
    </main>
  );
}
