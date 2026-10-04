// 桌面工作区单例：原生文档客户端、头像资产缓存与保存 flush 登记。
// 持久化钩子与版本钩子都通过这里共享同一份权威 cursor 与文档。
import { NativeDocumentClient, type DocumentState } from "./NativeDocumentClient";
import type { ResumeDocument } from "../../src-tauri/src/domain/bindings/ResumeDocument";
import { nativeInvoke } from "./ipc";
import { snapshotFromDocument } from "./documentBridge";
import type { ResumeVersionSnapshot } from "../ui/domain/version-model";
import { flushEditorBuffers } from "./editorBuffers";

export const nativeClient = new NativeDocumentClient(nativeInvoke);

let avatarCache: { hash: string; dataUrl: string } | null = null;
const avatarReads = new Map<string, Promise<string>>();
let flushDraftImpl: (() => Promise<{ ok: boolean }>) | null = null;

export function registerDraftFlush(impl: () => Promise<{ ok: boolean }>): () => void {
  flushDraftImpl = impl;
  return () => { if (flushDraftImpl === impl) flushDraftImpl = null; };
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
  if (epoch !== nativeClient.currentSessionEpoch ||
      nativeClient.snapshot?.cursor.contextId !== state.cursor.contextId) {
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
): Promise<ResumeDocument> {
  if (!dataUrl) {
    avatarCache = null;
    return { ...document, basic: { ...document.basic, avatarAssetId: null } };
  }
  if (avatarCache?.dataUrl === dataUrl) {
    return { ...document, basic: { ...document.basic, avatarAssetId: avatarCache.hash } };
  }
  const previousHash = nativeClient.snapshot?.document.basic.avatarAssetId ?? null;
  const asset = (await nativeInvoke("store_avatar_asset", {
    cursor: nativeClient.snapshot?.cursor,
    dataUrl,
    previousHash: previousHash ?? null,
  })) as { hash: string; dataUrl: string };
  avatarCache = { hash: asset.hash, dataUrl: asset.dataUrl };
  return { ...document, basic: { ...document.basic, avatarAssetId: asset.hash } };
}
