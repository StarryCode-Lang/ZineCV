import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import { AppMotionProvider } from "./motion";

const root = document.getElementById("root");
if (!root) throw new Error("Root element was not found");

// React 应用唯一启动入口；业务代码从 app/App.tsx 开始。
createRoot(root).render(
  <StrictMode>
    <AppMotionProvider>
      <App />
    </AppMotionProvider>
  </StrictMode>,
);
