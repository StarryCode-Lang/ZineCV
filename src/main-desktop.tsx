import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// 桌面主入口：默认挂载 React 工作区（与旧版网页同一组件树）；
// ?sample=interaction 保留 B03 的 Svelte 等价交互样片作为实验对照。
const isInteractionSample =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("sample") === "interaction";

const root = document.getElementById("root");
if (!root) throw new Error("Root element was not found");

if (isInteractionSample) {
  void (async () => {
    const { mount } = await import("svelte");
    const { default: InteractionSample } = await import("./InteractionSample.svelte");
    mount(InteractionSample, { target: root });
  })();
} else {
  void (async () => {
    const [{ default: App }, { AppMotionProvider }] = await Promise.all([
      import("./legacy/app/App"),
      import("./legacy/motion"),
    ]);
    createRoot(root).render(
      <StrictMode>
        <AppMotionProvider>
          <App />
        </AppMotionProvider>
      </StrictMode>,
    );
  })();
}
