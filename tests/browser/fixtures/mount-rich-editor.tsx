import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import RichEditorHarness from "./RichEditorHarness";
import { AppMotionProvider } from "../../../src/ui/motion";

const target = document.querySelector("#root");
if (!target) throw new Error("Browser test root was not found");
createRoot(target).render(
  <StrictMode>
    <AppMotionProvider>
      <RichEditorHarness />
    </AppMotionProvider>
  </StrictMode>,
);
