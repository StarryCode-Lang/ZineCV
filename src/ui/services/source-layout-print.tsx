import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ImportedSourceLayout } from "../domain/imported-layout";
import { ImportedLayoutPaper } from "../preview/ImportedLayoutPaper";

const PAPER_SCALE = Math.min((210 * 96 / 25.4) / 794, (297 * 96 / 25.4) / 1123);
const PRINT_CSS = `
@media screen { [data-source-layout-print-root] { position: fixed; left: -10000px; top: 0; } }
@media print {
  @page { size: A4; margin: 0; }
  html, body { margin: 0 !important; padding: 0 !important; }
  body > :not([data-source-layout-print-root]) { display: none !important; }
  [data-source-layout-print-root] { position: static !important; width: 210mm; }
  .source-layout-print-page { position: relative; width: 210mm; height: 297mm; overflow: hidden; break-after: page; }
  .source-layout-print-page:last-child { break-after: auto; }
  .source-layout-print-page .paper { margin: 0 !important; box-shadow: none !important; }
}`;

/** Prepare a print-only document whose text boxes remain actual browser text. */
export async function prepareSourceLayoutPrint(
  layout: ImportedSourceLayout,
  edits: Record<string, string>,
): Promise<() => void> {
  if (!layout.pages.length || layout.pages.length > 50 || layout.pages.some((_, index) =>
    !layout.boxes.some(box => box.page === index + 1 && box.text.trim()))) {
    throw new Error("部分页面没有可编辑文字，请先识别并核对后再导出 PDF");
  }
  if (document.querySelector("[data-source-layout-print-root]")) throw new Error("已有原版式 PDF 正在生成");
  const frozenLayout = structuredClone(layout);
  const frozenEdits = structuredClone(edits);
  const host = document.createElement("div");
  host.dataset.sourceLayoutPrintRoot = "";
  host.setAttribute("aria-hidden", "true");
  document.body.appendChild(host);
  const root = createRoot(host);
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; root.unmount(); host.remove(); } };
  try {
    await document.fonts.ready;
    flushSync(() => root.render(<>
      <style>{PRINT_CSS}</style>
      {frozenLayout.pages.map((_, index) => <div className="source-layout-print-page" key={index}>
        <div className="paper imported-layout-paper" style={{ width: 794, height: 1123, transform: `scale(${PAPER_SCALE})`, transformOrigin: "top left" }}>
          <ImportedLayoutPaper layout={frozenLayout} pageIndex={index} edits={frozenEdits} renderAllText />
        </div>
      </div>)}
    </>));
    await Promise.all(Array.from(host.querySelectorAll("img"), image => image.decode()));
    return dispose;
  } catch (error) { dispose(); throw error; }
}
