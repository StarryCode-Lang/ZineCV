import type { ReactNode } from "react";

// 顶部栏通用按钮：统一处理选中态、弹层展开态和悬浮提示。
export function ToolbarButton({
  icon,
  label,
  active,
  expanded,
  endIcon,
  className = "",
  tooltip,
  ariaLabel,
  disabled = false,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  active?: boolean;
  expanded?: boolean;
  endIcon?: ReactNode;
  className?: string;
  tooltip?: string;
  ariaLabel?: string;
  disabled?: boolean;
  onClick: (anchor: HTMLButtonElement) => void;
}) {
  return (
    <button
      className={`toolbar-button ${active ? "active" : ""} ${expanded ? "open" : ""} ${className}`}
      aria-label={ariaLabel ?? label}
      aria-expanded={expanded}
      disabled={disabled}
      title={tooltip}
      onClick={(event) => {
        event.stopPropagation();
        if (disabled) return;
        onClick(event.currentTarget);
      }}
    >
      {icon ? <span className="toolbar-control-icon">{icon}</span> : null}
      <span>{label}</span>
      {endIcon}
    </button>
  );
}
