import { useEffect, useRef } from "react";
import { DocumentSwitcher } from "./DocumentSwitcher";
import type { DocumentTransition } from "../DocumentWorkspace";

// 命令面板入口的简历文档弹窗：切换、空白新建、复制当前与归档管理。
export function DocumentsDialog({ onTransition, onClose }: { onTransition?: DocumentTransition; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, []);
  return <dialog ref={dialog} className="export-review documents-dialog" aria-labelledby="documents-dialog-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}>
    <h2 id="documents-dialog-title">简历文档</h2>
    <p>切换当前简历，空白新建或复制当前内容；归档过的简历可在这里恢复。</p>
    <DocumentSwitcher variant="panel" onTransition={onTransition} onSwitched={onClose} />
    <div className="export-review-actions"><button type="button" onClick={onClose}>关闭</button></div>
  </dialog>;
}
