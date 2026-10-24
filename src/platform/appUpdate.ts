// 桌面应用更新器的平台封装：五条业务 IPC（app_update_*）+ 状态事件订阅。
// 浏览器预览明确降级（不可用而非报错）；Tauri 运行时才订阅事件。
// 安装前的"收束守卫"（取消 Agent 运行等跨组件动作）经全局注册表接线，
// 模式与 workspace.ts 的 registerDraftFlush 一致。
import type { UpdaterStatus } from "../../src-tauri/src/domain/bindings/UpdaterStatus";
import { isTauriRuntime, NativeIpcError, nativeInvoke } from "./ipc";

export type { UpdaterStatus };

export const UPDATER_STATE_EVENT = "updater-state-changed";

type Unlisten = () => void;

export async function fetchAppUpdateState(): Promise<UpdaterStatus | null> {
  if (!isTauriRuntime()) return null;
  const status = await nativeInvoke("app_update_state");
  return status as UpdaterStatus;
}

export async function checkAppUpdate(): Promise<UpdaterStatus> {
  return (await nativeInvoke("app_update_check")) as UpdaterStatus;
}

export async function downloadAppUpdate(): Promise<UpdaterStatus> {
  return (await nativeInvoke("app_update_download")) as UpdaterStatus;
}

export async function cancelAppUpdateDownload(): Promise<UpdaterStatus> {
  return (await nativeInvoke("app_update_cancel_download")) as UpdaterStatus;
}

/**
 * 安装并退出。Windows 上 Rust 侧启动 NSIS 安装器后进程立即退出，本调用
 * 大概率没有响应返回——调用方不应等待 resolve，状态推进以事件为准。
 */
export async function installAppUpdate(): Promise<void> {
  await nativeInvoke("app_update_install");
}

export async function subscribeAppUpdateState(
  onState: (status: UpdaterStatus) => void,
): Promise<Unlisten> {
  if (!isTauriRuntime()) return () => {};
  const event = await import("@tauri-apps/api/event");
  const unlisten = await event.listen<UpdaterStatus>(UPDATER_STATE_EVENT, (payload) => {
    onState(payload.payload);
  });
  return unlisten;
}

export function formatAppUpdateError(error: unknown): string {
  if (error instanceof NativeIpcError) return error.message;
  if (error instanceof Error) return error.message;
  return "更新操作失败";
}

type ShutdownGuard = {
  /** 等待真实运行结束和会话 durable ack；失败必须阻止安装。 */
  settle: () => Promise<void>;
};

let agentShutdownGuard: ShutdownGuard | null = null;

/** AgentOverlay 挂载时注册"取消运行"守卫；卸载时注销。 */
export function registerAgentShutdownGuard(guard: ShutdownGuard | null): void {
  agentShutdownGuard = guard;
}

/** 安装前收束活跃 Agent 运行与会话写入，不以定时等待替代完成回执。 */
export async function settleAgentBeforeInstall(): Promise<void> {
  await agentShutdownGuard?.settle();
}
