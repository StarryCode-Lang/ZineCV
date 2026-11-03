import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { useEditorialCommandPalette } from "../../../src/ui/app/useEditorialCommandPalette";
import { buildEditorialChapters } from "../../../src/ui/domain/editorial-progress";
import { emptyResume, moduleTitles } from "../../../src/ui/domain/resume-model";
import "../../../src/ui/styles/index.css";

function Fixture() {
  const [enabled, setEnabled] = useState(true);
  const [result, setResult] = useState("");
  const beforeOpen = useCallback(() => {}, []);
  const { commandPalette, openCommandPalette } = useEditorialCommandPalette({
    enabled, resumeTitle: "合成简历", workspaceLabel: "内容工坊", onBeforeOpen: beforeOpen,
    commandInput: {
      chapters: buildEditorialChapters(emptyResume, ["summary"], moduleTitles, "自我评价"),
      smartFitActive: false, exportingFormat: null,
      onSelectEditor: () => setResult("editor"), onSelectTemplates: () => setResult("templates"),
      onSelectVersions: () => setResult("versions"), onOpenAgent: () => setResult("agent"),
      onNavigateToEditor: () => setResult("chapter"), onSmartFit: () => setResult("fit"),
      onOpenPanel: (panel) => setResult(panel), onExportPdf: () => setResult("pdf"),
      onExportPng: () => setResult("png"), onCopyText: () => setResult("copy"),
    },
  });
  return <main className="app-shell">
    <button onClick={() => openCommandPalette()}>打开指令面板</button>
    <button onClick={() => setEnabled(false)}>暂停操作</button>
    <output aria-label="执行结果">{result}</output>
    {commandPalette}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
