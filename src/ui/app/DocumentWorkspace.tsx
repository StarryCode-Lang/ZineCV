import { useCallback, useRef, useState } from "react";
import { settleAgentBeforeInstall } from "../../platform/appUpdate";
import { flushDraftBeforeVersionAction, nativeClient, runDraftAuthorityAction } from "../../platform/workspace";
import App from "./App";
import { ExportReviewHost } from "./ExportReviewHost";

export type DocumentTransition = (action: () => Promise<unknown>) => Promise<void>;

// Reset every document-bound hook together, while keeping the page and native
// bridge alive. Bootstrap hydrates the acknowledged host document on remount.
export default function DocumentWorkspace() {
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const recoveryRef = useRef(false);
  const transitionRef = useRef(false);
  const transition = useCallback<DocumentTransition>(async action => {
    if (transitionRef.current) throw new Error("正在切换简历，请稍候");
    transitionRef.current = true;
    setBusy(true);
    let saved = false;
    const previous = nativeClient.snapshot;
    try {
      await settleAgentBeforeInstall();
      await flushDraftBeforeVersionAction();
      saved = true;
      await runDraftAuthorityAction(async () => { await action(); await nativeClient.reload(); });
      setGeneration(value => value + 1);
    } catch (reason) {
      // A missing acknowledgement cannot tell us whether the host switched.
      // Reconcile while input is still frozen; the old draft was already saved.
      if (saved) {
        try {
          const actual = await nativeClient.reload();
          if (actual.cursor.documentId !== previous?.cursor.documentId || actual.epoch !== previous?.epoch) {
            setGeneration(value => value + 1);
          }
        } catch {
          recoveryRef.current = true;
          setRecoveryError("切换响应未确认，暂时停止编辑。请重试读取宿主文档；切换前的草稿已经保存。");
        }
      }
      throw reason;
    } finally {
      transitionRef.current = false;
      if (!recoveryRef.current) setBusy(false);
    }
  }, []);
  return <ExportReviewHost>
    <div className="document-workspace-root" inert={busy || undefined} aria-busy={busy}>
      <App key={generation} onDocumentTransition={transition} documentTransitionBusy={busy} />
    </div>
    {busy ? <div className="document-transition-status" role={recoveryError ? "alert" : "status"}>
      <div>{recoveryError || "正在保存并切换简历…"}
        {recoveryError ? <button type="button" onClick={() => {
          if (transitionRef.current) return;
          transitionRef.current = true;
          void nativeClient.reload().then(() => {
            recoveryRef.current = false; setRecoveryError(""); setGeneration(value => value + 1); setBusy(false);
          }).catch(reason => {
            setRecoveryError(`读取当前简历仍失败：${reason instanceof Error ? reason.message : String(reason)}。编辑保持暂停，可再次重试。`);
          }).finally(() => { transitionRef.current = false; });
        }}>重试读取当前简历</button> : null}
      </div>
    </div> : null}
  </ExportReviewHost>;
}
