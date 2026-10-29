// 桌面工作区单例：原生文档客户端、头像资产缓存与保存 flush 登记。
// 持久化钩子与版本钩子都通过这里共享同一份权威 cursor 与文档。
import { NativeDocumentClient, sameCursor, type DocumentState, type DocumentTarget } from "./NativeDocumentClient";
import type { ResumeDocument } from "../../src-tauri/src/domain/bindings/ResumeDocument";
import { nativeInvoke } from "./ipc";
import { snapshotFromDocument } from "./documentBridge";
import type { ResumeVersionSnapshot } from "../ui/domain/version-model";
import { flushEditorBuffers } from "./editorBuffers";

export const nativeClient = new NativeDocumentClient(nativeInvoke);

export function captureDocumentHostTarget() {
  const target = nativeClient.captureTarget();
  const epoch = nativeClient.snapshot?.epoch;
  if (epoch === undefined) throw new Error("文档宿主尚未就绪");
  const hostEpoch = Number(epoch);
  if (!Number.isSafeInteger(hostEpoch) || hostEpoch < 0 || BigInt(hostEpoch) !== BigInt(epoch)) {
    throw new Error("文档会话编号超出安全范围，请重启应用");
  }
  return { ...target, hostEpoch };
}

let avatarCache: { hash: string; dataUrl: string } | null = null;
const avatarReads = new Map<string, Promise<string>>();
let flushDraftImpl: (() => Promise<{ ok: boolean }>) | null = null;
let draftAuthorityImpl: ((action: () => Promise<void>) => Promise<void>) | null = null;

export function registerDraftFlush(
  impl: () => Promise<{ ok: boolean }>,
  authorityAction?: (action: () => Promise<void>) => Promise<void>,
): () => void {
  flushDraftImpl = impl;
  draftAuthorityImpl = authorityAction ?? null;
  return () => {
    if (flushDraftImpl === impl) { flushDraftImpl = null; draftAuthorityImpl = null; }
  };
}

export function runDraftAuthorityAction(action: () => Promise<void>): Promise<void> {
  return draftAuthorityImpl ? draftAuthorityImpl(action) : action();
}

// 版本提交等动作前必须等待草稿命令队列全部 durable 落盘。
export async function flushDraftBeforeVersionAction(): Promise<void> {
  await flushEditorBuffers();
  if (!flushDraftImpl) return;
  const result = await flushDraftImpl();
  if (!result.ok) throw new Error("草稿尚未保存成功，请先重试保存再执行版本操作");
}

async function readAvatarDataUrl(hash: string): Promise<string> {
  if (avatarCache?.hash === hash) return avatarCache.dataUrl;
  const cached = avatarReads.get(hash);
  if (cached) return cached;
  const reading = nativeInvoke("read_avatar_asset", { hash }).then((value) => {
    return (value as { dataUrl: string }).dataUrl;
  });
  avatarReads.set(hash, reading);
  if (avatarReads.size > 16) avatarReads.delete(avatarReads.keys().next().value!);
  try { return await reading; }
  catch (error) { avatarReads.delete(hash); throw error; }
}

export function snapshotFromLoadedDocument(document: ResumeDocument): Promise<ResumeVersionSnapshot> {
  const hash = document.basic.avatarAssetId;
  if (!hash) {
    return Promise.resolve(snapshotFromDocument(document, ""));
  }
  return readAvatarDataUrl(hash).then((dataUrl) => snapshotFromDocument(document, dataUrl));
}

async function hydrateWorkspaceState(
  state: DocumentState,
  staleMessage: string,
): Promise<{ state: DocumentState; snapshot: ResumeVersionSnapshot }> {
  const epoch = nativeClient.currentSessionEpoch;
  const snapshot = await snapshotFromLoadedDocument(state.document);
  const current = nativeClient.snapshot;
  if (epoch !== nativeClient.currentSessionEpoch || !current || !sameCursor(current.cursor, state.cursor)) {
    throw new Error(staleMessage);
  }
  avatarCache = state.document.basic.avatarAssetId
    ? { hash: state.document.basic.avatarAssetId, dataUrl: snapshot.resume.basic.avatar ?? "" }
    : null;
  return { state, snapshot };
}

export async function loadWorkspaceState(): Promise<{ state: DocumentState; snapshot: ResumeVersionSnapshot }> {
  return hydrateWorkspaceState(await nativeClient.load(), "Workspace load response belongs to an inactive editing context");
}

export async function reloadWorkspaceState(): Promise<{ state: DocumentState; snapshot: ResumeVersionSnapshot }> {
  return hydrateWorkspaceState(await nativeClient.reload(), "Workspace reload response belongs to an inactive editing context");
}

// 用户改头像时先把 data URL 存成受 GC 引用保护的资产，再把 assetId 写回文档。
export async function storeAvatarAsset(
  document: ResumeDocument,
  dataUrl: string,
  target: DocumentTarget = nativeClient.captureTarget(),
): Promise<ResumeDocument> {
  nativeClient.assertTarget(target);
  if (document.documentId !== target.cursor.documentId) throw new Error("Avatar document target changed");
  // The legacy converter preserves avatar bytes for migration. Live saves use
  // the verified resource instead; do not re-embed the hydrated data URL in
  // legacy metadata after each edit or restart.
  const legacyExtensions = { ...document.legacyExtensions };
  delete legacyExtensions.legacyAvatar;
  const resourceDocument = { ...document, legacyExtensions };
  if (!dataUrl) {
    avatarCache = null;
    return { ...resourceDocument, basic: { ...document.basic, avatarAssetId: null } };
  }
  if (avatarCache?.dataUrl === dataUrl) {
    return { ...resourceDocument, basic: { ...document.basic, avatarAssetId: avatarCache.hash } };
  }
  const previousHash = nativeClient.snapshot?.document.basic.avatarAssetId ?? null;
  const asset = (await nativeInvoke("store_avatar_asset", {
    cursor: nativeClient.snapshot?.cursor,
    dataUrl,
    previousHash: previousHash ?? null,
  })) as { hash: string; dataUrl: string };
  nativeClient.assertTarget(target);
  avatarCache = { hash: asset.hash, dataUrl: asset.dataUrl };
  return { ...resourceDocument, basic: { ...document.basic, avatarAssetId: asset.hash } };
}
