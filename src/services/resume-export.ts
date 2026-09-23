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

// 直接生成标准 A4 PDF，避免依赖各浏览器不一致的打印弹窗。
export async function exportResumeAsPdf(fileName: string) {
  const [renderedPages, { jsPDF }] = await Promise.all([
    renderResumePages(),
    import("jspdf"),
  ]);
  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
    compress: true,
  });
  renderedPages.forEach((canvas, index) => {
    if (index > 0) pdf.addPage("a4", "portrait");
    pdf.addImage(canvas, "PNG", 0, 0, 210, 297, undefined, "FAST");
  });
  pdf.save(`${fileName}.pdf`);
}

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
