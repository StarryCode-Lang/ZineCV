import { animate } from "motion/mini";
import {
  Award,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Edit3,
  FileText,
  Plus,
  UserRound,
} from "lucide-react";

import { BasicForm, BasicSummary } from "./BasicInfoEditor";
import { AnimatedCollapse } from "./AnimatedCollapse";
import { EntryEditor } from "./EntryEditor";
import { RichEditor } from "./RichEditor";
import { EditorSectionNav, type EditorSectionKey } from "./EditorSectionNav";
import type { HeaderPanel } from "../layout/AppHeader";
import type { EditorNavigationTarget } from "../../app/useEditorNavigation";
import { motionTransitions } from "../../motion/primitives";

import type {
  BasicInfo,
  Entry,
  ModuleKey,
  ResumeState,
  SectionKey,
} from "../../domain/resume-model";

import { useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, DragEvent, RefObject, SetStateAction } from "react";

const moduleIconClasses: Partial<Record<ModuleKey, string>> = {
  education: "iconcv-title-icon-edus",
  skills: "iconcv-title-icon-custom",
  work: "iconcv-title-icon-works",
  projects: "iconcv-title-icon-project_experience",
  orgs: "iconcv-title-icon-orgs",
};

// 英文副标题只属于编辑器展示层，不写入简历数据或版本快照。
const moduleEnglishTitles: Record<ModuleKey, string> = {
  education: "Education",
  skills: "Skills",
  work: "Work Experience",
  projects: "Projects",
  orgs: "Activities",
  research: "Research",
  awards: "Awards",
  other: "Other Experience",
  portfolio: "Portfolio",
  custom: "Custom Section",
};

function EditorModuleIcon({ module }: { module: ModuleKey }) {
  const iconClass = moduleIconClasses[module];
  if (iconClass)
    return <i className={`iconfont ${iconClass}`} aria-hidden="true" />;
  const Icon = module === "awards" ? Award : FileText;
  return <Icon size={16} aria-hidden="true" />;
}

type ResumeEditorProps = {
  resume: ResumeState;
  moduleOrder: SectionKey[];
  moduleNames: Record<ModuleKey, string>;
  summaryTitle: string;
  activeSectionKey: EditorSectionKey;
  openBasic: boolean;
  setOpenBasic: Dispatch<SetStateAction<boolean>>;
  summaryOpen: boolean;
  setSummaryOpen: Dispatch<SetStateAction<boolean>>;
  openEntries: Record<string, boolean>;
  updateBasic: (key: keyof BasicInfo, value: string) => void;
  updateAvatar: (file: File) => void;
  onSaveDraft: () => void;
  commitModuleOrder: (nextOrder: SectionKey[]) => void;
  setDraggingModule: (module: SectionKey | null) => void;
  setEditSummaryFromHeading: (value: boolean) => void;
  setPanel: (value: HeaderPanel) => void;
  setResume: Dispatch<SetStateAction<ResumeState>>;
  setEditingModule: (module: ModuleKey) => void;
  toggleEntry: (id: string) => void;
  updateEntry: (module: ModuleKey, id: string, patch: Partial<Entry>) => void;
  removeEntry: (module: ModuleKey, id: string) => void;
  addEntry: (module: ModuleKey) => void;
  editorScrollRef: RefObject<HTMLDivElement | null>;
  overflowWarning: string | null;
  onNavigateToEditor: (target: EditorNavigationTarget) => void;
};

