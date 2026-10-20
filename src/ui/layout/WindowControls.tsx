import { Copy, Minus, Square, X } from "lucide-react";
import { useDesktopWindow } from "../../platform/useDesktopWindow";

export function WindowControls() {
  const { desktop, maximized, error, run } = useDesktopWindow();
  if (!desktop) return null;
  return (
    <div className="window-controls" role="group" aria-label="窗口控制" data-tauri-drag-region="false">
      <button type="button" className="window-control" aria-label="最小化" title="最小化" onClick={() => void run("minimize")}>
        <Minus size={15} strokeWidth={1.5} />
      </button>
      <button type="button" className="window-control" aria-label={maximized ? "还原窗口" : "最大化"} title={maximized ? "还原窗口" : "最大化"} onClick={() => void run("toggleMaximize")}>
        {maximized ? <Copy size={13} strokeWidth={1.5} /> : <Square size={13} strokeWidth={1.5} />}
      </button>
      <button type="button" className="window-control window-close" aria-label="关闭窗口" title="关闭窗口" onClick={() => void run("close")}>
        <X size={17} strokeWidth={1.5} />
      </button>
      {error ? <span className="window-control-error" role="alert">{error}</span> : null}
    </div>
  );
}
