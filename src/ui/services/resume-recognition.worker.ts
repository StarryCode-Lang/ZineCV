import {
  structureRecognizedLines,
  type RecognizedLine,
} from "./resume-content-recognition";

type Request = {
  id: number;
  source: "pdf" | "word" | "image";
  lines: RecognizedLine[];
};

self.addEventListener("message", (event: MessageEvent<Request>) => {
  const { id, source, lines } = event.data;
  try {
    const result = structureRecognizedLines(lines, source);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : "简历内容映射失败",
    });
  }
});
