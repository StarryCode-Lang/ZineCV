import { createRoot, type Root } from "react-dom/client";
import { EngineSvgPages } from "../../../src/preview/EngineSvgPages";
import { verifyPreview } from "../../../src/preview/enginePreview";
import type { PreviewResult } from "../../../src-tauri/src/domain/bindings/PreviewResult";

let root: Root | undefined;
export async function mountEnginePreview(result: PreviewResult, zoomPercent: number) {
  await verifyPreview(result, result.cursor);
  root ??= createRoot(document.getElementById("root")!);
  root.render(<EngineSvgPages result={result} zoomPercent={zoomPercent} onLocate={(sourceNodeId) => { document.getElementById("root")!.dataset.locatedNode = sourceNodeId; }} onOpenLink={(href) => { document.getElementById("root")!.dataset.openedLink = href; }} />);
}
