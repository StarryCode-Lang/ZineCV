import { useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import {
  ArrowDown,
  ArrowUp,
  Edit3,
  Eye,
  EyeOff,
  GripVertical,
  X,
} from "lucide-react";
import {
  moduleTitles,
  type ModuleKey,
  type SectionKey,
} from "../../domain/resume-model";

function ManagerRow({
  section,
  label,
  editButtonLabel,
  moveUpDisabled,
  moveDownDisabled,
  children,
  onEdit,
  onMoveSection,
  onHideSection,
  onDragStart,
  onMove,
  onDrop,
}: {
  section: SectionKey;
  label: string;
  editButtonLabel: string;
  moveUpDisabled: boolean;
  moveDownDisabled: boolean;
  children: ReactNode;
  onEdit: () => void;
  onMoveSection: (section: SectionKey, direction: -1 | 1) => void;
  onHideSection: (section: SectionKey) => void;
  onDragStart: (section: SectionKey) => void;
  onMove: (section: SectionKey) => void;
  onDrop: (section: SectionKey) => void;
}) {
  return (
    <div
      className="manager-row"
      data-manager-section={section}
      data-manager-state="visible"
      draggable
      onDragStart={() => onDragStart(section)}
      onDragOver={(event) => event.preventDefault()}
      onDragEnter={() => onMove(section)}
      onDrop={() => onDrop(section)}
    >
      <GripVertical size={15} />
      <span>{children}</span>
      <button
        type="button"
        className="icon-button"
        aria-label={editButtonLabel}
        title={editButtonLabel}
        onClick={onEdit}
      >
        <Edit3 size={14} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`将${label}上移`}
        title={`将${label}上移`}
        disabled={moveUpDisabled}
        onClick={() => onMoveSection(section, -1)}
      >
        <ArrowUp size={14} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`将${label}下移`}
        title={`将${label}下移`}
        disabled={moveDownDisabled}
        onClick={() => onMoveSection(section, 1)}
      >
        <ArrowDown size={14} />
      </button>
      <button
        type="button"
        className="icon-button danger"
        aria-label={`隐藏${label}`}
        title={`隐藏${label}`}
        onClick={() => onHideSection(section)}
      >
        <EyeOff size={14} />
      </button>
    </div>
  );
}

// 模块管理浮层：负责模块显示、改名、顺序和增删入口。
export function ModuleManager({
  moduleOrder,
  moduleNames,
  summaryTitle,
  editingModule,
  editSummaryOnOpen,
  setEditingModule,
  setSummaryTitle,
  setModuleNames,
  onShowSection,
  onHideSection,
  onMoveSection,
  onDragStart,
  onMove,
  onDrop,
  onClose,
}: {
  moduleOrder: SectionKey[];
  moduleNames: Record<ModuleKey, string>;
  summaryTitle: string;
  editingModule: ModuleKey | null;
  editSummaryOnOpen: boolean;
  setEditingModule: (module: ModuleKey | null) => void;
  setSummaryTitle: (value: string) => void;
  setModuleNames: Dispatch<SetStateAction<Record<ModuleKey, string>>>;
  onShowSection: (section: SectionKey) => void;
  onHideSection: (section: SectionKey) => void;
  onMoveSection: (section: SectionKey, direction: -1 | 1) => void;
  onDragStart: (module: SectionKey) => void;
  onMove: (module: SectionKey) => void;
  onDrop: (module: SectionKey) => void;
  onClose: () => void;
}) {
  // 模块管理只改变模块顺序和显示状态，不会删除被隐藏模块的数据。
  const [summaryEditing, setSummaryEditing] = useState(editSummaryOnOpen);
  const hiddenSections = (
    [...(Object.keys(moduleTitles) as ModuleKey[]), "summary"] as SectionKey[]
  ).filter((section) => !moduleOrder.includes(section));
  const visibleLabel = (section: SectionKey) =>
    section === "summary" ? summaryTitle || "自我评价" : moduleNames[section];

  return (
    <div
      className="floating-panel manager-panel"
      role="dialog"
      aria-label="模块管理"
    >
      <div className="panel-heading">
        <h3 className="floating-title">模块管理</h3>
        <button
          className="panel-close"
          aria-label="关闭模块管理"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>

      <h4>已显示模块</h4>
      {moduleOrder.length ? (
        moduleOrder.map((section, index) => {
          const label = visibleLabel(section);
          const moveUpDisabled = index === 0;
          const moveDownDisabled = index === moduleOrder.length - 1;
          if (section === "summary") {
            return (
              <ManagerRow
                key="summary"
                section="summary"
                label={label}
                editButtonLabel="编辑自我评价名称"
                moveUpDisabled={moveUpDisabled}
                moveDownDisabled={moveDownDisabled}
                onEdit={() => setSummaryEditing(true)}
                onMoveSection={onMoveSection}
                onHideSection={onHideSection}
                onDragStart={onDragStart}
                onMove={onMove}
                onDrop={onDrop}
              >
                {summaryEditing ? (
                  <input
                    autoFocus
                    value={summaryTitle}
                    aria-label="自我评价模块名称"
                    onChange={(event) => setSummaryTitle(event.target.value)}
                    onBlur={() => setSummaryEditing(false)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") setSummaryEditing(false);
                    }}
                  />
                ) : (
                  label
                )}
              </ManagerRow>
            );
          }
          return (
            <ManagerRow
              key={section}
              section={section}
              label={label}
              editButtonLabel={`编辑${label}`}
              moveUpDisabled={moveUpDisabled}
              moveDownDisabled={moveDownDisabled}
              onEdit={() => setEditingModule(section)}
              onMoveSection={onMoveSection}
              onHideSection={onHideSection}
              onDragStart={onDragStart}
              onMove={onMove}
              onDrop={onDrop}
            >
              {editingModule === section ? (
                <input
                  autoFocus
                  value={moduleNames[section]}
                  aria-label={`${label}模块名称`}
                  onChange={(event) =>
                    setModuleNames((current) => ({
                      ...current,
                      [section]: event.target.value,
                    }))
                  }
                  onBlur={() => setEditingModule(null)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") setEditingModule(null);
                  }}
                />
              ) : (
                label
              )}
            </ManagerRow>
          );
        })
      ) : (
        <p className="manager-empty">暂无显示模块</p>
      )}

      <h4 className="manager-hidden-heading">可恢复模块</h4>
      {hiddenSections.length ? (
        hiddenSections.map((section) => {
          const label = visibleLabel(section);
          return (
            <div
              className="manager-row manager-hidden-row"
              data-manager-section={section}
              data-manager-state="hidden"
              key={section}
            >
              <Eye size={15} />
              <span>{label}</span>
              <button
                type="button"
                className="manager-restore"
                aria-label={`恢复${label}`}
                title={`恢复${label}`}
                onClick={() => onShowSection(section)}
              >
                <Eye size={14} /> 恢复
              </button>
            </div>
          );
        })
      ) : (
        <p className="manager-empty">所有模块均已显示</p>
      )}
    </div>
  );
}
