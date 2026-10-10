import {createRoot} from "react-dom/client";
import type {CSSProperties} from "react";
import {PreviewContent} from "../../../src/ui/preview/ResumePreview";
import {PreviewOverflowGuard} from "../../../src/ui/preview/PreviewOverflowGuard";
import {measureResumePages, getPreviewBlocks} from "../../../src/ui/services/resume-pagination";
import {fragmentPreviewElement} from "../../../src/ui/services/preview-fragments";
import {visualFixture} from "../../../tools/visual-parity-fixture.mjs";
import "../../../src/platform/fonts";
import "../../../src/ui/styles/index.css";

export async function checkOverflowTransition() {
  const pagesRef = {current: null as HTMLDivElement | null}, measurementRef = {current: null as HTMLDivElement | null};
  const findings: Array<boolean> = [];
  const root = createRoot(document.querySelector("#root")!);
  const until = async (predicate: () => boolean) => {
    const deadline = performance.now() + 2000;
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error("overflow transition observation timed out");
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
  };
  try {
    root.render(<><div ref={measurementRef} style={{height: "1px"}}/>
      <div ref={pagesRef} style={{height: "1122.52px", overflow: "hidden"}}>
        <div className="paper" style={{padding: "0"}}><div className="paper-content" style={{height: "1200px", transition: "height 250ms linear"}}>
          <div className="preview-block" data-layout-block="summary" style={{height: "100%"}}/>
        </div></div>
      </div><PreviewOverflowGuard pages={[]} pagesRef={pagesRef} measurementRef={measurementRef} onChange={finding => { findings.push(!!finding); }}/></>);
    await until(() => findings.includes(true));
    pagesRef.current!.querySelector<HTMLElement>(".paper-content")!.style.height = "900px";
    await until(() => findings.at(-1) === false);
    return {initialOverflow: findings.includes(true), finalOverflow: findings.at(-1)};
  } finally { root.unmount(); }
}

export async function checkLongPages(template: string) {
  const storage = visualFixture(), resume = JSON.parse(storage["resume-diy-state"]);
  const text = "跨页完整正文🙂é与链接。".repeat(850);
  resume.work[0].html = `<p><strong>${text}</strong><a href="https://example.invalid/long">链接保留</a></p>` +
    `<p></p>` + Array.from({length: 55}, (_, i) => `<p>独立段落${i}：<em>跨页内容必须完整。</em></p>`).join("") +
    `<ol start="3"><li></li>${Array.from({length: 60}, (_, i) => `<li>编号条目${i}：保留列表语义。</li>`).join("")}</ol><p></p>`;
  resume.summary = `<p>${"自我评价长段落。".repeat(800)}</p>`;
  const original = JSON.stringify(resume), moduleOrder = ["work", "summary"];
  const props = {resume, moduleNames: {work: "工作经历"}, summaryTitle: "自我评价",
    dateFormat: "2021年1月", titleFormat: "单行标题", separator: "使用分隔符号", textAlign: "两端对齐"} as unknown as Omit<Parameters<typeof PreviewContent>[0], "blocks">;
  const style = {fontSize: "13px", lineHeight: "13px", padding: "30px", "--module-gap": "0px",
    "--template-heading-font-size": "13px", "--template-paragraph-spacing": "0px", "--template-list-spacing": "0px"} as CSSProperties;
  const root = createRoot(document.querySelector("#root")!);
  root.render(<div><div id="measurement" className={`paper layout-measure template-${template}`} style={style}>
    <PreviewContent blocks={getPreviewBlocks(moduleOrder as never, resume)} {...props}/>
  </div><div id="pages"/></div>);
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  await document.fonts.ready;
  const measurement = document.querySelector<HTMLElement>("#measurement")!;
  const sourceText = measurement.querySelector<HTMLElement>('[data-preview-entry-id="work-1"]')!.textContent!.replace(/\s/g, "");
  const pages = measureResumePages(measurement, moduleOrder as never, resume, 1062.52);
  const visibleRoot = createRoot(document.querySelector("#pages")!);
  visibleRoot.render(<>{pages.map((page, i) => <div key={i} className={`paper template-${template}`} style={style}>
    <PreviewContent blocks={page.blocks} {...props}/></div>)}</>);
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const papers = [...document.querySelectorAll<HTMLElement>("#pages .paper")];
  const summaryBlock = measurement.querySelector<HTMLElement>('[data-layout-block="summary"]')!;
  const summaryRich = summaryBlock.querySelector<HTMLElement>(".preview-rich")!;
  const headingHeight = summaryBlock.getBoundingClientRect().height - summaryRich.getBoundingClientRect().height;
  const freshSummary = fragmentPreviewElement(summaryRich, -1, 1062.52, 1062.52 - headingHeight)!;
  const result = {template, pageCount: papers.length, sourceUnchanged: JSON.stringify(resume) === original,
    sourceText, actualText: papers.flatMap(paper => [...paper.querySelectorAll<HTMLElement>('[data-preview-entry-id="work-1"]')].map(entry => entry.innerText)).join("").replace(/\s/g, ""),
    summaryText: papers.flatMap(paper => [...paper.querySelectorAll<HTMLElement>('[data-layout-block="summary"] .preview-rich')].map(rich => rich.innerText)).join("").replace(/\s/g, ""),
    expectedSummary: "自我评价长段落。".repeat(800),
    overflows: papers.map(paper => paper.querySelector(".paper-content")!.getBoundingClientRect().bottom - paper.getBoundingClientRect().bottom + 30),
    entryIds: papers.flatMap(paper => [...paper.querySelectorAll<HTMLElement>("[data-preview-entry-id]")].map(entry => entry.dataset.previewEntryId)),
    linksRetained: papers.some(paper => !!paper.querySelector('a[href="https://example.invalid/long"]')),
    emptyParagraphs: papers.flatMap(paper => [...paper.querySelectorAll('[data-preview-entry-id="work-1"] p')]).filter(p => !p.textContent && !p.children.length).length,
    emptyListItems: papers.flatMap(paper => [...paper.querySelectorAll('[data-preview-entry-id="work-1"] li')]).filter(li => !li.textContent && !li.children.length).length,
    freshSummary: {freshPage: freshSummary.freshPage, firstHeight: freshSummary.fragments[0].height + headingHeight,
      maxContinuedHeight: Math.max(...freshSummary.fragments.slice(1).map(fragment => fragment.height))}};
  visibleRoot.unmount(); root.unmount(); return result;
}
