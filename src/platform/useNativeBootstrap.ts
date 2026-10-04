// 桌面启动引导：从 Rust SQLite 载入权威文档并恢复旧版工作区状态。
// 恢复路径复用 App 的 applyVersionSnapshot，保证与“载入历史版本”完全一致。
import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { DraftSaveState } from "./useNativeResumePersistence";
import type { ResumeVersionSnapshot } from "../ui/domain/version-model";
import { loadWorkspaceState } from "./workspace";
import { isTauriRuntime } from "./ipc";
import { loadWorkspaceSettings, type WorkspaceSettings } from "./settings";
import { loadImportedTemplates, type ImportedTemplate } from "../ui/domain/imported-template";
import { loadTemplateLibrary } from "../ui/domain/template-library";

export function useNativeBootstrap({
  applyVersionSnapshot,
  onWorkspaceSettingsLoaded,
  onTemplatesLoaded,
  setSaveState,
  onReady,
}: {
  applyVersionSnapshot: (snapshot: ResumeVersionSnapshot) => void;
  onWorkspaceSettingsLoaded: (settings: WorkspaceSettings) => void;
  onTemplatesLoaded: (templates: ImportedTemplate[]) => void;
  setSaveState: Dispatch<SetStateAction<DraftSaveState>>;
  onReady: () => void;
}): { ready: boolean; retry: () => void } {
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setReady(false);
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      setSaveState({ status: "failed", label: "请在桌面应用中运行（npm run tauri dev）" });
      return;
    }
    let active = true;
    void (async () => {
      try {
        setSaveState({ status: "saving", label: "正在载入本地工作区与偏好…" });
        const [workspace, templates, , preferences] = await Promise.all([
          loadWorkspaceState(),
          loadImportedTemplates(),
          loadTemplateLibrary(),
          loadWorkspaceSettings(),
        ]);
        if (!active) return;
        onWorkspaceSettingsLoaded(preferences);
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
    // 用户可重试数据库读取/初始化；状态仍由 SQLite 确认后才允许进入编辑器。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  return { ready, retry };
}
