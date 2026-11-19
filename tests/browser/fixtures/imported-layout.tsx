import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ImportedLayoutEditor } from "../../../src/ui/editor/ImportedLayoutEditor";
import { ImportedLayoutPaper } from "../../../src/ui/preview/ImportedLayoutPaper";
import type { ImportedSourceLayout } from "../../../src/ui/domain/imported-layout";
import "../../../src/ui/styles/index.css";

const box = { page: 1, x: 50, width: 270, height: 22, fontSize: 18, lineHeight: 22,
  fontFamily: "Arial", fontWeight: "400", fontStyle: "normal", color: "#000000", background: "#ffffff", align: "left" as const };
export const layout: ImportedSourceLayout = {
  version: 1,
  pages: [{ width: 794, height: 1123, background: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="794" height="1123"><rect width="794" height="1123" fill="white"/><text x="50" y="80" font-size="18">Original name</text><text x="50" y="110" font-size="18">Original role</text></svg>')}` }],
  boxes: [{ ...box, id: "name", y: 62, text: "Original name" }, { ...box, id: "role", y: 92, text: "Original role" }],
  extractedChars: 26, warnings: [],
};

function Fixture() {
  const [edits, setEdits] = useState<Record<string, string>>({});
  return <div className="app-shell" style={{ display: "flex", height: "100vh" }}>
    <div style={{ width: 400, overflow: "auto" }}><ImportedLayoutEditor layout={layout} edits={edits} templateName="源文件"
      onChange={(id, value) => setEdits((old) => ({ ...old, [id]: value }))} onReset={() => setEdits({})} /></div>
    <div className="paper imported-layout-paper" style={{ width: 794, height: 1123 }}><ImportedLayoutPaper layout={layout} pageIndex={0} edits={edits} /></div>
  </div>;
}

export function mountImportedLayout() {
  createRoot(document.getElementById("root")!).render(<Fixture />);
}

// PDF 行框的框宽是墨迹宽（不含左右侧边距），文字 advance 会比框宽大 2%~12%。
// 同字符数替换必须保持原字号，不能因为“墨迹框比排版窄”触发缩放。
export const narrowLayout: ImportedSourceLayout = {
  version: 1,
  pages: [{ width: 794, height: 1123, background: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="794" height="1123"><rect width="794" height="1123" fill="white"/></svg>')}` }],
  boxes: [
    { ...box, id: "narrow", x: 100, y: 100, width: 236, height: 24, fontSize: 20, lineHeight: 22, text: "HOBBIES AND INTERESTS", baseline: 118 } as typeof box & { baseline: number },
    { ...box, id: "next", x: 100, y: 140, text: "NEXT LINE" },
  ],
  extractedChars: 32,
  warnings: [],
};

export function mountNarrowLayout() {
  createRoot(document.getElementById("root")!).render(
    <div className="paper imported-layout-paper" style={{ width: 794, height: 1123 }}>
      <ImportedLayoutPaper layout={narrowLayout} pageIndex={0} edits={{ narrow: "HOBBIEZ AND INTERESTS" }} />
    </div>,
  );
}
