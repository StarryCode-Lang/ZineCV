import type {
  PreviewBlock,
  ResumeState,
  SectionKey,
} from "../domain/resume-model";
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
    const entryHeights = entryElements.map((entry) => ({
      id: entry.dataset.previewEntryId ?? "",
      height: entry.getBoundingClientRect().height,
    }));
    const repeatedSectionChrome = Math.max(
      0,
      sectionHeight -
        entryHeights.reduce((sum, entry) => sum + entry.height, 0),
    );
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

    const commitChunk = () => {
      if (!chunkIds.length) return;
      addBlock(
        { kind: "module", module: section, entryIds: chunkIds },
        repeatedSectionChrome + chunkEntriesHeight,
      );
      chunkIds = [];
      chunkEntriesHeight = 0;
    };

    for (const entry of entryHeights) {
      const candidateHeight =
        repeatedSectionChrome + chunkEntriesHeight + entry.height;
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
      chunkEntriesHeight += entry.height;
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
