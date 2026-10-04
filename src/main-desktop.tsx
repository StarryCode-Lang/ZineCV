import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./platform/fonts";

// 桌面主入口：默认挂载 React 工作区（与旧版网页同一组件树）；
// 开发样片：正式 React 富文本回归入口。
const isRichEditorSample =
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("sample") === "rich-editor";

const root = document.getElementById("root");
if (!root) throw new Error("Root element was not found");

if (isRichEditorSample) {
  void (async () => {
    const [{ default: RichEditorHarness }, { AppMotionProvider }] = await Promise.all([
      import("../tests/browser/fixtures/RichEditorHarness"),
      import("./ui/motion"),
    ]);
    createRoot(root).render(
      <StrictMode>
        <AppMotionProvider>
          <RichEditorHarness />
        </AppMotionProvider>
      </StrictMode>,
    );
  })();
} else {
  void (async () => {
    const [{ default: App }, { AppMotionProvider }] = await Promise.all([
      import("./ui/app/App"),
      import("./ui/motion"),
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
