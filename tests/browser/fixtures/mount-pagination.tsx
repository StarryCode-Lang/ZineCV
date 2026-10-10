import { StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useResumePagination } from "../../../src/ui/app/useResumePagination";

const entries = Array.from({ length: 19 }, (_, index) => ({ id: `entry-${index}` }));
const noop = () => {};
const options = { resume: { work: entries, summary: "" }, moduleOrder: ["work"], moduleNames: { work: "Work" },
  summaryTitle: "Summary", font: "serif", fontSize: "13", lineHeight: "13", moduleSpacing: "0", pageMargin: "30",
  dateFormat: "2021年1月", titleFormat: "单行标题", separator: "使用分隔符号", textAlign: "系统默认", layoutContextKey: "legacy-fixed",
  smartFillEnabled: false, initialAutoFitEnabled: false, setFontSize: noop, setLineHeight: noop,
  setModuleSpacing: noop, setPageMargin: noop, setSmartFillEnabled: noop, notify: noop };
let root: Root;
let mount = noop, replace = noop;
function Harness() {
  const [mounted, setMounted] = useState(false), [generation, setGeneration] = useState(0);
  mount = () => setMounted(true);
  replace = () => setGeneration(value => value + 1);
  const pagination = useResumePagination(options as unknown as Parameters<typeof useResumePagination>[0]);
  return <div><output id="page-count">{pagination.previewPages.length}</output>
    {mounted && <div className="measurement" ref={pagination.paginationMeasureRef} key={generation}>
      <div className="paper-content"><div className="header" data-layout-block="header" />
        <div className="block" data-layout-block="work"><div className="heading" />
          {entries.map(entry => <div key={entry.id} className="entry" data-preview-entry-id={entry.id} />)}
        </div></div></div>}
  </div>;
}
export function mountHarness() {
  document.head.insertAdjacentHTML("beforeend", "<style>.measurement,.paper-content,.block{display:flow-root;width:733.688px}.header{height:88px}.heading{height:19.5px}.entry{height:107px}.entry+.entry{margin-top:2.5px}</style>");
  root = createRoot(document.querySelector("#root")!);
  root.render(<StrictMode><Harness /></StrictMode>);
}
export function mountMeasurement() { mount(); }
export function replaceMeasurement() { replace(); }
export function unmountHarness() { root.unmount(); }
