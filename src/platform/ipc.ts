// 桌面 IPC 入口：Tauri 环境走原生命令，普通浏览器（dev/test）明确降级。
export type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let cachedInvoke: NativeInvoke | null = null;

export async function nativeInvoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  if (!cachedInvoke) {
    if (!isTauriRuntime()) {
      throw new Error("Native document service is unavailable in the browser preview");
    }
    const core = await import("@tauri-apps/api/core");
    cachedInvoke = core.invoke as NativeInvoke;
  }
  return cachedInvoke(command, args);
}
