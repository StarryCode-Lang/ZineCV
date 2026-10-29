import { createElement } from "react";
import { createRoot } from "react-dom/client";
import DocumentWorkspace from "../../../src/ui/app/DocumentWorkspace";

createRoot(document.getElementById("root")!).render(createElement(DocumentWorkspace));
