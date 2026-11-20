import { useEffect, useState } from "react";
import { isTauriRuntime } from "./ipc";

// Window.close preserves the existing close-request listener and its draft flush.
export function useDesktopWindow() {
  const desktop = isTauriRuntime();
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      if (disposed) return;
      const appWindow = getCurrentWindow();
      const update = async () => {
        const value = await appWindow.isMaximized();
        if (!disposed) setMaximized(value);
      };
      const stop = await appWindow.onResized(() => {
        void update().catch(() => {
          if (!disposed) setError("无法读取窗口状态，请重试");
        });
      });
      if (disposed) { stop(); return; }
      unlisten = stop;
      await update();
    }).catch(() => {
      if (!disposed) setError("无法读取窗口状态，请重试");
    });
    return () => { disposed = true; unlisten?.(); };
  }, [desktop]);

  const run = async (action: "minimize" | "toggleMaximize" | "close") => {
    if (!desktop) return;
    setError("");
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();
      await appWindow[action]();
      if (action === "toggleMaximize") setMaximized(await appWindow.isMaximized());
    } catch {
      setError("窗口操作失败，请重试");
    }
  };

  return { desktop, maximized, error, run };
}

// 预览全屏同时进入原生窗口全屏：WebView2 的元素全屏只铺满窗口，
// 任务栏/桌面仍可能露在底部（实测全屏预览底部出现黑色横条）。
// 返回 null 表示当前不是 Tauri 宿主或读取失败，调用方保持浏览器行为。
export async function readNativeWindowFullscreen(): Promise<boolean | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return await getCurrentWindow().isFullscreen();
  } catch {
    return null;
  }
}

export async function setNativeWindowFullscreen(value: boolean): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFullscreen(value);
    return true;
  } catch {
    return false;
  }
}
