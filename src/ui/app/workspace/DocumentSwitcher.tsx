import { useCallback, useEffect, useRef, useState } from "react";
import { hasDocumentRuntime as isTauriRuntime, nativeInvoke } from "../../../platform/ipc";
import { nativeClient } from "../../../platform/workspace";
import type { DocumentMeta } from "../../../../src-tauri/src/domain/bindings/DocumentMeta";
import type { CreateDocumentRequest } from "../../../../src-tauri/src/domain/bindings/CreateDocumentRequest";
import type { DocumentTransition } from "../DocumentWorkspace";

type DocumentSwitcherProps = { disabled?: boolean; onTransition?: DocumentTransition };

export function DocumentSwitcher({ disabled = false, onTransition }: DocumentSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [documents, setDocuments] = useState<DocumentMeta[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [search, setSearch] = useState("");
  const busyRef = useRef(false);
  const pendingCreate = useRef<CreateDocumentRequest | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async (includeArchived: boolean) => {
    const result = await nativeInvoke("document_list", { includeArchived }) as {
      documents: DocumentMeta[];
      activeDocumentId: string | null;
    };
    setDocuments(result.documents);
    setActiveId(result.activeDocumentId);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void refresh(true).catch(reason => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (!isTauriRuntime()) return null;
  const active = documents?.find(item => item.documentId === activeId) ?? null;

  const run = async (action: () => Promise<void>) => {
    if (disabled || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const switchTo = (documentId: string) => {
    if (documentId === activeId) { setOpen(false); return; }
    void run(async () => {
      if (!onTransition) throw new Error("简历切换通道尚未就绪");
      await onTransition(async () => {
        const snapshot = nativeClient.snapshot;
        if (!snapshot || snapshot.epoch === undefined) throw new Error("文档宿主尚未就绪");
        return nativeClient.switchDocument({
          expectedEpoch: BigInt(snapshot.epoch),
          expectedCurrentId: snapshot.cursor.documentId,
          targetDocumentId: documentId,
        });
      });
    });
  };

  const create = (duplicate: boolean) => {
    void run(async () => {
      if (!onTransition) throw new Error("简历切换通道尚未就绪");
      await onTransition(async () => {
        if (!pendingCreate.current) {
          const snapshot = nativeClient.snapshot;
          if (!snapshot || snapshot.epoch === undefined) throw new Error("文档宿主尚未就绪");
          const payload = duplicate
            ? { kind: "duplicate" as const, sourceDocumentId: snapshot.cursor.documentId, initialTitle: createTitle.trim() || null }
            : { kind: "blank" as const, initialTitle: createTitle.trim() || "未命名简历" };
          pendingCreate.current = {
            commandId: crypto.randomUUID(), payload,
            expectedCurrentId: snapshot.cursor.documentId, expectedEpoch: BigInt(snapshot.epoch),
          };
        }
        const result = await nativeClient.createDocument(pendingCreate.current);
        pendingCreate.current = null;
        return result;
      });
    });
  };

  const changeArchive = (documentId: string, archived: boolean) => {
    void run(async () => {
      await nativeInvoke(archived ? "document_archive" : "document_restore", {
        request: { commandId: crypto.randomUUID(), targetDocumentId: documentId, expectedArchived: !archived },
      });
      await refresh(true);
    });
  };

  return (
    <div className="document-switcher" ref={containerRef}>
      <button
        type="button"
        className="document-switcher-trigger"
        disabled={disabled || busy}
        aria-expanded={open}
        title="简历文档"
        onClick={() => setOpen(value => !value)}
      >
        <span className="document-switcher-icon" aria-hidden>▤</span>
        <span className="document-switcher-title">{active?.title ?? "简历文档"}</span>
      </button>
      {open ? (
        <div className="document-switcher-panel" role="menu" aria-label="简历文档列表">
          {error ? <p className="document-switcher-error" role="alert">{error}</p> : null}
          <input className="document-switcher-search" aria-label="搜索简历" placeholder="搜索简历名称" value={search} onChange={event => setSearch(event.target.value)} />
          <ul className="document-switcher-list">
            {(documents ?? []).filter(item => !item.archived && item.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map(item => (
              <li key={item.documentId}>
                <button
                  type="button"
                  role="menuitem"
                  className={item.documentId === activeId ? "is-active" : ""}
                  disabled={busy || pendingCreate.current !== null || item.documentId === activeId}
                  onClick={() => switchTo(item.documentId)}
                >
                  {item.title}
                  {item.documentId === activeId ? <span className="document-switcher-badge">当前</span> : null}
                </button>
              </li>
            ))}
          </ul>
          {creating ? (
            <form
              className="document-switcher-create"
              onSubmit={event => {
                event.preventDefault();
                create(false);
              }}
            >
              <p>复制仅包含当前内容、排版和资源，不复制历史、助手会话或待审提议。</p>
              <input
                autoFocus
                value={createTitle}
                onChange={event => setCreateTitle(event.target.value)}
                placeholder="新简历标题"
                maxLength={40}
                disabled={busy || pendingCreate.current !== null}
              />
              <button type="submit" disabled={busy || !createTitle.trim()}>{pendingCreate.current ? "重试上次新建" : "空白新建"}</button>
              <button
                type="button"
                disabled={busy || pendingCreate.current !== null || !createTitle.trim() || !activeId}
                onClick={() => create(true)}
              >
                复制当前
              </button>
              <button type="button" disabled={busy} onClick={() => {
                if (!pendingCreate.current) { setCreating(false); return; }
                void run(async () => {
                  if (!onTransition) throw new Error("简历切换通道尚未就绪");
                  await onTransition(() => nativeClient.reload());
                });
              }}>{pendingCreate.current ? "核对当前文档并退出重试" : "取消"}</button>
            </form>
          ) : (
            <div className="document-switcher-actions">
              <button type="button" disabled={busy} onClick={() => { setCreating(true); setCreateTitle(""); }}>
                新建 / 复制
              </button>
            </div>
          )}
          <details className="document-switcher-archive">
            <summary>归档管理</summary>
            <ul>
              {(documents ?? []).filter(item => item.archived).map(item => (
                <li key={item.documentId}>
                  <span>{item.title}</span>
                  <button type="button" disabled={busy} onClick={() => changeArchive(item.documentId, false)}>
                    恢复
                  </button>
                </li>
              ))}
              {(documents ?? []).filter(item => !item.archived && item.documentId !== activeId).map(item => (
                <li key={item.documentId}>
                  <span>{item.title}</span>
                  <button type="button" disabled={busy} onClick={() => changeArchive(item.documentId, true)}>
                    归档
                  </button>
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}
    </div>
  );
}
