import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ImportedSourceLayout } from "../domain/imported-layout";
import { ImportedLayoutPaper } from "../preview/ImportedLayoutPaper";

const PAPER_WIDTH = 794;
const PAPER_HEIGHT = 1123;
const MAX_SELECTED_PIXELS = 64_000_000;

/** Render the same source-layout component as the preview at its unscaled A4 size. */
export async function renderSourceLayoutPages(
  layout: ImportedSourceLayout,
  edits: Record<string, string>,
  dpi = 192,
): Promise<HTMLCanvasElement[]> {
  if (!layout.pages.length || layout.pages.length > 50) throw new Error("原版式页面数量无效");
  if (!Number.isInteger(dpi) || dpi < 72 || dpi > 300) throw new Error("原版式导出分辨率无效");
  const scale = dpi / 96;
  if (Math.floor(PAPER_WIDTH * scale) * Math.floor(PAPER_HEIGHT * scale) * layout.pages.length > MAX_SELECTED_PIXELS) {
    throw new Error("原版式页面超过导出像素上限，请降低分辨率");
  }
  // Capture before the first await: edits made during rendering belong to the next export.
  const frozenLayout = structuredClone(layout);
  const frozenEdits = structuredClone(edits);
  const host = document.createElement("div");
  host.dataset.sourceLayoutExportRoot = "";
  Object.assign(host.style, { position: "fixed", left: "-10000px", top: "0", width: `${PAPER_WIDTH}px`, zIndex: "-1" });
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await document.fonts.ready;
    const { default: html2canvas } = await import("html2canvas");
    const pages: HTMLCanvasElement[] = [];
    for (let index = 0; index < frozenLayout.pages.length; index++) {
      flushSync(() => root.render(
        <div className="paper imported-layout-paper" style={{ width: PAPER_WIDTH, height: PAPER_HEIGHT, transform: "none" }}>
          <ImportedLayoutPaper layout={frozenLayout} pageIndex={index} edits={frozenEdits} />
        </div>,
      ));
      const paper = host.firstElementChild as HTMLElement;
      const images = Array.from(paper.querySelectorAll("img"));
      await Promise.all(images.map(image => image.decode()));
      pages.push(await html2canvas(paper, {
        backgroundColor: "#ffffff", logging: false, useCORS: true,
        width: PAPER_WIDTH, height: PAPER_HEIGHT, scale,
      }));
    }
    return pages;
  } finally {
    root.unmount();
    host.remove();
  }
}
