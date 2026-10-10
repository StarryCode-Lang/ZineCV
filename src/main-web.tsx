import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./platform/fonts";
import { startBrowserRuntime } from "./platform/browser/runtime";

const root = document.getElementById("root");
if (!root) throw new Error("Root element missing");
void (async () => {
  try {
    root.textContent = "正在载入本地工作区…";
    await startBrowserRuntime();
    const [{ default: App }, { AppMotionProvider }] = await Promise.all([import("./ui/app/App"), import("./ui/motion")]);
    createRoot(root).render(<StrictMode><AppMotionProvider><App /></AppMotionProvider></StrictMode>);
    if ("serviceWorker" in navigator && import.meta.env.PROD) await navigator.serviceWorker.register("./sw.js");
  } catch (error) { root.textContent = error instanceof Error ? error.message : String(error); }
})();
