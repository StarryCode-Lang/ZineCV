
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
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}
