import { A4_HEIGHT_PX, A4_WIDTH_PX } from "../domain/resume-model";

// 导出服务只读取页面中的可见 A4 节点，不依赖编辑器状态。
async function renderResumePages() {
  const papers = Array.from(
    document.querySelectorAll<HTMLElement>(".paper:not(.layout-measure)"),
  );
  if (!papers.length) throw new Error("没有可导出的简历页面");

  const clones: HTMLElement[] = [];
  try {
    await document.fonts?.ready;
    const { default: html2canvas } = await import("html2canvas");
    const renderedPages: HTMLCanvasElement[] = [];
    for (const paper of papers) {
      const clone = paper.cloneNode(true) as HTMLElement;
      clone.classList.add("export-paper");
      Object.assign(clone.style, {
        position: "fixed",
        left: "-10000px",
        top: "0",
        transform: "none",
        zIndex: "-1",
      });
      document.body.appendChild(clone);
      clones.push(clone);
      renderedPages.push(
        await html2canvas(clone, {
          backgroundColor: "#ffffff",
          logging: false,
          scale: 2,
          useCORS: true,
          width: Math.ceil(A4_WIDTH_PX),
          height: Math.ceil(A4_HEIGHT_PX),
        }),
      );
    }
    return renderedPages;
  } finally {
    clones.forEach((clone) => clone.remove());
  }
}

// PDF 导出已由 Rust/Typst 矢量输出（export_document_pdf）取代；
// 本文件只保留 PNG 多页纵向长图导出（html2canvas 2x 渲染可见 A4）。

// 多页 PNG 纵向拼接成一张高清长图，单页尺寸与网页预览一致。
export async function exportResumeAsPng(fileName: string) {
  const renderedPages = await renderResumePages();
  const output = document.createElement("canvas");
  output.width = Math.max(...renderedPages.map((canvas) => canvas.width));
  output.height = renderedPages.reduce(
    (height, canvas) => height + canvas.height,
    0,
  );
  const context = output.getContext("2d");
  if (!context) throw new Error("无法创建图片画布");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, output.width, output.height);
  let offsetY = 0;
  renderedPages.forEach((canvas) => {
    context.drawImage(canvas, 0, offsetY);
    offsetY += canvas.height;
  });

  const link = document.createElement("a");
  link.download = `${fileName}.png`;
  link.href = output.toDataURL("image/png", 1);
  link.click();
}
