import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ImportedLayoutEditor } from "../../../src/ui/editor/ImportedLayoutEditor";
import { ResumePreviewPane } from "../../../src/ui/preview/ResumePreviewPane";
import { emptyResume, moduleTitles } from "../../../src/ui/domain/resume-model";
import type { ImportedSourceLayout } from "../../../src/ui/domain/imported-layout";
import "../../../src/ui/styles/index.css";

const background = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="794" height="1123"><rect width="794" height="1123" fill="white"/><text x="50" y="80" font-size="18">Original</text></svg>')}`;
const layout: ImportedSourceLayout = { version: 1, pages: [{ width: 794, height: 1123, background }, { width: 794, height: 1123, background }],
  boxes: [{ id: "p1-b1", page: 1, x: 50, y: 62, width: 120, height: 22, text: "Original", fontSize: 18, lineHeight: 22,
    fontFamily: "Arial", fontWeight: "400", fontStyle: "normal", color: "#000", background: "#fff", align: "left" }], extractedChars: 8, warnings: [] };
function Fixture() {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const measurement = useRef<HTMLDivElement>(null);
  return <main className="app-shell"><div className="workspace" style={{ width: 1200 }}>
    <div className="editor-pane editor-workspace-pane" style={{ width: 400, minWidth: 400 }}><div className="editor-scroll">
      <ImportedLayoutEditor layout={layout} edits={edits} templateName="源文件" onChange={(id, value) => setEdits((old) => ({ ...old, [id]: value }))} onReset={() => setEdits({})} />
    </div></div>
    <ResumePreviewPane templateId="legacy-v1" templateHeadingFontSize="14" templateParagraphSpacing="0" templateListSpacing="0"
      measurementRef={measurement} pages={[{ blocks: [], extraModuleGap: 0, lineHeight: 18 }]} allBlocks={[]} resume={emptyResume}
      moduleNames={moduleTitles} summaryTitle="自我评价" dateFormat="2021年1月" titleFormat="单行标题" separator="使用分隔符号"
      textAlign="系统默认" fontFamily="sans-serif" fontSize="13" measurementLineHeight={18} letterSpacing={0} pagePadding={30}
      measurementModuleGap={0} baseModuleGap={0} theme="#000" initialZoomPercent={null} onZoomPercentChange={() => {}}
      onNavigateToEditor={() => {}} onOverflowChange={() => {}} importedLayout={layout} importedEdits={edits} />
  </div></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
