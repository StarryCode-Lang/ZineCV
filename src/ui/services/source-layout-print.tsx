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
  if (layout.linkStatus === "incomplete") throw new Error("源 PDF 有无法恢复的链接，请核对原文件后重新导入。");
  if (layout.sourceLinks !== undefined) {
    if (layout.linkStatus !== "complete" || !Array.isArray(layout.sourceLinks) || layout.sourceLinks.length > 10_000) {
      throw new Error("源 PDF 链接数据无效，请重新导入。");
    }
    for (const link of layout.sourceLinks) {
      const target = layout.pages[link.page - 1];
      let safe = false;
      try { safe = link.href.length <= 2048 && ["http:", "https:", "mailto:"].includes(new URL(link.href).protocol); } catch { /* invalid URL */ }
      if (!target || !Number.isInteger(link.page) || !safe ||
        ![link.x, link.y, link.width, link.height].every(Number.isFinite) ||
        link.x < 0 || link.y < 0 || link.width <= 0 || link.height <= 0 ||
        link.x + link.width > target.width || link.y + link.height > target.height) {
        throw new Error("源 PDF 链接数据无效，请重新导入。");
      }
    }
  }
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
          {(frozenLayout.sourceLinks ?? []).filter(link => link.page === index + 1).map((link, linkIndex) => {
            const page = frozenLayout.pages[index];
            const scale = Math.min(794 / page.width, 1123 / page.height);
            return <a key={linkIndex} href={link.href} tabIndex={-1} style={{ position: "absolute", display: "block", zIndex: 10,
              left: (794 - page.width * scale) / 2 + link.x * scale,
              top: (1123 - page.height * scale) / 2 + link.y * scale,
              width: link.width * scale, height: link.height * scale }} />;
          })}
        </div>
      </div>)}
    </>));
    await Promise.all(Array.from(host.querySelectorAll("img"), image => image.decode()));
    return dispose;
  } catch (error) { dispose(); throw error; }
}
