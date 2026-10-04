const PREVIEW_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src data:",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src data: blob:",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline' data:",
].join("; ");

export type IsolatedImportPreview = {
  frame: HTMLIFrameElement;
  document: Document;
  host: HTMLElement;
  dispose(): void;
};

export function createIsolatedImportPreview(
  signal?: AbortSignal,
): Promise<IsolatedImportPreview> {
  if (signal?.aborted)
    return Promise.reject(new DOMException("导入已取消", "AbortError"));

  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    Object.assign(frame.style, {
      position: "fixed",
      left: "-10000px",
      top: "0",
      width: "794px",
      height: "1123px",
      border: "0",
      pointerEvents: "none",
    });

    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      frame.removeEventListener("load", onLoad);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        frame.remove();
        reject(error);
      }
    };
    const onAbort = () =>
      finish(new DOMException("导入已取消", "AbortError"));
    const onLoad = () => {
      const previewDocument = frame.contentDocument;
      if (!previewDocument?.body) {
        finish(new Error("无法创建隔离的 DOCX 预览区域"));
        return;
      }
      finish();
      resolve({
        frame,
        document: previewDocument,
        host: previewDocument.body,
        dispose: () => frame.remove(),
      });
    };
    const timeout = window.setTimeout(
      () => finish(new Error("隔离的 DOCX 预览初始化超时")),
      5_000,
    );

    frame.addEventListener("load", onLoad, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    frame.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;width:794px;min-height:1123px;background:#fff}</style></head><body></body></html>`;
    document.body.append(frame);
  });
}
