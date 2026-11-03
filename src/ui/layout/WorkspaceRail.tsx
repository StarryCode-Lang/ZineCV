import type { ReactNode } from "react";
import { ClipboardList, GitBranch, PencilLine } from "lucide-react";
import { motion, motionTransitions } from "../motion/primitives";

export type WorkspaceView = "editor" | "templates" | "versions";

const workspaceItems = [
  {
    id: "editor",
    label: "简历编辑",
    title: "撰稿",
    subtitle: "WRITE",
    icon: PencilLine,
  },
  {
    id: "templates",
    label: "模板",
    title: "版型",
    subtitle: "LAYOUT",
    icon: ClipboardList,
  },
  {
    id: "versions",
    label: "版本管理",
    title: "存档",
    subtitle: "ARCHIVE",
    icon: GitBranch,
  },
] as const;

// 刊期年份取运行时当前年份。
// 期号按当前月份：ISSUE MM / YYYY，随系统时间自动推进。
const now = new Date();
const ISSUE_MONTH = String(now.getMonth() + 1).padStart(2, "0");
const ISSUE_YEAR = now.getFullYear();

export function WorkspaceRail({
  activeView,
  onSelect,
  documentControls,
}: {
  activeView: WorkspaceView;
  onSelect: (view: WorkspaceView) => void;
  documentControls?: ReactNode;
}) {
  // 期尾水印大数字跟随当前章节：撰稿 01、版型 02、存档 03。
  const watermarkNumeral = `0${
    workspaceItems.findIndex((item) => item.id === activeView) + 1
  }`;

  return (
    <>
      <nav className="rail-compact" aria-label="编辑部工作区">
        {workspaceItems.map((item) => {
          const Icon = item.icon;
          const active = activeView === item.id;
          return (
            <button
              key={item.id}
              className={active ? "active" : ""}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
              onClick={() => onSelect(item.id)}
            >
              <Icon size={15} strokeWidth={1.1} aria-hidden="true" />
              <span>{item.title}</span>
            </button>
          );
        })}
      </nav>
      <aside className="rail">
        <div className="rail-brand">
          <span>ZineCV</span>
          <span className="rail-brand-rule" aria-hidden="true" />
          <span className="rail-series" aria-hidden="true">
            <span>THE</span>
            <span>RESUME</span>
            <span>EDITION</span>
          </span>
          <span className="rail-issue">
            ISSUE {ISSUE_MONTH} / {ISSUE_YEAR}
          </span>
        </div>
        <div
          className="rail-navigation"
          role="navigation"
          aria-label="编辑部工作区"
        >
          {workspaceItems.map((item, itemIndex) => {
            const Icon = item.icon;
            const active = activeView === item.id;
            return (
              <button
                key={item.id}
                className={`rail-item ${active ? "active" : ""}`}
                aria-label={item.label}
                aria-current={active ? "page" : undefined}
                onClick={() => onSelect(item.id)}
              >
                {active ? (
                  <motion.span
                    layoutId="workspace-rail-active"
                    className="rail-active-indicator"
                    aria-hidden="true"
                    transition={motionTransitions.navigation}
                  />
                ) : null}
                <span className="rail-item-index" aria-hidden="true">
                  0{itemIndex + 1}
                </span>
                <Icon size={28} strokeWidth={0.9} aria-hidden="true" />
                <span className="rail-item-copy">
                  <strong>{item.title}</strong>
                  <small>{item.subtitle}</small>
                </span>
              </button>
            );
          })}
        </div>
        {documentControls}
        <div className="rail-lower">
          <span className="rail-story-rule" aria-hidden="true" />
          <span className="rail-tagline" aria-hidden="true">
            <span>YOUR</span>
            <span>STORY</span>
            <span>IN PRINT</span>
          </span>
          <span className="rail-watermark" aria-hidden="true">
            <span className="rail-watermark-numeral">{watermarkNumeral}</span>
          </span>
          <div className="rail-footer">
            <div className="rail-local">
              <span className="rail-local-dot" aria-hidden="true" />
              <span className="rail-local-copy">
                <span className="rail-local-title">LOCAL · NO CLOUD</span>
              </span>
            </div>
            <span className="rail-colophon" aria-hidden="true">
              <span>ZINECV</span>
              <small>PRIVATE EDITION</small>
            </span>
          </div>
        </div>
      </aside>
    </>
  );
}
