import { CircleDot, ClipboardList, GitBranch, PencilLine } from "lucide-react";
import { motion, motionTransitions } from "../../motion/primitives";

export type WorkspaceView = "editor" | "templates" | "versions" | "assistant";

const workspaceItems = [
  {
    id: "editor",
    label: "简历编辑",
    title: "编辑模板",
    subtitle: "Create",
    icon: PencilLine,
  },
  {
    id: "templates",
    label: "模板",
    title: "模板库",
    subtitle: "Templates",
    icon: ClipboardList,
  },
  {
    id: "versions",
    label: "版本管理",
    title: "版本管理",
    subtitle: "Versions",
    icon: GitBranch,
  },
  {
    id: "assistant",
    label: "AI 助手",
    title: "AI 助手",
    subtitle: "AI Assistant",
    icon: CircleDot,
  },
] as const;

export function WorkspaceRail({
  activeView,
  onSelect,
}: {
  activeView: WorkspaceView;
  onSelect: (view: WorkspaceView) => void;
}) {
  return (
    <aside className="rail">
      <div className="rail-brand">
        <span>Re:me</span>
        <p>
          Better
          <br />
          Resumes
          <br />
          Brighter
          <br />
          Futures.
        </p>
      </div>
      <div className="rail-navigation">
        <motion.span
          className="rail-active-indicator"
          aria-hidden="true"
          animate={{
            y: workspaceItems.findIndex((item) => item.id === activeView) * 67,
          }}
          transition={motionTransitions.navigation}
        />
        {workspaceItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={`rail-item ${activeView === item.id ? "active" : ""}`}
              aria-label={item.label}
              onClick={() => onSelect(item.id)}
            >
              <Icon size={22} />
              <span className="rail-item-copy">
                <strong>{item.title}</strong>
                <small>{item.subtitle}</small>
              </span>
            </button>
          );
        })}
      </div>
      <div className="rail-footer">
        <p>
          好简历，
          <br />
          让更好的你
          <br />
          被看见。
        </p>
        <p>
          A Brighter
          <br />
          You.
        </p>
        <span />
      </div>
    </aside>
  );
}
