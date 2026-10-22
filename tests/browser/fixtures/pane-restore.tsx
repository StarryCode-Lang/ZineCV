import { StrictMode, useCallback, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { usePaneResize } from "../../../src/ui/app/usePaneResize";

export async function checkPaneRestore() {
  const writes: number[] = [];
  let hydrate: () => void = () => { throw new Error("Harness not ready"); };
  let controls: ReturnType<typeof usePaneResize>;
  let setSavedWidth: (width: number) => void;
  function Harness() {
    const [savedWidth, setWidth] = useState(560);
    const [ready, setReady] = useState(false);
    setSavedWidth = setWidth;
    hydrate = () => { setWidth(520); setReady(true); };
    const persist = useCallback((width: number) => {
      writes.push(width);
      if (writes.length < 16) setWidth(width);
    }, []);
    controls = usePaneResize({initialWidth: savedWidth, persistenceEnabled: ready, onWidthChange: persist});
    return ready ? <section ref={controls.workspaceRef} style={{width: 1260, display: "flex"}}>
      <aside className="rail" style={{width:134, flex:"0 0 134px"}} />
      <div data-pane style={{width:controls.editorPaneWidth, flex:`0 0 ${controls.editorPaneWidth}px`}} />
    </section> : null;
  }
  const root = createRoot(document.querySelector("#root")!);
  const frames = async (count = 4) => { for(let i=0;i<count;i++) await new Promise<void>(done=>requestAnimationFrame(()=>done())); };
  try {
    root.render(<StrictMode><Harness /></StrictMode>);
    await frames(); hydrate(); await frames(12);
    const restored = controls!.editorPaneWidth;
    const restoreWrites = [...writes];
    controls!.handlePaneSplitterKeyDown({key:"ArrowRight",preventDefault(){}} as never);
    await frames();
    const keyboard = controls!.editorPaneWidth;
    setSavedWidth!(900); await frames();
    const bounded = controls!.editorPaneWidth;
    controls!.resetPaneWidth(); await frames();
    return {restored,restoreWrites,keyboard,bounded,max:controls!.paneBounds.max,reset:controls!.editorPaneWidth,writes};
  } finally {root.unmount();}
}
