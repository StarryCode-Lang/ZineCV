// 桌面版草稿持久化：与旧版 useResumePersistence 相同的输入/防抖/重试语义，
// 但写入走 NativeDocumentClient 的命令队列（SQLite durable ack），不再使用浏览器缓存。
import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import type { DraftSaveState } from "../legacy/domain/draft-save-state";
import type { ResumeVersionSnapshot } from "../legacy/domain/version-model";
import {
  documentFromSnapshot,
  documentsEqual,
  nextDocumentCommand,
} from "./documentBridge";
import {
  nativeClient,
  registerDraftFlush,
  storeAvatarAsset,
} from "./workspace";

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
let lastAvatarDataUrl: string | null = null;

async function runPersist(snapshot: ResumeVersionSnapshot): Promise<void> {
  const previousAvatar = lastAvatarDataUrl;
  let desired = documentFromSnapshot(snapshot, nativeDocumentId());
  desired = await storeAvatarAsset(
    desired,
    snapshot.resume.basic.avatar ?? "",
    previousAvatar,
  );
  lastAvatarDataUrl = snapshot.resume.basic.avatar ?? null;
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
  const pendingSnapshot = useRef<ResumeVersionSnapshot | null>(null);

  const executePersist = useCallback(
    (snapshot: ResumeVersionSnapshot): Promise<DraftSaveResult> => {
      const operation = persistTail.then(async () => {
        setSaveState({ status: "saving", label: savingLabel });
        try {
          await runPersist(snapshot);
          setSaveState({ status: "saved", label: savedLabel });
          return { ok: true, failedKeys: [] };
        } catch (error) {
          console.error("Native draft persist failed", error);
          pendingSnapshot.current = snapshot;
          setSaveState({ status: "failed", label: failedLabel });
          return { ok: false, failedKeys: ["native-document"] };
        }
      });
      persistTail = operation.then(() => {}, () => {});
      return operation;
    },
    [setSaveState],
  );

  const flushDraft = useCallback((): Promise<DraftSaveResult> => {
    if (pendingTimer.current !== null) {
      window.clearTimeout(pendingTimer.current);
      pendingTimer.current = null;
    }
    return executePersist(latestSnapshot.current);
  }, [executePersist]);

  const retryDraft = useCallback((): Promise<DraftSaveResult> => {
    setSaveState({ status: "retrying", label: retryingLabel });
    const target = pendingSnapshot.current ?? latestSnapshot.current;
    return executePersist(target);
  }, [executePersist, setSaveState]);

  useEffect(() => {
    if (!enabled) return;
    registerDraftFlush(flushDraft);
  }, [enabled, flushDraft]);

  useEffect(() => {
    if (!enabled) return;
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

  // 页面隐藏/关闭前的尽力落盘；桌面端真正的 durability 由命令队列保证。
  useEffect(() => {
    if (!enabled) return;
    const flushOnPageHide = () => {
      void flushDraft();
    };
    window.addEventListener("pagehide", flushOnPageHide);
    document.addEventListener("visibilitychange", flushOnPageHide);
    return () => {
      window.removeEventListener("pagehide", flushOnPageHide);
      document.removeEventListener("visibilitychange", flushOnPageHide);
    };
  }, [enabled, flushDraft]);

  return useMemo(() => ({ flushDraft, retryDraft }), [flushDraft, retryDraft]);
}
