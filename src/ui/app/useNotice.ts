import { useState, useRef, useEffect, useCallback } from "react";
export function useNotice() {
  const [notice, setNotice] = useState("");
  const noticeTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null)
        window.clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  // notify 身份必须稳定：App.tsx 的导入模板同步 effect 与分页回调把 notify
  // 放进依赖数组，不稳定的函数会让 120ms 去抖在每次渲染时被重置。
  const notify = useCallback((message: string) => {
    if (noticeTimerRef.current !== null)
      window.clearTimeout(noticeTimerRef.current);
    setNotice(message);
    noticeTimerRef.current = window.setTimeout(
      () => setNotice((current) => (current === message ? "" : current)),
      2200,
    );
  }, []);

  return { notice, notify };
}
