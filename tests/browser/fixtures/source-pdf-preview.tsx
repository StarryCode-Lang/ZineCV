import { createRoot } from "react-dom/client";
import { ImportedLayoutPaper } from "../../../src/ui/preview/ImportedLayoutPaper";
import { extractPdfSourceLayout } from "../../../src/ui/services/source-layout-pdf";

export async function mountSourcePdf(bytes: Uint8Array) {
  const layout = await extractPdfSourceLayout(new File([bytes as Uint8Array<ArrayBuffer>], "source.pdf", { type: "application/pdf" }));
  if (!layout) throw new Error("source layout unavailable");
  const edited = layout.boxes.find((box) => box.text.includes("Alex"));
  if (!edited) throw new Error("fixture text unavailable");
  const root = document.getElementById("root")!;
  root.style.cssText = "position:relative;width:794px;height:1123px;background:white;box-shadow:0 0 10px #888";
  createRoot(root).render(<ImportedLayoutPaper layout={layout} pageIndex={0} edits={{ [edited.id]: "Jordan Sample" }} />);
}
