import type {
  PreviewBlock,
  ResumeState,
  SectionKey,
} from "../domain/resume-model";
import {fragmentPreviewElement} from "./preview-fragments";
// 按测量稿的实际高度分页，保留经历边界和跨页时重复显示的模块标题。
export function measureResumePages(
  measurement: HTMLElement,
  moduleOrder: SectionKey[],
  resume: ResumeState,
  contentHeight: number,
) {
  const measuredBlocks = Array.from(
    measurement.querySelectorAll<HTMLElement>("[data-layout-block]"),
  );
  const header = measuredBlocks.find(
    (block) => block.dataset.layoutBlock === "header",
  );
  const rawPages: Array<{ blocks: PreviewBlock[]; used: number }> = [
    {
      blocks: [{ kind: "header" }],
      used: header?.getBoundingClientRect().height ?? 0,
    },
  ];
  let currentPage = rawPages[0];

  const startPage = () => {
    currentPage = { blocks: [], used: 0 };
    rawPages.push(currentPage);
  };

  const addBlock = (block: PreviewBlock, height: number) => {
    currentPage.blocks.push(block);
    currentPage.used += height;
  };

  for (const section of moduleOrder) {
    const element = measuredBlocks.find(
      (block) => block.dataset.layoutBlock === section,
    );
    if (!element) continue;
    const sectionHeight = element.getBoundingClientRect().height;
    const block: PreviewBlock =
      section === "summary"
        ? { kind: "summary" }
        : {
            kind: "module",
            module: section,
            entryIds: resume[section].map((entry) => entry.id),
          };

    if (currentPage.used + sectionHeight <= contentHeight) {
      addBlock(block, sectionHeight);
      continue;
    }

    if (section === "summary") {
      const rich = element.querySelector<HTMLElement>(".preview-rich");
      const paragraphs = rich ? Array.from(rich.children) : [];
      if (!rich || !paragraphs.length) {
        startPage();
        addBlock(block, sectionHeight);
        continue;
      }
      const headingHeight = Math.max(0, sectionHeight - rich.getBoundingClientRect().height);
      if (paragraphs.some(paragraph => paragraph.getBoundingClientRect().height > contentHeight)) {
        const split = fragmentPreviewElement(rich, contentHeight - currentPage.used - headingHeight, contentHeight, contentHeight - headingHeight);
        if (split) {
          if (split.freshPage) startPage();
          for (const [index, fragment] of split.fragments.entries()) {
            if (index) startPage();
            addBlock({kind: "summary", html: fragment.html, continued: index > 0}, fragment.height + (index ? 0 : headingHeight));
          }
          continue;
        }
      }
      let continued = false;
      let chunk: string[] = [];
      let chunkHeight = 0;
      const commitSummary = () => {
        if (!chunk.length) return;
        addBlock({ kind: "summary", html: chunk.join(""), continued }, chunkHeight + (continued ? 0 : headingHeight));
        chunk = [];
        chunkHeight = 0;
        continued = true;
      };
      for (const paragraph of paragraphs) {
        const height = paragraph.getBoundingClientRect().height;
        const chrome = continued ? 0 : headingHeight;
        if (currentPage.used + chrome + chunkHeight + height > contentHeight && (chunk.length || currentPage.blocks.length)) {
          commitSummary();
          startPage();
        }
        chunk.push(paragraph.outerHTML);
        chunkHeight += height;
      }
      commitSummary();
      continue;
    }

    const entryElements = Array.from(
      element.querySelectorAll<HTMLElement>("[data-preview-entry-id]"),
    );
    const entryHeights = entryElements.map((entry, index) => ({
      id: entry.dataset.previewEntryId ?? "",
      element: entry,
      height: entry.getBoundingClientRect().height,
      // Templates may use margins or a grid gap. Measure the actual distance
      // rather than treating all source gaps as repeated heading chrome.
      gap: index ? Math.max(0, entry.getBoundingClientRect().top -
        entryElements[index - 1].getBoundingClientRect().bottom) : 0,
    }));
    const repeatedSectionChrome = Math.max(
      0,
      sectionHeight -
        entryHeights.reduce((sum, entry) => sum + entry.height + entry.gap, 0),
    );
    const heading = element.querySelector<HTMLElement>(".preview-title");
    const headingStyle = heading ? getComputedStyle(heading) : null;
    const continuedSectionChrome = Math.max(0, repeatedSectionChrome - (heading
      ? heading.getBoundingClientRect().height + parseFloat(headingStyle!.marginTop) + parseFloat(headingStyle!.marginBottom) : 0));
    const remainingOnPage = contentHeight - currentPage.used;
    const firstEntryFits =
      entryHeights.length > 1 &&
      repeatedSectionChrome + entryHeights[0].height <= remainingOnPage;
    if (sectionHeight <= contentHeight && !firstEntryFits) {
      startPage();
      addBlock(block, sectionHeight);
      continue;
    }
    let chunkIds: string[] = [];
    let chunkEntriesHeight = 0;
    let chunkHtml: Record<string, string> = {};
    let chunkContinued = false;

    const commitChunk = () => {
      if (!chunkIds.length) return;
      let html: string | undefined;
      if (Object.keys(chunkHtml).length) {
        const clone = element.cloneNode(true) as HTMLElement;
        if (chunkContinued) clone.querySelector(".preview-title")?.remove();
        for (const entry of clone.querySelectorAll<HTMLElement>("[data-preview-entry-id]")) {
          const id = entry.dataset.previewEntryId ?? "";
          if (!chunkIds.includes(id)) entry.remove();
          else if (id in chunkHtml) entry.innerHTML = chunkHtml[id];
        }
        html = clone.innerHTML;
      }
      addBlock(
        { kind: "module", module: section, entryIds: chunkIds, ...(html === undefined ? {} : {html}) },
        (chunkContinued ? continuedSectionChrome : repeatedSectionChrome) + chunkEntriesHeight,
      );
      chunkIds = [];
      chunkEntriesHeight = 0;
      chunkHtml = {};
      chunkContinued = false;
    };

    for (const entry of entryHeights) {
      if (entry.height + repeatedSectionChrome > contentHeight) {
        const split = fragmentPreviewElement(entry.element,
          contentHeight - currentPage.used - (chunkContinued ? continuedSectionChrome : repeatedSectionChrome) - chunkEntriesHeight - (chunkIds.length ? entry.gap : 0),
          contentHeight - continuedSectionChrome, contentHeight - repeatedSectionChrome);
        if (split) {
          if (split.freshPage) { commitChunk(); startPage(); }
          for (const [index, fragment] of split.fragments.entries()) {
            if (index) { commitChunk(); startPage(); chunkContinued = true; }
            chunkEntriesHeight += fragment.height + (chunkIds.length ? entry.gap : 0);
            chunkIds.push(entry.id); chunkHtml[entry.id] = fragment.html;
          }
          continue;
        }
      }
      const candidateHeight =
        (chunkContinued ? continuedSectionChrome : repeatedSectionChrome) + chunkEntriesHeight + entry.height + (chunkIds.length ? entry.gap : 0);
      if (
        !chunkIds.length &&
        currentPage.used + candidateHeight > contentHeight &&
        currentPage.blocks.length
      )
        startPage();
      else if (
        chunkIds.length &&
        currentPage.used + candidateHeight > contentHeight
      ) {
        commitChunk();
        startPage();
      }
      chunkIds.push(entry.id);
      chunkEntriesHeight += entry.height + (chunkIds.length > 1 ? entry.gap : 0);
    }
    commitChunk();
  }

  return rawPages;
}
export function getPreviewBlocks(
  moduleOrder: SectionKey[],
  resume: ResumeState,
): PreviewBlock[] {
  return [
    { kind: "header" },
    ...moduleOrder.map((section): PreviewBlock =>
      section === "summary"
        ? { kind: "summary" }
        : {
            kind: "module",
            module: section,
            entryIds: resume[section].map((entry) => entry.id),
          },
    ),
  ];
}
