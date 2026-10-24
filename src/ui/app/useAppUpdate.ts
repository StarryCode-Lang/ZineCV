// 应用更新器的动作层钩子：互斥动作与"可关闭、有限频率"的后台检查
// （启动延迟 + 24 小时节流，localStorage 记录，模式沿用 resume-diy-*-v1
// key 族）。状态镜像刻意不在这里：下载进度事件约 120ms 一次，订阅放在
// App 层会让全应用跟着重渲染，因此由 UpdatePanel 打开期间自行订阅
// （useAppUpdateStatus）。
// 安装前收束顺序：导出忙碌检查 → 强制保存（失败阻止安装）→ 取消活跃
// Agent 运行并稍候。收束失败时安装被阻止、用户可重试；安装器启动后
// 以重启后的版本号为准，不把启动安装器本身视为成功。
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  cancelAppUpdateDownload,
  checkAppUpdate,
  downloadAppUpdate,
  formatAppUpdateError,
  installAppUpdate,
  settleAgentBeforeInstall,
  type UpdaterStatus,
} from "../../platform/appUpdate";
import { NativeIpcError } from "../../platform/ipc";
import { flushDraftBeforeVersionAction } from "../../platform/workspace";
import { readStoredString, writeStoredString } from "../utils/resume";

const AUTO_CHECK_KEY = "resume-diy-update-auto-check-v1";
const LAST_CHECK_KEY = "resume-diy-update-last-check-v1";
const BACKGROUND_CHECK_DELAY_MS = 8_000;
const BACKGROUND_CHECK_MIN_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type AppUpdateActionResult = { ok: boolean; error?: string };

export function readAutoBackgroundCheckDefault(): boolean {
  return readStoredString(AUTO_CHECK_KEY, "1") === "1";
}

export function useAppUpdate(options: {
  isExporting: () => boolean;
  prepareWorkspace?: () => void | Promise<void>;
  notify: (message: string) => void;
}) {
  const { isExporting, prepareWorkspace, notify } = options;
  const [autoBackgroundCheck, setAutoBackgroundCheckState] = useState(readAutoBackgroundCheckDefault);
  const [installPending, setInstallPending] = useState(false);
  const installPendingRef = useRef(false);

  const check = useCallback(
    async (options?: { silent?: boolean }): Promise<{ status: UpdaterStatus | null; error?: string }> => {
      const silent = options?.silent ?? false;
      try {
        const next = await checkAppUpdate();
        if (silent && next.phase === "available") {
          notify(`发现新版本 ${next.target.version}，可从顶栏“检查更新”查看。`);
        }
        return { status: next };
      } catch (error) {
        return { status: null, error: silent ? undefined : formatAppUpdateError(error) };
      }
    },
    [notify],
  );

  useEffect(() => {
    if (!autoBackgroundCheck) return;
    const now = Date.now();
    const last = Number(readStoredString(LAST_CHECK_KEY, "0"));
    if (Number.isFinite(last) && now - last < BACKGROUND_CHECK_MIN_INTERVAL_MS) return;
    const timer = window.setTimeout(() => {
      writeStoredString(LAST_CHECK_KEY, String(Date.now()));
      void check({ silent: true });
    }, BACKGROUND_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [autoBackgroundCheck, check]);

  const setAutoBackgroundCheck = useCallback((enabled: boolean) => {
    setAutoBackgroundCheckState(enabled);
    writeStoredString(AUTO_CHECK_KEY, enabled ? "1" : "0");
  }, []);

  const download = useCallback(async (): Promise<AppUpdateActionResult> => {
    try {
      await downloadAppUpdate();
      return { ok: true };
    } catch (error) {
      // 用户主动取消不是失败：状态事件会回到 available。
      if (error instanceof NativeIpcError && error.detail.code === "CANCELLED") {
        return { ok: true };
      }
      return { ok: false, error: formatAppUpdateError(error) };
    }
  }, []);

  const cancelDownload = useCallback(async (): Promise<AppUpdateActionResult> => {
    try {
      await cancelAppUpdateDownload();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatAppUpdateError(error) };
    }
  }, []);

  const install = useCallback(async (): Promise<AppUpdateActionResult> => {
    if (installPendingRef.current) return { ok: false, error: "正在准备安装更新，请稍候。" };
    if (isExporting()) {
      return { ok: false, error: "正在导出文件，请等待导出完成后再安装更新。" };
    }
    installPendingRef.current = true;
    // 在第一个 await 前提交 inert 与状态遮罩，后续输入不能落在最终保存之后。
    flushSync(() => setInstallPending(true));
    try {
      await prepareWorkspace?.();
      await settleAgentBeforeInstall();
      // Agent 已结束，异步编辑已收束，再保存最新编辑器缓冲和草稿。
      await flushDraftBeforeVersionAction();
      await installAppUpdate();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "文档尚未保存成功，已阻止安装。",
      };
    } finally {
      installPendingRef.current = false;
      setInstallPending(false);
    }
  }, [isExporting, prepareWorkspace]);

  return {
    autoBackgroundCheck,
    setAutoBackgroundCheck,
    check,
    download,
    cancelDownload,
    install,
    installPending,
  };
}

export type AppUpdateController = ReturnType<typeof useAppUpdate>;
