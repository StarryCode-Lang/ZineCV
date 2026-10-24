import { createEntityId } from "../utils/resume";
import { useCallback, useRef, useState } from "react";

import { type HeaderPanel } from "../layout/AppHeader";

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
  const openEntriesRef = useRef(openEntries);
  openEntriesRef.current = openEntries;
  const [draggingModule, setDraggingModule] = useState<SectionKey | null>(null);
  // 编辑回调必须保持稳定身份（ResumeEditor/EntryEditor 走 React.memo），
  // 因此读取最新简历经 ref 而不是闭包；这也修复了连续两次 addEntry 时
  // setOpenEntries 读到渲染期闭包快照的窗口。
  const resumeRef = useRef(resume);
  resumeRef.current = resume;
  const updateBasic = useCallback(
    (key: keyof BasicInfo, value: string) => {
      setResume((current) => ({
        ...current,
        basic: { ...current.basic, [key]: value },
      }));
    },
    [setResume],
  );

  const updateAvatar = useCallback(
    (file: File) => {
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
    },
    [notify, updateBasic],
  );

  const updateEntry = useCallback(
    (module: ModuleKey, id: string, patch: Partial<Entry>) => {
      setResume((current) => ({
        ...current,
        [module]: current[module].map((entry) =>
          entry.id === id ? { ...entry, ...patch } : entry,
        ),
      }));
    },
    [setResume],
  );

  // 编辑操作统一在这里更新 ResumeState，左右两侧会立即同步。
  const addEntry = useCallback(
    (module: ModuleKey) => {
      const empty = createEmptyEntry(module, createEntityId(module));
      const id = empty.id;
      setResume((current) => ({
        ...current,
        [module]: [...current[module], empty],
      }));
      setOpenEntries(() => {
        const next: Record<string, boolean> = {};
        for (const sibling of resumeRef.current[module]) next[sibling.id] = false;
        next[id] = true;
        return next;
      });
    },
    [setResume],
  );

  const removeEntry = useCallback(
    (module: ModuleKey, id: string) => {
      const entry = resumeRef.current[module].find((item) => item.id === id);
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
    },
    [notify, requestConfirmation, setResume],
  );

  const deleteModule = useCallback(
    (module: ModuleKey) => {
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
    },
    [moduleNames, notify, requestConfirmation, setEditingModule, setModuleOrder],
  );

  const deleteSummary = useCallback(() => {
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
  }, [notify, requestConfirmation, setModuleOrder]);

  // 恢复模块只改变显示顺序，不创建条目；新增经历仍由模块内按钮单独完成。
  const showSection = useCallback(
    (section: SectionKey) => {
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
    },
    [setModuleOrder, setPanel],
  );

  const hideSection = useCallback(
    (section: SectionKey) => {
      if (section === "summary") deleteSummary();
      else deleteModule(section);
    },
    [deleteModule, deleteSummary],
  );

  const moveSection = useCallback(
    (section: SectionKey, direction: -1 | 1) => {
      setModuleOrder((current) => {
        const from = current.indexOf(section);
        const to = from + direction;
        if (from < 0 || to < 0 || to >= current.length) return current;
        const next = [...current];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
      });
    },
    [setModuleOrder],
  );

  const reorderModule = useCallback(
    (target: SectionKey, finalize = true) => {
      setModuleOrder((current) => {
        if (!draggingModule || draggingModule === target) return current;
        const from = current.indexOf(draggingModule);
        const to = current.indexOf(target);
        if (from < 0 || to < 0) return current;
        const next = [...current];
        next.splice(from, 1);
        next.splice(to, 0, draggingModule);
        return next;
      });
      if (finalize) setDraggingModule(null);
    },
    [draggingModule, setDraggingModule, setModuleOrder],
  );

  const commitModuleOrder = useCallback(
    (nextOrder: SectionKey[]) => {
      setModuleOrder(normalizeSectionOrder(nextOrder));
      setDraggingModule(null);
    },
    [setDraggingModule, setModuleOrder],
  );

  const toggleEntry = useCallback(
    (module: ModuleKey, id: string) =>
      setOpenEntries(() => {
        const next: Record<string, boolean> = {};
        for (const sibling of resumeRef.current[module]) next[sibling.id] = false;
        // 当前快照没有的条目（本渲染闭包内刚新增）默认收起；重复点击切换。
        const open = openEntriesRef.current[id] ?? false;
        if (!open) next[id] = true;
        return next;
      }),
    [],
  );

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
