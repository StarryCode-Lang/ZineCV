import { useState, useRef, useEffect } from "react";
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

  const notify = (message: string) => {
    if (noticeTimerRef.current !== null)
      window.clearTimeout(noticeTimerRef.current);
    setNotice(message);
    noticeTimerRef.current = window.setTimeout(
      () => setNotice((current) => (current === message ? "" : current)),
      2200,
    );
  };

  return { notice, notify };
}
