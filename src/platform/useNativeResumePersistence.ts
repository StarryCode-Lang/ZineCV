// 桌面版草稿持久化：与旧版 useResumePersistence 相同的输入/防抖/重试语义，
// 但写入走 NativeDocumentClient 的命令队列（SQLite durable ack），不再使用浏览器缓存。
import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import type { ResumeVersionSnapshot } from "../ui/domain/version-model";
import {
  documentFromSnapshot,
  documentsEqual,
  nextDocumentCommand,
} from "./documentBridge";
import {
  nativeClient,
  registerDraftFlush,
  storeAvatarAsset,
  flushDraftBeforeVersionAction,
} from "./workspace";
import { hasDocumentRuntime as isTauriRuntime, isTauriRuntime as isNativeHost, NativeIpcError } from "./ipc";
import { flushAgentSessionWrites } from "../ui/agent/sessions";

export type DraftSaveStatus = "saving" | "retrying" | "saved" | "failed";

export type DraftSaveState = {
  status: DraftSaveStatus;
  label: string;
  conflict?: boolean;
};

const savingLabel = "正在保存草稿…";
const retryingLabel = "正在重试草稿…";
const savedLabel = "草稿已保存";
const failedLabel = "草稿保存失败，可点击重试";

type DraftSaveResult = { ok: boolean; failedKeys: string[] };

type NativePersistenceOptions = {
  workingSnapshot: ResumeVersionSnapshot;
  setSaveState: Dispatch<SetStateAction<DraftSaveState>>;
  enabled: boolean;
};

const COMMAND_LIMIT = 64;

// 单实例内串行执行持久化；同一时刻只有一个 fixpoint 循环在推进命令。
let persistTail: Promise<void> = Promise.resolve();

export function serializePersistAction<T>(action: () => Promise<T>): Promise<T> {
  const operation = persistTail.then(action);
  persistTail = operation.then(() => {}, () => {});
  return operation;
}

async function runPersist(snapshot: ResumeVersionSnapshot): Promise<void> {
  if (nativeClient.saveStatus === "failed") await nativeClient.retryFailed();
  let desired = documentFromSnapshot(snapshot, nativeDocumentId());
  desired = await storeAvatarAsset(
    desired,
    snapshot.resume.basic.avatar ?? "",
  );
  for (let index = 0; index < COMMAND_LIMIT; index += 1) {
    const durable = nativeClient.snapshot;
    if (!durable) throw new Error("Native document is not loaded");
    if (documentsEqual(durable.document, desired)) {
      return;
    }
    const command = nextDocumentCommand(durable.document, desired);
    if (!command) {
      if (!documentsEqual(durable.document, desired)) {
        throw new Error("命令已收敛但文档仍不一致，已停止以免误写");
      }
      return;
    }
    await nativeClient.submit(command);
  }
  const finalState = nativeClient.snapshot;
  if (!finalState || !documentsEqual(finalState.document, desired)) {
    throw new Error("草稿同步未能在限定步骤内收敛");
  }
}

function nativeDocumentId(): string {
  return nativeClient.snapshot?.document.documentId ?? "workspace-default-document";
}

