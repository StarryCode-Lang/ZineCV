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

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  Dispatch,
  PointerEvent as ReactPointerEvent,
  RefObject,
  SetStateAction,
} from "react";

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
  collapsedSections: Set<"basic" | SectionKey>;
  expandSection: (section: "basic" | SectionKey) => void;
  toggleOpenSection: (section: "basic" | SectionKey) => void;
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
  toggleEntry: (module: ModuleKey, id: string) => void;
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
export const ResumeEditor = memo(function ResumeEditor({
  resume,
  moduleOrder,
  moduleNames,
  summaryTitle,
  activeSectionKey,
  collapsedSections,
  expandSection,
  toggleOpenSection,
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
  const openBasic = !collapsedSections.has("basic");
  const summaryOpen = !collapsedSections.has("summary");
  const [revealedBasicFields, setRevealedBasicFields] = useState<
    Set<keyof BasicInfo>
  >(() => new Set());
  const [draggedModule, setDraggedModule] = useState<SectionKey | null>(null);
  const [dragTarget, setDragTarget] = useState<SectionKey | null>(null);
  const [dragPreviewOrder, setDragPreviewOrder] = useState<SectionKey[] | null>(
    null,
  );
  const dragFrame = useRef<number | null>(null);
  const dragGhost = useRef<HTMLElement | null>(null);
  const dragPreviewOrderRef = useRef<SectionKey[] | null>(null);
  const dragSession = useRef<{
    module: SectionKey;
    pointerId: number;
    originX: number;
    originY: number;
    clientX: number;
    clientY: number;
    offsetX: number;
    offsetY: number;
    active: boolean;
    heading: HTMLElement;
  } | null>(null);
  const dragPointerHandlers = useRef({
    move: (_event: PointerEvent) => {},
    up: (_event: PointerEvent) => {},
    cancel: (_event: PointerEvent) => {},
  });
  const dragTargetRef = useRef<SectionKey | null>(null);
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
      dragPreviewOrderRef.current = null;
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

  const activateModuleDrag = (
    heading: HTMLElement,
    module: SectionKey,
    clientX: number,
    clientY: number,
  ) => {
    const card = heading.closest<HTMLElement>(".module-card");
    if (!card) return;
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
    const session = dragSession.current;
    if (!session) return;
    session.offsetX = clientX - rect.left;
    session.offsetY = clientY - rect.top;
    session.active = true;
    setDraggedModule(module);
    setDragTarget(module);
    dragTargetRef.current = module;
    // Continue from the order already visible if a prior drop is still committing.
    const initialOrder = [...displayModuleOrder];
    dragPreviewOrderRef.current = initialOrder;
    setDragPreviewOrder(initialOrder);
    committedPreviewOrder.current = null;
    dropCompleted.current = false;
    setDraggingModule(module);
  };

  const finishModuleDrag = (commit: boolean) => {
    const session = dragSession.current;
    dragSession.current = null;
    if (!session?.active) return;
    if (commit) {
      const next = dragPreviewOrderRef.current;
      if (next && next.some((item, index) => item !== moduleOrder[index])) {
        commitModuleOrder(next);
        committedPreviewOrder.current = next;
        dropCompleted.current = true;
      }
    }
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
    dragTargetRef.current = null;
    if (!dropCompleted.current) {
      dragPreviewOrderRef.current = null;
      setDragPreviewOrder(null);
    }
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
    setDraggingModule(null);
  };

  const processDragFrame = () => {
    dragFrame.current = null;
    const session = dragSession.current;
    if (!session) return;
    const distance = Math.hypot(
      session.clientX - session.originX,
      session.clientY - session.originY,
    );
    if (!session.active) {
      if (distance < 5) return;
      activateModuleDrag(
        session.heading,
        session.module,
        session.clientX,
        session.clientY,
      );
    }
    const ghost = dragGhost.current;
    if (ghost)
      ghost.style.transform = `translate3d(${session.clientX - session.offsetX}px, ${session.clientY - session.offsetY}px, 0)`;
    const root = editorScrollRef.current;
    const hit = document
      .elementFromPoint(session.clientX, session.clientY)
      ?.closest<HTMLElement>("[data-editor-module]");
    if (!root || !hit || !root.contains(hit)) return;
    const target = hit.dataset.editorModule as SectionKey | undefined;
    const order = dragPreviewOrderRef.current;
    if (!target || !order || target === session.module) {
      if (dragTargetRef.current !== session.module) {
        dragTargetRef.current = session.module;
        setDragTarget(session.module);
      }
      return;
    }
    const from = order.indexOf(session.module);
    const to = order.indexOf(target);
    if (from < 0 || to < 0 || from === to) return;
    const rect = hit.getBoundingClientRect();
    const threshold =
      from < to ? rect.top + rect.height * 0.62 : rect.top + rect.height * 0.38;
    const crossed =
      from < to ? session.clientY > threshold : session.clientY < threshold;
    if (!crossed) return;
    const next = [...order];
    next.splice(from, 1);
    next.splice(to, 0, session.module);
    dragPreviewOrderRef.current = next;
    setDragPreviewOrder(next);
    if (dragTargetRef.current !== target) {
      dragTargetRef.current = target;
      setDragTarget(target);
    }
  };

  const scheduleDragFrame = () => {
    if (dragFrame.current !== null) return;
    dragFrame.current = requestAnimationFrame(processDragFrame);
  };

  const beginModulePointer = (
    event: ReactPointerEvent<HTMLElement>,
    module: SectionKey,
  ) => {
    if (event.button !== 0 || (event.target as Element).closest("button"))
      return;
    event.preventDefault();
    const heading = event.currentTarget;
    dragSession.current = {
      module,
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: 0,
      offsetY: 0,
      active: false,
      heading,
    };
    heading.setPointerCapture(event.pointerId);
  };

  const moveModulePointer = (
    event: Pick<PointerEvent, "pointerId" | "clientX" | "clientY">,
  ) => {
    const session = dragSession.current;
    if (!session || session.pointerId !== event.pointerId) return;
    session.clientX = event.clientX;
    session.clientY = event.clientY;
    scheduleDragFrame();
  };

  const endModulePointer = (
    event: Pick<PointerEvent, "pointerId" | "clientX" | "clientY">,
  ) => {
    if (dragSession.current?.pointerId !== event.pointerId) return;
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
    const session = dragSession.current;
    if (session) {
      session.clientX = event.clientX;
      session.clientY = event.clientY;
      processDragFrame();
    }
    finishModuleDrag(true);
  };

  const cancelModulePointer = (event: Pick<PointerEvent, "pointerId">) => {
    if (dragSession.current?.pointerId !== event.pointerId) return;
    finishModuleDrag(false);
  };

  dragPointerHandlers.current = {
    move: moveModulePointer,
    up: endModulePointer,
    cancel: cancelModulePointer,
  };

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) =>
      dragPointerHandlers.current.move(event);
    const handlePointerUp = (event: PointerEvent) =>
      dragPointerHandlers.current.up(event);
    const handlePointerCancel = (event: PointerEvent) =>
      dragPointerHandlers.current.cancel(event);
    window.addEventListener("pointermove", handlePointerMove, {
      passive: true,
    });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, []);

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
              toggleOpenSection("basic");
            }
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggleOpenSection("basic");
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
              onClick={() => toggleOpenSection("basic")}
            >
              <Edit3 size={15} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label={openBasic ? "收起基本信息" : "展开基本信息"}
              title={openBasic ? "收起基本信息" : "展开基本信息"}
              aria-expanded={openBasic}
              onClick={() => toggleOpenSection("basic")}
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
            onOpen={() => toggleOpenSection("basic")}
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
            >
              <div
                className="section-heading"
                data-editor-focus="summary"
                tabIndex={-1}
                onPointerDown={(event) => beginModulePointer(event, "summary")}
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
                    onClick={() => toggleOpenSection("summary")}
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
                    onClick={() => toggleOpenSection("summary")}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggleOpenSection("summary");
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
        const moduleOpen = !collapsedSections.has(module);
        return (
          <section
            className={`module-card section-card ${moduleOpen ? "" : "module-collapsed"} ${draggedModule === module ? "module-dragging" : ""} ${dragTarget === module && draggedModule !== module ? "module-drop-target" : ""}`}
            data-editor-module={module}
            data-editor-section-index={sectionNumber}
            key={module}
          >
            <div
              className="section-heading"
              data-editor-focus="module"
              tabIndex={-1}
              onPointerDown={(event) => beginModulePointer(event, module)}
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
                    toggleOpenSection(module);
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
                    onToggle={() => {
                      expandSection(module);
                      toggleEntry(module, entry.id);
                    }}
                    onChange={(patch) => updateEntry(module, entry.id, patch)}
                    onDelete={() => removeEntry(module, entry.id)}
                    onCommand={handleFormatCommand}
                  />
                ))}
              </div>
              <button
                className="add-entry"
                type="button"
                onClick={() => {
                  expandSection(module);
                  addEntry(module);
                }}
              >
                <Plus size={16} /> 添加一段{moduleNames[module]}
              </button>
            </AnimatedCollapse>
          </section>
        );
      })}
    </div>
  );
});
