import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ResumePreviewPane } from "../../../src/ui/preview/ResumePreviewPane";
import { emptyResume, moduleTitles } from "../../../src/ui/domain/resume-model";
import "../../../src/ui/styles/index.css";

function Fixture() {
  const measurement = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  return <main className="app-shell"><output aria-label="保存的缩放" style={{ display: "none" }}>{zoom}</output><div className="workspace" style={{ width: 950 }}>
    <ResumePreviewPane templateId="legacy-v1" templateHeadingFontSize="14" templateParagraphSpacing="0"
      templateListSpacing="0" measurementRef={measurement} pages={[{ blocks: [], extraModuleGap: 0, lineHeight: 18 }]}
      allBlocks={[]} resume={emptyResume} moduleNames={moduleTitles} summaryTitle="自我评价" dateFormat="2021年1月"
      titleFormat="单行标题" separator="使用分隔符号" textAlign="系统默认" fontFamily="sans-serif" fontSize="13"
      measurementLineHeight={18} letterSpacing={0} pagePadding={30} measurementModuleGap={0} baseModuleGap={0}
      theme="#000000" initialZoomPercent={null} onZoomPercentChange={setZoom} onNavigateToEditor={() => {}}
      onOverflowChange={() => {}} />
  </div></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
