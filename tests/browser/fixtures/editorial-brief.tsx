import { useState } from "react";
import { createRoot } from "react-dom/client";
import { EditorialBrief } from "../../../src/ui/editor/EditorialBrief";
import { emptyResume, moduleTitles } from "../../../src/ui/domain/resume-model";
import "../../../src/ui/styles/index.css";

function Fixture() {
  const [title, setTitle] = useState("原始标题");
  const [blocked, setBlocked] = useState(false);
  const resume = { ...emptyResume, basic: { ...emptyResume.basic, name: "测试", email: "test@example.test" }, summary: "<p>内容</p>" };
  return <main className="app-shell"><button onClick={() => setBlocked(true)}>模拟溢出</button>
    <EditorialBrief resume={resume} resumeTitle={title} onResumeTitleChange={setTitle} pageCount={2}
      moduleOrder={["summary"]} moduleNames={moduleTitles} summaryTitle="自我评价" exportBlocked={blocked} />
    <output aria-label="当前标题">{title}</output>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
