import { isDragActive } from "motion";

/** Visual feedback only: native buttons remain responsible for activation. */
export function bindButtonPress(
  element: HTMLButtonElement,
  change: (active: boolean) => void,
) {
  const view = element.ownerDocument.defaultView!;
  let pointer: number | undefined;
  const keys = new Set<string>();
  const update = () => change(pointer !== undefined || keys.size > 0);
  const endPointer = (event?: PointerEvent) => {
    if (event && event.pointerId !== pointer) return;
    pointer = undefined;
    view.removeEventListener("pointerup", endPointer, true);
    view.removeEventListener("pointercancel", endPointer, true);
    update();
  };
  const down = (event: PointerEvent) => {
    if (
      pointer !== undefined || isDragActive() ||
      (event.pointerType === "mouse" ? event.button > 0 : !event.isPrimary)
    ) return;
    pointer = event.pointerId;
    view.addEventListener("pointerup", endPointer, true);
    view.addEventListener("pointercancel", endPointer, true);
    update();
  };
  const keyboard = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.code !== "Space") return;
    if (event.type === "keydown") keys.add(event.code || event.key);
    else keys.delete(event.code || event.key);
    update();
  };
  const blur = () => {
    keys.clear();
    endPointer();
  };
  element.addEventListener("pointerdown", down);
  element.addEventListener("keydown", keyboard);
  element.addEventListener("keyup", keyboard);
  element.addEventListener("blur", blur);
  view.addEventListener("blur", blur);
  return () => {
    element.removeEventListener("pointerdown", down);
    element.removeEventListener("keydown", keyboard);
    element.removeEventListener("keyup", keyboard);
    element.removeEventListener("blur", blur);
    view.removeEventListener("blur", blur);
    view.removeEventListener("pointerup", endPointer, true);
    view.removeEventListener("pointercancel", endPointer, true);
    pointer = undefined;
    keys.clear();
  };
}
