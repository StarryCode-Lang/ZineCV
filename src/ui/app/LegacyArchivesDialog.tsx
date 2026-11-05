import { useEffect, useRef, useState } from "react";
import type { LegacyEditArchive } from "../../../src-tauri/src/domain/bindings/LegacyEditArchive";
import { isTauriRuntime, nativeInvoke } from "../../platform/ipc";

export function LegacyArchivesDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [archives, setArchives] = useState<LegacyEditArchive[] | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    let cancelled = false;
    void nativeInvoke("list_legacy_edit_archives")
      .then((value) => { if (!cancelled) setArchives(value as LegacyEditArchive[]); })
      .catch((reason: unknown) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; element?.close(); };
  }, []);

  const copy = async (key: string, text: string) => {
    try {
      if (!isTauriRuntime() || !await nativeInvoke("write_clipboard_text", { text })) {
        await navigator.clipboard.writeText(text);
      }
      setCopied(key);
      setError("");
    } catch {
      setError("复制失败，请手动选择并复制内容。");
    }
  };

  return <dialog ref={dialog} className="export-review" aria-labelledby="legacy-archives-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}>
    <h2 id="legacy-archives-title">旧版逐框编辑归档</h2>
    <p>这些归档本身不包含原版式资源，无法从归档重建版式。可复制文字或原始 JSON，原始归档不会被修改。</p>
    {error ? <p role="alert">{error}</p> : null}
    {archives === null && !error ? <p role="status">正在读取归档…</p> : null}
    {archives?.length === 0 ? <p>没有找到旧版逐框编辑归档。</p> : null}
    {archives?.map((archive) => {
      const value: unknown = JSON.parse(archive.raw);
      const entries = value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.entries(value) : [];
      const text = entries.filter((entry): entry is [string, string] => typeof entry[1] === "string");
      return <section key={archive.key}>
        <h3>{archive.key}</h3>
        {text.map(([key, content]) => <div key={key}><strong>{key}</strong><pre>{content || "（空文字）"}</pre></div>)}
        <div className="export-review-actions">
          <button type="button" onClick={() => void copy(archive.key, text.map(([, content]) => content).join("\n"))}>
            {copied === archive.key ? "已复制文字" : "复制文字"}
          </button>
          <button type="button" onClick={() => void copy(`${archive.key}:raw`, archive.raw)}>
            {copied === `${archive.key}:raw` ? "已复制原始 JSON" : "复制原始 JSON"}
          </button>
        </div>
        <details><summary>查看原始 JSON</summary><pre>{archive.raw}</pre></details>
      </section>;
    })}
    <div className="export-review-actions"><button type="button" onClick={onClose}>关闭</button></div>
  </dialog>;
}
