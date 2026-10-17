import { Fragment, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import type { Entry } from "../domain/resume-model";

export type EntryDragHandleProps = {
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
};

// Preview the order locally. Only a completed drop publishes to the existing
// document queue; cancellation must leave the durable document untouched.
export function SortableEntryList({ entries, onReorder, renderEntry }: {
  entries: Entry[];
  onReorder: (ids: string[]) => void;
  renderEntry: (entry: Entry, handle: EntryDragHandleProps, dragging: boolean) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef({ entries, onReorder });
  latest.current = { entries, onReorder };
  const session = useRef<{ id: string; pointer: number; x: number; y: number; originX: number; originY: number; order: string[]; active: boolean } | null>(null);
  const frame = useRef<number | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  useEffect(() => {
    const finish = (commit: boolean) => {
      const drag = session.current;
      session.current = null;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      setPreview(null);
      setDragging(null);
      if (!commit || !drag?.active) return;
      const current = latest.current.entries.map(entry => entry.id);
      // A concurrent add/delete invalidates this gesture rather than losing data.
      if (current.length !== drag.order.length || current.some(id => !drag.order.includes(id))) return;
      if (current.some((id, index) => id !== drag.order[index])) latest.current.onReorder(drag.order);
    };
    const process = () => {
      frame.current = null;
      const drag = session.current;
      const list = root.current;
      if (!drag || !list) return;
      if (!drag.active && Math.hypot(drag.x - drag.originX, drag.y - drag.originY) < 5) return;
      drag.active = true;
      setDragging(drag.id);
      const scroll = list.closest<HTMLElement>(".editor-scroll");
      if (scroll) {
        const rect = scroll.getBoundingClientRect();
        const delta = drag.y < rect.top + 40 ? -18 : drag.y > rect.bottom - 40 ? 18 : 0;
        const previous = scroll.scrollTop;
        if (delta) scroll.scrollTop += delta;
        if (scroll.scrollTop !== previous) frame.current = requestAnimationFrame(process);
      }
      const hit = document.elementFromPoint(drag.x, drag.y)?.closest<HTMLElement>("[data-editor-entry-id]");
      if (!hit || !list.contains(hit)) return;
      const from = drag.order.indexOf(drag.id);
      const to = drag.order.indexOf(hit.dataset.editorEntryId ?? "");
      if (from < 0 || to < 0 || from === to) return;
      const rect = hit.getBoundingClientRect();
      if (from < to ? drag.y <= rect.top + rect.height * .62 : drag.y >= rect.top + rect.height * .38) return;
      const next = [...drag.order];
      next.splice(from, 1);
      next.splice(to, 0, drag.id);
      drag.order = next;
      setPreview(next);
    };
    const move = (event: globalThis.PointerEvent) => {
      const drag = session.current;
      if (!drag || event.pointerId !== drag.pointer) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (frame.current === null) frame.current = requestAnimationFrame(process);
    };
    const up = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== session.current?.pointer) return;
      move(event);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      process(); // Include the final position even when release precedes rAF.
      finish(true);
    };
    const cancel = (event: globalThis.PointerEvent) => {
      if (event.pointerId === session.current?.pointer) finish(false);
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && session.current) { event.preventDefault(); finish(false); }
    };
    const blur = () => finish(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", blur);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      session.current = null;
    };
  }, []);

  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const ordered = preview && preview.length === entries.length && preview.every(id => byId.has(id))
    ? preview.map(id => byId.get(id)!) : entries;
  return <div className="entry-list" ref={root}>
    {ordered.map(entry => <Fragment key={entry.id}>{renderEntry(entry, {
      onPointerDown: event => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.stopPropagation();
        session.current = { id: entry.id, pointer: event.pointerId, x: event.clientX, y: event.clientY, originX: event.clientX, originY: event.clientY, active: false, order: latest.current.entries.map(item => item.id) };
      },
      onKeyDown: event => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        event.stopPropagation();
        if (session.current) return;
        const ids = latest.current.entries.map(item => item.id);
        const from = ids.indexOf(entry.id);
        const to = from + (event.key === "ArrowUp" ? -1 : 1);
        if (from < 0 || to < 0 || to >= ids.length) return;
        ids.splice(from, 1);
        ids.splice(to, 0, entry.id);
        latest.current.onReorder(ids);
      },
    }, dragging === entry.id)}</Fragment>)}
  </div>;
}
