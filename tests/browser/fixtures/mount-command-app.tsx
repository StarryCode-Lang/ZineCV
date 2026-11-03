import { createRoot } from "react-dom/client";
import App from "../../../src/ui/app/App";
import { AppMotionProvider } from "../../../src/ui/motion";
import "../../../src/ui/styles/index.css";

createRoot(document.getElementById("root")!).render(<AppMotionProvider><App /></AppMotionProvider>);
