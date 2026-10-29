import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { nativeClient } from "../../platform/workspace";
import type { EditorNavigationTarget } from "./useEditorNavigation";
import type { ExportReview, ExportReviewDecision } from "../services/export-checks";

export type ExportHostController = {
  format: "pdf" | "png" | null;
  begin: (format: "pdf" | "png") => boolean;
  finish: () => void;
  notify: (message: string) => void;
  review: (report: ExportReview, onLocate?: (target: EditorNavigationTarget) => void) => Promise<ExportReviewDecision>;
};
type PendingReview = { report: ExportReview; onLocate?: (target: EditorNavigationTarget) => void; resolve: (decision: ExportReviewDecision) => void };
const ExportContext = createContext<ExportHostController | null>(null);
export const useExportHost = () => useContext(ExportContext);

// This provider survives document remounts: a frozen A export may finish while
// the editor shows B, and updater preparation must still see the active export.
export function ExportReviewHost({ children }: { children: ReactNode }) {
  const [format, setFormat] = useState<"pdf" | "png" | null>(null);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<PendingReview | null>(null);
  const [fileName, setFileName] = useState("");
  const [locationError, setLocationError] = useState("");
  const busyRef = useRef(false);
  const pendingRef = useRef<PendingReview | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const begin = useCallback((next: "pdf" | "png") => {
    if (busyRef.current) return false;
    busyRef.current = true; setFormat(next); setNotice(""); return true;
  }, []);
  const finish = useCallback(() => { busyRef.current = false; setFormat(null); }, []);
  const review = useCallback<ExportHostController["review"]>((report, onLocate) => new Promise(resolve => {
    if (pendingRef.current) throw new Error("另一次导出检查尚未结束");
    const request = { report, onLocate, resolve };
    pendingRef.current = request;
    setFileName(report.fileName ?? ""); setLocationError(""); setPending(request);
  }), []);
  const decide = (proceed: boolean) => {
    const request = pendingRef.current;
    if (!request) return;
    pendingRef.current = null; setPending(null);
    request.resolve({ proceed, ...(fileName.trim() ? { fileName: fileName.trim() } : {}) });
  };
  useEffect(() => {
    if (!pending) return;
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, [pending]);
  useEffect(() => () => { pendingRef.current?.resolve({ proceed: false }); pendingRef.current = null; }, []);
  const controller = useMemo(() => ({ format, begin, finish, notify: setNotice, review }), [format, begin, finish, review]);
  const hasErrors = pending?.report.findings.some(finding => finding.severity === "error") ?? false;
  return <ExportContext.Provider value={controller}>
    {children}
    {notice ? <div className="export-notice" role="status"><span>{notice}</span><button type="button" aria-label="关闭导出提示" onClick={() => setNotice("")}>×</button></div> : null}
    {pending ? <dialog ref={dialog} className="export-review" aria-labelledby="export-review-title"
      onCancel={event => { event.preventDefault(); decide(false); }}
      onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}>
      <h2 id="export-review-title">{pending.report.phase === "content" ? "投递前检查" : "冻结文件检查"}</h2>
      <p>简历：<strong>{pending.report.documentTitle}</strong> · 分支：{pending.report.branchName} · 修订：{pending.report.cursor.revision} · {pending.report.format.toUpperCase()}</p>
      <p>{pending.report.phase === "content" ? "检查只指出可核对的问题，不自动改正文或版面。建议可忽略，错误需要先处理。" : pending.report.format === "pdf" ? "检查本次冻结 PDF 的实际文字、链接和页序；结果不代表所有招聘系统的解析结果。" : "检查本次冻结图片的实际像素、尺寸和页序；PNG 不提供可提取文字。"}</p>
      {pending.report.fileName !== undefined ? <label>导出文件名<input aria-label="导出文件名" value={fileName} onChange={event => setFileName(event.target.value)} maxLength={110} /></label> : null}
      {pending.report.findings.length ? <ul>{pending.report.findings.map(finding => <li key={finding.id} data-severity={finding.severity}>
        <strong>{finding.severity === "error" ? "需处理" : "建议"}</strong> {finding.message}
        {finding.target && pending.onLocate ? <button type="button" onClick={() => {
          if (nativeClient.snapshot?.cursor.documentId !== pending.report.cursor.documentId) {
            setLocationError("当前已切到其他简历，请取消本次导出并返回原目标编辑。"); return;
          }
          const navigate = pending.onLocate!;
          decide(false); navigate(finding.target!);
        }}>定位并返回编辑</button> : null}
      </li>)}</ul> : <p>本轮自动检查未发现上述范围内的问题。</p>}
      {locationError ? <p role="alert">{locationError}</p> : null}
      {pending.report.recentExports?.length ? <details><summary>最近已保存的导出（最多 20 条）</summary>
        <p>以下是写盘并回读验证成功的记录；不能证明文件此后未被移动或修改。</p>
        <ul>{pending.report.recentExports.slice(0, 20).map(receipt => <li key={receipt.id}>
          <strong>{receipt.filename}</strong>
          <p>{receipt.source.documentTitle} · {receipt.source.branchName} · 修订 {receipt.cursor.revision} · {receipt.artifact.format.toUpperCase()}
            {receipt.artifact.page ? ` · 第 ${receipt.artifact.page} 页` : ""} · {receipt.writtenAt}</p>
          <details><summary>来源与文件摘要</summary>
            <p>模板：{receipt.source.templateId} / {receipt.source.templateRevision} · {receipt.artifact.bytes} 字节 · {receipt.dpi} DPI</p>
            <p>冻结时间：{receipt.source.frozenAt} · 原文 {receipt.sourcePageCount} 页{receipt.selectedPages?.length ? ` · 选页 ${receipt.selectedPages.join("、")}` : ""}</p>
            <p className="export-checksum">SHA-256：{receipt.artifact.sha256}</p>
          </details>
        </li>)}</ul>
      </details> : null}
      {pending.report.jobEvidence?.length ? <details><summary>查看岗位要求与正文线索</summary>
        <p>文字重合仅帮助定位，不能证明满足资格；没有线索时保留缺口。</p>
        {pending.report.jobEvidence.map((item, index) => <section key={index}><strong>{item.jobTitle} · 材料修订 {item.revision}</strong><p>{item.requirement}</p><p>{item.facts.length ? item.facts.join("；") : "未找到文字线索"}</p></section>)}
      </details> : null}
      <div className="export-review-actions"><button type="button" onClick={() => decide(false)}>取消导出</button><button type="button" disabled={hasErrors || pending.report.fileName !== undefined && !fileName.trim()} onClick={() => decide(true)}>{hasErrors ? "请先处理错误" : pending.report.findings.length ? "已核对建议，继续导出" : "继续导出"}</button></div>
    </dialog> : null}
  </ExportContext.Provider>;
}
