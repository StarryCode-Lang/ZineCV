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
