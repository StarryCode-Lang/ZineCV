
type EditorBufferFlush = () => boolean | Promise<boolean>;

const editorBufferFlushers = new Map<string, EditorBufferFlush>();

export function registerEditorBuffer(
  key: string,
  flush: EditorBufferFlush,
): () => void {
  editorBufferFlushers.set(key, flush);
  return () => {
    if (editorBufferFlushers.get(key) === flush) editorBufferFlushers.delete(key);
  };
}

export async function flushEditorBuffers(): Promise<void> {
  const pending = await Promise.all(
    Array.from(editorBufferFlushers.values(), (flush) => flush()),
  );
  if (!pending.some(Boolean)) return;
  await new Promise<void>((resolve) => {
    // 页面隐藏/被遮挡时 rAF 会被 Chromium 节流停摆（关窗前的 flush 因此
    // 永久 pending），此时退回 setTimeout 保证 flush 一定完成。
    if (
      typeof requestAnimationFrame === "function" &&
      document.visibilityState !== "hidden"
    ) {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}
