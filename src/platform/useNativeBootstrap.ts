// 桌面启动引导：从 Rust SQLite 载入权威文档并恢复旧版工作区状态。
// 恢复路径复用 App 的 applyVersionSnapshot，保证与“载入历史版本”完全一致。
import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { DraftSaveState } from "../legacy/domain/draft-save-state";
import type { ResumeVersionSnapshot } from "../legacy/domain/version-model";
import { loadWorkspaceState } from "./workspace";
import { isTauriRuntime } from "./ipc";
import { loadImportedTemplates, type ImportedTemplate } from "../legacy/domain/imported-template";

export function useNativeBootstrap({
  applyVersionSnapshot,
  onTemplatesLoaded,
  setSaveState,
  onReady,
}: {
  applyVersionSnapshot: (snapshot: ResumeVersionSnapshot) => void;
  onTemplatesLoaded: (templates: ImportedTemplate[]) => void;
  setSaveState: Dispatch<SetStateAction<DraftSaveState>>;
  onReady: () => void;
}): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isTauriRuntime()) {
      setSaveState({ status: "failed", label: "请在桌面应用中运行（npm run tauri dev）" });
      return;
    }
    let active = true;
    void (async () => {
      try {
        const [workspace, templates] = await Promise.all([
          loadWorkspaceState(),
          loadImportedTemplates(),
        ]);
        if (!active) return;
        onTemplatesLoaded(templates);
        applyVersionSnapshot(workspace.snapshot);
        setSaveState({ status: "saved", label: "已从本地数据库恢复" });
        setReady(true);
        onReady();
      } catch (error) {
        if (!active) return;
        console.error("Native workspace bootstrap failed", error);
        setSaveState({
          status: "failed",
          label: error instanceof Error ? error.message : "本地文档载入失败，请重启应用",
        });
      }
    })();
    return () => {
      active = false;
    };
    // 仅在首次挂载时执行一次引导。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return ready;
}