function handleFormatCommand(command: string, value?: string) {
  document.execCommand(command, false, value);
}
export function ResumeEditor({
  resume,
  moduleOrder,
  moduleNames,
  summaryTitle,
  activeSectionKey,
  openBasic,
  setOpenBasic,
  summaryOpen,
  setSummaryOpen,
  openEntries,
  updateBasic,
  updateAvatar,
  onSaveDraft,
  commitModuleOrder,
  setDraggingModule,
  setEditSummaryFromHeading,
  setPanel,
  setResume,
  setEditingModule,
  toggleEntry,
  updateEntry,
  removeEntry,
  addEntry,
  editorScrollRef,
  overflowWarning,
  onNavigateToEditor,
}: ResumeEditorProps) {
  const [collapsedModules, setCollapsedModules] = useState<
    Partial<Record<ModuleKey, boolean>>
  >({});
  const [revealedBasicFields, setRevealedBasicFields] = useState<
    Set<keyof BasicInfo>
  >(() => new Set());
  const [draggedModule, setDraggedModule] = useState<SectionKey | null>(null);
  const [dragTarget, setDragTarget] = useState<SectionKey | null>(null);
  const [dragPreviewOrder, setDragPreviewOrder] = useState<SectionKey[] | null>(
    null,
  );
  const dragFrame = useRef<number | null>(null);
  const pendingDropTarget = useRef<SectionKey | null>(null);
  const dragAnchorRects = useRef(new Map<SectionKey, DOMRect>());
  const dragGhost = useRef<HTMLElement | null>(null);
  const dragGhostOffset = useRef({ x: 0, y: 0 });
  const previousModuleRects = useRef(new Map<string, DOMRect>());
  const moduleAnimations = useRef(new Map<string, () => void>());
  const committedPreviewOrder = useRef<SectionKey[] | null>(null);
  const dropCompleted = useRef(false);
  const displayModuleOrder = dragPreviewOrder ?? moduleOrder;
  const hasSummary =
    resume.summary.replace(/<[^>]*>|\s|&nbsp;/g, "").length > 0;

  useLayoutEffect(() => {
    const root = editorScrollRef.current;
    if (!root) return;
    const cards = Array.from(
      root.querySelectorAll<HTMLElement>(":scope > [data-editor-module]"),
    );
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    cards.forEach((card) => {
      const key = card.dataset.editorModule;
      const previous = key ? previousModuleRects.current.get(key) : null;
      const current = card.getBoundingClientRect();
      if (previous && !reducedMotion) {
        const deltaY = previous.top - current.top;
        if (Math.abs(deltaY) > 1) {
          moduleAnimations.current.get(key ?? "")?.();
          const originalTransform = card.style.transform;
          const restore = () => {
            if (originalTransform) card.style.transform = originalTransform;
            else card.style.removeProperty("transform");
            if (key) moduleAnimations.current.delete(key);
          };
          const animation = animate(
            card,
            { transform: [`translateY(${deltaY}px)`, "translateY(0)"] },
            {
              ...motionTransitions.disclosure,
              onComplete: restore,
            },
          );
          if (key)
            moduleAnimations.current.set(key, () => {
              animation.cancel();
              restore();
            });
        }
      }
    });
    previousModuleRects.current = new Map(
      cards.flatMap((card) => {
        const key = card.dataset.editorModule;
        return key ? [[key, card.getBoundingClientRect()] as const] : [];
      }),
    );
  }, [displayModuleOrder, editorScrollRef]);

  useLayoutEffect(() => {
    const committed = committedPreviewOrder.current;
    if (
      committed &&
      committed.length === moduleOrder.length &&
      committed.every((item, index) => item === moduleOrder[index])
    ) {
      committedPreviewOrder.current = null;
      dropCompleted.current = false;
      setDragPreviewOrder(null);
    }
  }, [moduleOrder]);

  useLayoutEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const animations = moduleAnimations.current;
    const cancelMotion = () => {
      if (preference.matches)
        [...animations.values()].forEach((cancel) => cancel());
    };
    preference.addEventListener("change", cancelMotion);
    return () => {
      if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
      [...animations.values()].forEach((cancel) => cancel());
      preference.removeEventListener("change", cancelMotion);
    };
  }, []);

  const beginModuleDrag = (
    event: DragEvent<HTMLElement>,
    module: SectionKey,
  ) => {
    const card = event.currentTarget.closest<HTMLElement>(".module-card");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", module);
    if (card) {
      const rect = card.getBoundingClientRect();
      const wrapper = document.createElement("div");
      const scroll = document.createElement("div");
      const ghost = card.cloneNode(true) as HTMLElement;
      wrapper.className = "editor-workspace-pane module-drag-layer";
      scroll.className = "editor-scroll";
      ghost.classList.remove("module-dragging", "module-drop-target");
      ghost.classList.add("module-drag-ghost");
      ghost.removeAttribute("data-editor-module");
      ghost.removeAttribute("data-editor-section-index");
      ghost
        .querySelectorAll<HTMLElement>("[id], [tabindex], [draggable]")
        .forEach((element) => {
          element.removeAttribute("id");
          element.removeAttribute("tabindex");
          element.removeAttribute("draggable");
        });
      card
        .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          "input, textarea",
        )
        .forEach((input, index) => {
          const copy = ghost.querySelectorAll<
            HTMLInputElement | HTMLTextAreaElement
          >("input, textarea")[index];
          if (copy) copy.value = input.value;
        });
      scroll.appendChild(ghost);
      wrapper.appendChild(scroll);
      wrapper.style.width = `${rect.width}px`;
      wrapper.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`;
      document.body.appendChild(wrapper);
      dragGhost.current = wrapper;
      dragGhostOffset.current = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      animate(wrapper, { opacity: [0.78, 1] }, { duration: 0.16 });
      const transparent = document.createElement("canvas");
      transparent.width = transparent.height = 1;
      event.dataTransfer.setDragImage(transparent, 0, 0);
    }
    const root = editorScrollRef.current;
    dragAnchorRects.current = new Map(
      Array.from(
        root?.querySelectorAll<HTMLElement>("[data-editor-module]") ?? [],
      ).flatMap((element) => {
        const key = element.dataset.editorModule as SectionKey | undefined;
        return key ? [[key, element.getBoundingClientRect()] as const] : [];
      }),
    );
    setDraggedModule(module);
    setDragTarget(module);
    // A second drag may begin before the parent has committed the previous
    // drop. Continue from the order already visible on screen so cards never
    // snap back to the stale parent order for one frame.
    setDragPreviewOrder(displayModuleOrder);
    committedPreviewOrder.current = null;
    dropCompleted.current = false;
    setDraggingModule(module);
  };

  const endModuleDrag = () => {
    const ghost = dragGhost.current;
    dragGhost.current = null;
    if (ghost) {
      animate(
        ghost,
        { opacity: [1, 0] },
        { duration: 0.12, onComplete: () => ghost.remove() },
      );
    }
    setDraggedModule(null);
    setDragTarget(null);
    if (!dropCompleted.current) setDragPreviewOrder(null);
    pendingDropTarget.current = null;
    dragAnchorRects.current.clear();
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
    setDraggingModule(null);
  };

  const previewModuleDrop = (
    event: DragEvent<HTMLElement>,
    module: SectionKey,
  ) => {
    event.preventDefault();
    if (dragGhost.current && event.clientX && event.clientY) {
      dragGhost.current.style.transform = `translate3d(${event.clientX - dragGhostOffset.current.x}px, ${event.clientY - dragGhostOffset.current.y}px, 0)`;
    }
    if (!draggedModule || !dragPreviewOrder) return;
    if (draggedModule === module) {
      pendingDropTarget.current = null;
      return;
    }
    const rect =
      dragAnchorRects.current.get(module) ??
      event.currentTarget.getBoundingClientRect();
    const from = dragPreviewOrder.indexOf(draggedModule);
    const to = dragPreviewOrder.indexOf(module);
    if (from < 0 || to < 0) return;
    const threshold =
      from < to ? rect.top + rect.height * 0.62 : rect.top + rect.height * 0.38;
    const crossed =
      from < to ? event.clientY > threshold : event.clientY < threshold;
    // The pointer may cross and retreat before the scheduled frame runs.
    // Only the latest pointer position may determine a pending swap.
    if (!crossed) {
      pendingDropTarget.current = null;
      return;
    }
    if (pendingDropTarget.current === module) return;
    pendingDropTarget.current = module;
    if (dragFrame.current !== null) return;
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = null;
      const target = pendingDropTarget.current;
      pendingDropTarget.current = null;
      if (!target) return;
      setDragPreviewOrder((current) => {
        if (!current) return current;
        const sourceIndex = current.indexOf(draggedModule);
        const targetIndex = current.indexOf(target);
        if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex)
          return current;
        const next = [...current];
        next.splice(sourceIndex, 1);
        next.splice(targetIndex, 0, draggedModule);
        return next;
      });
      setDragTarget(target);
    });
  };

  const dropModule = (event: DragEvent<HTMLElement>, module: SectionKey) => {
    event.preventDefault();
    if (dragPreviewOrder && draggedModule) {
      let next = dragPreviewOrder;
      // Drop can arrive before the hover frame. Commit that last target now
      // instead of cancelling its frame and silently retaining an older order.
      const target = pendingDropTarget.current ?? module;
      if (
        draggedModule !== target &&
        (pendingDropTarget.current ||
          next.every((item, index) => item === moduleOrder[index]))
      ) {
        const from = next.indexOf(draggedModule);
        const to = next.indexOf(target);
        if (from >= 0 && to >= 0) {
          next = [...next];
          next.splice(from, 1);
          next.splice(to, 0, draggedModule);
        }
      }
      setDragPreviewOrder(next);
      commitModuleOrder(next);
      committedPreviewOrder.current = next;
      dropCompleted.current = true;
    }
    endModuleDrag();
  };

  return (
    <div className="editor-scroll" ref={editorScrollRef}>
      <section
        className="editorial-intro"
        aria-labelledby="editorial-intro-title"
      >
        <div className="editorial-intro-copy">
          <p className="editorial-kicker">RESUME EDITOR</p>
          <h1 id="editorial-intro-title">
            Build Your
            <br />
            Next Chapter.<em aria-hidden="true">/</em>
          </h1>
        </div>
        <div className="editorial-intro-note" aria-hidden="true">
          <span>WRITE</span>
          <span>EDIT</span>
          <span>REFINE</span>
          <span>STAND OUT</span>
        </div>
      </section>
      {overflowWarning ? (
        <div className="editor-overflow-warning" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{overflowWarning}</span>
        </div>
      ) : null}
      <EditorSectionNav
        moduleOrder={moduleOrder}
        moduleNames={moduleNames}
        summaryTitle={summaryTitle}
        activeKey={activeSectionKey}
        onNavigateToEditor={onNavigateToEditor}
      />
      <div
        className={`basic-card module-card ${openBasic ? "expanded" : ""}`}
        data-editor-target="basic"
        data-editor-section-index="1"
      >
        <div
          className="module-heading basic-heading"
          data-editor-focus="basic"
          role="button"
          tabIndex={0}
          aria-expanded={openBasic}
          onClick={(event) => {
            if (!(event.target as Element).closest("button")) {
              setOpenBasic((open) => !open);
            }
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setOpenBasic((open) => !open);
            }
          }}
        >
          <span className="heading-left">
            <span className="editor-section-number" aria-hidden="true">
              01
            </span>
            <span className="module-mark profile">
              <UserRound size={16} />
            </span>
            <strong>基本信息</strong>
            <span className="heading-subtitle">Personal Information</span>
          </span>
          <div className="heading-actions module-actions">
            <button
              className="icon-button"
              type="button"
              aria-label="编辑基本信息"
              title="编辑基本信息"
              onClick={() => setOpenBasic(true)}
            >
              <Edit3 size={15} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label={openBasic ? "收起基本信息" : "展开基本信息"}
              title={openBasic ? "收起基本信息" : "展开基本信息"}
              aria-expanded={openBasic}
              onClick={() => setOpenBasic((open) => !open)}
            >
              {openBasic ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
            </button>
          </div>
        </div>
        <AnimatedCollapse open={openBasic}>
          <BasicForm
            basic={resume.basic}
            updateBasic={updateBasic}
            onAvatarChange={updateAvatar}
            onSave={onSaveDraft}
            revealedFields={revealedBasicFields}
            onRevealField={(key) =>
              setRevealedBasicFields((current) => new Set(current).add(key))
            }
          />
        </AnimatedCollapse>
        {!openBasic ? (
          <BasicSummary
            basic={resume.basic}
            onOpen={() => setOpenBasic(true)}
          />
        ) : null}
      </div>

      {displayModuleOrder.map((module, index) => {
        const sectionNumber = String(index + 2).padStart(2, "0");
        if (module === "summary") {
          return (
            <section
              className={`module-card section-card summary-card ${draggedModule === "summary" ? "module-dragging" : ""} ${dragTarget === "summary" && draggedModule !== "summary" ? "module-drop-target" : ""}`}
              data-editor-module="summary"
              data-editor-section-index={sectionNumber}
              key="summary"
              onDragOver={(event) => previewModuleDrop(event, "summary")}
              onDrop={(event) => dropModule(event, "summary")}
            >
              <div
                className="section-heading"
                data-editor-focus="summary"
                tabIndex={-1}
                draggable
                onDragStart={(event) => beginModuleDrag(event, "summary")}
                onDragEnd={endModuleDrag}
              >
                <div className="heading-left">
                  <span className="editor-section-number" aria-hidden="true">
                    {sectionNumber}
                  </span>
                  <span className="module-mark">
                    <i
                      className="iconfont iconcv-title-icon-personal_summary"
                      aria-hidden="true"
                    />
                  </span>
                  <strong>{summaryTitle || "自我评价"}</strong>
                  <span className="heading-subtitle">Self Evaluation</span>
                </div>
                <div className="heading-actions module-actions">
                  <button
                    className="icon-button"
                    aria-label="编辑自我评价模块名称"
                    title="仅编辑模块名称"
                    onClick={() => {
                      setEditSummaryFromHeading(true);
                      setPanel("manager");
                    }}
                  >
                    <Edit3 size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={summaryOpen ? "收起自我评价" : "展开自我评价"}
                    title={summaryOpen ? "收起自我评价" : "展开自我评价"}
                    aria-expanded={summaryOpen}
                    onClick={() => setSummaryOpen((open) => !open)}
                  >
                    {summaryOpen ? (
                      <ChevronUp size={16} />
                    ) : (
                      <ChevronDown size={16} />
                    )}
                  </button>
                </div>
              </div>
              <div
                className={`summary-entry-shell ${summaryOpen ? "expanded" : ""}`}
              >
                <AnimatedCollapse open={summaryOpen}>
                  <div className="content-only-editor summary-editor">
                    <div className="editor-form-title">
                      <Edit3 size={14} />
                      <span>自我评价内容</span>
                    </div>
                    <RichEditor
                      value={resume.summary}
                      onChange={(html) =>
                        setResume((current) => ({
                          ...current,
                          summary: html,
                        }))
                      }
                      onCommand={handleFormatCommand}
                    />
                  </div>
                </AnimatedCollapse>
                {!summaryOpen ? (
                  <div
                    className="summary-preview"
                    role="button"
                    tabIndex={0}
                    aria-label="展开自我评价"
                    aria-expanded="false"
                    onClick={() => setSummaryOpen(true)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSummaryOpen(true);
                      }
                    }}
                  >
                    <div className="summary-preview-content">
                      {hasSummary
                        ? "已填写自我评价，点击展开编辑"
                        : "点击展开并填写自我评价"}
                    </div>
                    <ChevronDown
                      className="summary-preview-chevron"
                      size={16}
                      aria-hidden="true"
                    />
                  </div>
                ) : null}
              </div>
            </section>
          );
        }
        const entries = resume[module];
        const moduleOpen = !collapsedModules[module];
        return (
          <section
            className={`module-card section-card ${moduleOpen ? "" : "module-collapsed"} ${draggedModule === module ? "module-dragging" : ""} ${dragTarget === module && draggedModule !== module ? "module-drop-target" : ""}`}
            data-editor-module={module}
            data-editor-section-index={sectionNumber}
            key={module}
            onDragOver={(event) => previewModuleDrop(event, module)}
            onDrop={(event) => dropModule(event, module)}
          >
            <div
              className="section-heading"
              data-editor-focus="module"
              tabIndex={-1}
              draggable
              onDragStart={(event) => beginModuleDrag(event, module)}
              onDragEnd={endModuleDrag}
            >
              <div className="heading-left">
                <span className="editor-section-number" aria-hidden="true">
                  {sectionNumber}
                </span>
                <span className="module-mark">
                  <EditorModuleIcon module={module} />
                </span>
                <strong>{moduleNames[module]}</strong>
                <span className="heading-subtitle">
                  {moduleEnglishTitles[module]}
                </span>
              </div>
              <div className="heading-actions module-actions">
                <button
                  className="icon-button"
                  type="button"
                  aria-label="编辑模块名称"
                  title="仅编辑模块名称"
                  onClick={() => {
                    setEditSummaryFromHeading(false);
                    setEditingModule(module);
                    setPanel("manager");
                  }}
                >
                  <Edit3 size={15} />
                </button>
                <button
                  className="icon-button module-collapse-button"
                  type="button"
                  aria-label={
                    moduleOpen
                      ? `收起${moduleNames[module]}`
                      : `展开${moduleNames[module]}`
                  }
                  title={
                    moduleOpen
                      ? `收起${moduleNames[module]}`
                      : `展开${moduleNames[module]}`
                  }
                  aria-expanded={moduleOpen}
                  onClick={(event) => {
                    event.stopPropagation();
                    setCollapsedModules((current) => ({
                      ...current,
                      [module]: current[module] ? false : true,
                    }));
                  }}
                >
                  {moduleOpen ? (
                    <ChevronUp size={16} />
                  ) : (
                    <ChevronDown size={16} />
                  )}
                </button>
              </div>
            </div>
            <AnimatedCollapse open={moduleOpen} className="module-content">
              <div className="entry-list">
                {entries.map((entry) => (
                  <EntryEditor
                    key={entry.id}
                    module={module}
                    moduleLabel={moduleNames[module]}
                    entry={entry}
                    open={Boolean(openEntries[entry.id])}
                    onToggle={() => toggleEntry(entry.id)}
                    onChange={(patch) => updateEntry(module, entry.id, patch)}
                    onDelete={() => removeEntry(module, entry.id)}
                    onCommand={handleFormatCommand}
                  />
                ))}
              </div>
              <button
                className="add-entry"
                type="button"
                onClick={() => addEntry(module)}
              >
                <Plus size={16} /> 添加一段{moduleNames[module]}
              </button>
            </AnimatedCollapse>
          </section>
        );
      })}
    </div>
  );
}
