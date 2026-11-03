import { createRoot } from "react-dom/client";
import { AgentMark } from "../../../src/ui/agent/AgentMark";
import "../../../src/ui/styles/agent-overlay.css";

createRoot(document.getElementById("root")!).render(<div className="agent-portal">
  <div className="agent-shell agent-mode-bot" style={{ width: 56, height: 56 }}><AgentMark /></div>
  <div className="agent-shell agent-mode-chat" style={{ width: 27, height: 27, left: 100 }}><AgentMark active /></div>
</div>);
