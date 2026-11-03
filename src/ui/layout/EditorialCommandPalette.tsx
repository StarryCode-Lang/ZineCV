import {
  ArrowDownToLine,
  ArrowRight,
  Boxes,
  Copy,
  FileOutput,
  GitBranch,
  LayoutTemplate,
  ListOrdered,
  PencilLine,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

const commandIcons = {
  write: PencilLine,
  chapter: ListOrdered,
  template: LayoutTemplate,
  versions: GitBranch,
  modules: Boxes,
  layout: SlidersHorizontal,
  smart: Sparkles,
  pdf: FileOutput,
  png: ArrowDownToLine,
  copy: Copy,
} as const;

type EditorialCommandIcon = keyof typeof commandIcons;

export type EditorialCommand = {
  id: string;
  label: string;
  description: string;
  keywords?: string;
  group: "content" | "layout" | "output";
  icon?: EditorialCommandIcon;
  shortcut?: string;
  disabled?: boolean;
  action: () => void;
};

const groupLabels = {
  content: "撰稿与存档",
  layout: "版型与排版",
  output: "校样与输出",
} as const;

export default function EditorialCommandPalette({
  commands,
  onClose,
  initialQuery = "",
  resumeTitle,
  workspaceLabel,
  loadState = "ready",
}: {
  commands: EditorialCommand[];
  onClose: () => void;
  loadState?: "loading" | "ready" | "error";
  initialQuery?: string;
  resumeTitle: string;
  workspaceLabel: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const visibleCommands = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.description} ${command.keywords ?? ""}`
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [commands, query]);
  const activeCommand = visibleCommands[activeIndex];

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previousFocusRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!activeCommand) return;
    document
      .getElementById(`editorial-command-${activeCommand.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeCommand]);

  const runCommand = (command: EditorialCommand | undefined) => {
    if (!command || command.disabled) return;
    onClose();
    command.action();
  };

  return (
    <div
      className="command-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="command-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-dialog-title"
        aria-describedby="command-dialog-context"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            if (visibleCommands.length)
              setActiveIndex(
                event.key === "Home" ? 0 : visibleCommands.length - 1,
              );
            return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!visibleCommands.length) return;
            const direction = event.key === "ArrowDown" ? 1 : -1;
            setActiveIndex(
              (current) =>
                (current + direction + visibleCommands.length) %
                visibleCommands.length,
            );
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            runCommand(activeCommand);
            return;
          }
          if (event.key === "Tab") {
            const focusable = Array.from(
              dialogRef.current?.querySelectorAll<HTMLElement>(
                'input, button:not([disabled]), [tabindex="0"]',
              ) ?? [],
            );
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header className="command-heading">
          <div>
            <span>EDITORIAL CONTROL / 指令台</span>
            <h2 id="command-dialog-title">这一期，接下来做什么？</h2>
            <p id="command-dialog-context">
              {workspaceLabel} · {resumeTitle || "未命名简历"}
            </p>
          </div>
          <button type="button" aria-label="关闭指令面板" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <label className="command-search">
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            role="combobox"
            aria-label="搜索指令"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="editorial-command-list"
            aria-activedescendant={
              activeCommand
                ? `editorial-command-${activeCommand.id}`
                : undefined
            }
            placeholder="搜索章节、版型、版本或导出…"
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>ESC</kbd>
        </label>
        <div
          className="command-list"
          id="editorial-command-list"
          role="listbox"
          aria-label="可用指令"
        >
          {loadState !== "ready" ? (
            <div className="command-empty" role="status">
              <Search size={20} aria-hidden="true" />
              <strong>
                {loadState === "loading" ? "正在整理本期指令…" : "指令未能载入"}
              </strong>
              <span>
                {loadState === "loading"
                  ? "章节与排版动作即将就绪。"
                  : "请关闭面板后重试；简历内容未受影响。"}
              </span>
            </div>
          ) : visibleCommands.length ? (
            visibleCommands.map((command, index) => {
              const Icon = command.icon
                ? commandIcons[command.icon]
                : ArrowRight;
              const active = index === activeIndex;
              const showGroup =
                index === 0 ||
                visibleCommands[index - 1]?.group !== command.group;
              return (
                <Fragment key={command.id}>
                  {showGroup ? (
                    <div className="command-group-label" role="presentation">
                      {groupLabels[command.group]}
                    </div>
                  ) : null}
                  <button
                    id={`editorial-command-${command.id}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`command-item ${active ? "active" : ""}`}
                    disabled={command.disabled}
                    onMouseEnter={() => setActiveIndex(index)}
                    onFocus={() => setActiveIndex(index)}
                    onClick={() => runCommand(command)}
                  >
                    <span className="command-item-icon" aria-hidden="true">
                      <Icon size={17} />
                    </span>
                    <span className="command-item-copy">
                      <strong>{command.label}</strong>
                      <small>{command.description}</small>
                    </span>
                    {command.shortcut ? <kbd>{command.shortcut}</kbd> : null}
                    <ArrowRight
                      className="command-item-arrow"
                      size={15}
                      aria-hidden="true"
                    />
                  </button>
                </Fragment>
              );
            })
          ) : (
            <div className="command-empty" role="status">
              <Search size={20} aria-hidden="true" />
              <strong>没有匹配的指令</strong>
              <span>试试“项目经历”“留白”或“导出”。</span>
            </div>
          )}
        </div>
        <footer className="command-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 选择 <kbd>↵</kbd> 执行
          </span>
          <span>本地执行 · 不发送简历内容</span>
        </footer>
      </div>
    </div>
  );
}
