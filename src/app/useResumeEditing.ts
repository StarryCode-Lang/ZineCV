import { createEntityId } from "../utils/resume";
import { useState } from "react";

import { type HeaderPanel } from "../components/layout/AppHeader";

import type {
  BasicInfo,
  ConfirmAction,
  Entry,
  ModuleKey,
  ResumeState,
  SectionKey,
} from "../domain/resume-model";

import type { Dispatch, SetStateAction } from "react";
import { createEmptyEntry } from "../domain/resume-model";
import { normalizeSectionOrder } from "../domain/resume-normalization";
type EditingOptions = {
  resume: ResumeState;
  setResume: Dispatch<SetStateAction<ResumeState>>;
  setModuleOrder: Dispatch<SetStateAction<SectionKey[]>>;
  moduleNames: Record<ModuleKey, string>;
  notify: (message: string) => void;
  requestConfirmation: (action: ConfirmAction) => void;
  setPanel: (panel: HeaderPanel) => void;
  setEditingModule: (module: ModuleKey | null) => void;
};
export function useResumeEditing({
  resume,
  setResume,
  setModuleOrder,
  moduleNames,
  notify,
  requestConfirmation,
  setPanel,
  setEditingModule,
}: EditingOptions) {
  const [openEntries, setOpenEntries] = useState<Record<string, boolean>>({});
  const [draggingModule, setDraggingModule] = useState<SectionKey | null>(null);
  const updateBasic = (key: keyof BasicInfo, value: string) => {
    setResume((current) => ({
      ...current,
      basic: { ...current.basic, [key]: value },
    }));
  };

  const updateAvatar = (file: File) => {
    if (!file.type.startsWith("image/")) {
      notify("请选择图片文件");
      return;
    }
    if (file.size > 3 * 1024 * 1024) {
      notify("照片不能超过 3MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () =>
      updateBasic(
        "avatar",
        typeof reader.result === "string" ? reader.result : "",
      );
    reader.onerror = () => notify("照片读取失败，请重新选择");
    reader.readAsDataURL(file);
  };

  const updateEntry = (
    module: ModuleKey,
    id: string,
    patch: Partial<Entry>,
  ) => {
    setResume((current) => ({
      ...current,
      [module]: current[module].map((entry) =>
        entry.id === id ? { ...entry, ...patch } : entry,
      ),
    }));
  };

  // 编辑操作统一在这里更新 ResumeState，左右两侧会立即同步。
  const addEntry = (module: ModuleKey) => {
    const empty = createEmptyEntry(module, createEntityId(module));
    const id = empty.id;
    setResume((current) => ({
      ...current,
      [module]: [...current[module], empty],
    }));
    setOpenEntries((current) => {
      const next = { ...current };
      for (const sibling of resume[module]) delete next[sibling.id];
      next[id] = true;
      return next;
    });
  };

  const removeEntry = (module: ModuleKey, id: string) => {
    const entry = resume[module].find((item) => item.id === id);
    requestConfirmation({
      title: "删除这段经历？",
      description: `“${entry?.title || "未命名经历"}”将从当前简历中移除。`,
      confirmLabel: "删除经历",
      onConfirm: () => {
        setResume((current) => ({
          ...current,
          [module]: current[module].filter((item) => item.id !== id),
        }));
        notify("经历已删除");
      },
    });
  };

  const deleteModule = (module: ModuleKey) => {
    requestConfirmation({
      title: "删除整个模块？",
      description: `“${moduleNames[module]}”模块将从简历中隐藏，已有内容会保留，之后仍可重新添加。`,
      confirmLabel: "删除模块",
      onConfirm: () => {
        setModuleOrder((current) => current.filter((item) => item !== module));
        setEditingModule(null);
        notify("模块已删除");
      },
    });
  };

  const deleteSummary = () => {
    requestConfirmation({
      title: "删除自我评价？",
      description: "自我评价模块将从简历中隐藏，已填写内容会保留。",
      confirmLabel: "删除模块",
      onConfirm: () => {
        setModuleOrder((current) =>
          current.filter((item) => item !== "summary"),
        );
        notify("自我评价已删除");
      },
    });
  };

  // 恢复模块只改变显示顺序，不创建条目；新增经历仍由模块内按钮单独完成。
  const showSection = (section: SectionKey) => {
    setModuleOrder((current) => {
      if (current.includes(section)) return current;
      if (section === "summary") return [...current, "summary"];
      const summaryIndex = current.indexOf("summary");
      if (summaryIndex < 0) return [...current, section];
      const next = [...current];
      next.splice(summaryIndex, 0, section);
      return next;
    });
    setPanel(null);
  };

  const hideSection = (section: SectionKey) => {
    if (section === "summary") deleteSummary();
    else deleteModule(section);
  };

  const moveSection = (section: SectionKey, direction: -1 | 1) => {
    setModuleOrder((current) => {
      const from = current.indexOf(section);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const reorderModule = (target: SectionKey, finalize = true) => {
    if (!draggingModule || draggingModule === target) return;
    setModuleOrder((current) => {
      const next = [...current];
      const from = next.indexOf(draggingModule);
      const to = next.indexOf(target);
      if (from < 0 || to < 0) return current;
      next.splice(from, 1);
      next.splice(to, 0, draggingModule);
      return next;
    });
    if (finalize) setDraggingModule(null);
  };

  const commitModuleOrder = (nextOrder: SectionKey[]) => {
    setModuleOrder(normalizeSectionOrder(nextOrder));
    setDraggingModule(null);
  };

  const toggleEntry = (module: ModuleKey, id: string) =>
    setOpenEntries((current) => {
      const next = { ...current };
      for (const sibling of resume[module]) delete next[sibling.id];
      if (!current[id]) next[id] = true;
      return next;
    });

  return {
    openEntries,
    setOpenEntries,
    setDraggingModule,
    updateBasic,
    updateAvatar,
    updateEntry,
    addEntry,
    removeEntry,
    showSection,
    hideSection,
    moveSection,
    reorderModule,
    commitModuleOrder,
    toggleEntry,
  };
}