export function useNativeResumePersistence({
  workingSnapshot,
  setSaveState,
  enabled,
}: NativePersistenceOptions) {
  const latestSnapshot = useRef(workingSnapshot);
  latestSnapshot.current = workingSnapshot;
  const pendingTimer = useRef<number | null>(null);
  const dirty = useRef(true);

  const executePersist = useCallback(
    (snapshot: ResumeVersionSnapshot): Promise<DraftSaveResult> => {
      const operation = serializePersistAction(async () => {
        setSaveState({ status: "saving", label: savingLabel });
        try {
          await runPersist(snapshot);
          if (latestSnapshot.current === snapshot) dirty.current = false;
          setSaveState({ status: "saved", label: savedLabel });
          return { ok: true, failedKeys: [] };
        } catch (error) {
          console.error("Native draft persist failed", error);
          const conflict = error instanceof NativeIpcError &&
            error.detail.code === "CONFLICT" && !error.detail.retryable;
          setSaveState({
            status: "failed",
            label: conflict ? "其他窗口已更新草稿；本窗口修改尚未保存" : failedLabel,
            conflict,
          });
          return { ok: false, failedKeys: ["native-document"] };
        }
      });
      return operation;
    },
    [setSaveState],
  );

  const flushDraft = useCallback(async (): Promise<DraftSaveResult> => {
    if (pendingTimer.current !== null) {
      window.clearTimeout(pendingTimer.current);
      pendingTimer.current = null;
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const target = latestSnapshot.current;
      const result = await executePersist(target);
      if (!result.ok) return result;
      if (latestSnapshot.current === target) return result;
    }
    setSaveState({ status: "failed", label: "草稿持续变化，已取消切换，请稍后重试" });
    return { ok: false, failedKeys: ["draft-changed-during-flush"] };
  }, [executePersist, setSaveState]);

  const retryDraft = useCallback((): Promise<DraftSaveResult> => {
    setSaveState({ status: "retrying", label: retryingLabel });
    return executePersist(latestSnapshot.current);
  }, [executePersist, setSaveState]);

  useEffect(() => {
    if (!enabled) return;
    return registerDraftFlush(flushDraft, serializePersistAction);
  }, [enabled, flushDraft]);

  useEffect(() => {
    if (!enabled || !isNativeHost()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let closing = false;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      if (disposed) return;
      const appWindow = getCurrentWindow();
      const stop = await appWindow.onCloseRequested(async (event) => {
        event.preventDefault();
        if (closing) return;
        closing = true;
        try {
          await flushDraftBeforeVersionAction();
          await flushAgentSessionWrites();
          await appWindow.destroy();
        } catch {
          setSaveState({ status: "failed", label: "关闭前保存失败，请重试草稿后再关闭" });
        } finally { closing = false; }
      });
      if (disposed) stop(); else unlisten = stop;
    }).catch(() => {
      if (!disposed) setSaveState({ status: "failed", label: "关闭保存保护未建立，请重新打开应用" });
    });
    return () => { disposed = true; unlisten?.(); };
  }, [enabled, setSaveState]);

  useEffect(() => {
    if (!enabled) return;
    dirty.current = true;
    setSaveState({ status: "saving", label: savingLabel });
    if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current);
    pendingTimer.current = window.setTimeout(() => {
      pendingTimer.current = null;
      void executePersist(workingSnapshot);
    }, 180);
    return () => {
      if (pendingTimer.current !== null) {
        window.clearTimeout(pendingTimer.current);
        pendingTimer.current = null;
      }
    };
    // workingSnapshot 的引用变化代表工作区内容变化；与旧版防抖行为一致。
  }, [workingSnapshot, enabled, executePersist, setSaveState]);

  useEffect(() => {
    if (!enabled || isNativeHost()) return;
    const protectPendingDraft = (event: BeforeUnloadEvent) => {
      if (!dirty.current) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectPendingDraft);
    return () => window.removeEventListener("beforeunload", protectPendingDraft);
  }, [enabled]);

  // 页面隐藏/关闭前的尽力落盘；桌面端真正的 durability 由命令队列保证。
  useEffect(() => {
    if (!enabled) return;
    let pendingFlush: Promise<void> | null = null;
    const flushOnPageHide = (event: Event) => {
      if (event.type === "visibilitychange" && document.visibilityState !== "hidden") return;
      if (pendingFlush) return;
      pendingFlush = flushDraftBeforeVersionAction()
        .catch(() => {
          setSaveState({ status: "failed", label: "页面关闭前保存失败，请点击重试草稿" });
        })
        .finally(() => { pendingFlush = null; });
    };
    window.addEventListener("pagehide", flushOnPageHide);
    document.addEventListener("visibilitychange", flushOnPageHide);
    return () => {
      window.removeEventListener("pagehide", flushOnPageHide);
      document.removeEventListener("visibilitychange", flushOnPageHide);
    };
  }, [enabled, setSaveState]);

  return useMemo(() => ({ flushDraft, retryDraft }), [flushDraft, retryDraft]);
}
