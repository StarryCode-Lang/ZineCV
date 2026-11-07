import { useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { FloatingSurface } from "./FloatingSurface";

export type SelectMenuOption = { value: string; label: string };

// 应用风格下拉：替代原生 <select>（系统弹层与整体设计不一致）。
// 键盘：Enter/Space/ArrowDown 打开；列表内 ArrowUp/Down/Home/End 移动、Enter 选中；Esc 由 FloatingSurface 统一关闭。
export function SelectMenu({
  ariaLabel,
  value,
  options,
  disabled = false,
  className = "",
  onChange,
}: {
  ariaLabel: string;
  value: string;
  options: SelectMenuOption[];
  disabled?: boolean;
  className?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options[selectedIndex];

  const commit = (next: string) => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
    if (next !== value) onChange(next);
  };

  const focusOption = (index: number) => {
    const items = listRef.current?.querySelectorAll<HTMLElement>(".select-menu-option");
    if (!items?.length) return;
    items[((index % items.length) + items.length) % items.length]?.focus({ preventScroll: true });
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`select-menu-trigger ${open ? "open" : ""} ${className}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (disabled) return;
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="select-menu-value">{selected?.label ?? ""}</span>
        <ChevronDown size={14} className="select-menu-chevron" aria-hidden="true" />
      </button>
      {open ? (
        <FloatingSurface
          anchor={triggerRef.current}
          matchWidth
          onClose={() => {
            setOpen(false);
            triggerRef.current?.focus({ preventScroll: true });
          }}
        >
          <ul
            className="select-menu-popup"
            role="listbox"
            aria-label={ariaLabel}
            ref={listRef}
            onKeyDown={(event) => {
              const items = Array.from(
                listRef.current?.querySelectorAll<HTMLElement>(".select-menu-option") ?? [],
              );
              const index = items.indexOf(document.activeElement as HTMLElement);
              if (event.key === "ArrowDown") {
                event.preventDefault();
                focusOption(index + 1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                focusOption(index - 1);
              } else if (event.key === "Home") {
                event.preventDefault();
                focusOption(0);
              } else if (event.key === "End") {
                event.preventDefault();
                focusOption(items.length - 1);
              } else if (event.key === "Enter" && index >= 0) {
                event.preventDefault();
                commit(options[index].value);
              } else if (event.key === "Tab") {
                setOpen(false);
              }
            }}
          >
            {options.map((option) => (
              <li key={option.value} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  className={`select-menu-option ${option.value === value ? "is-selected" : ""}`}
                  onClick={() => commit(option.value)}
                >
                  <span className="select-menu-value">{option.label}</span>
                  {option.value === value ? (
                    <Check size={14} className="select-menu-check" aria-hidden="true" />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </FloatingSurface>
      ) : null}
    </>
  );
}
