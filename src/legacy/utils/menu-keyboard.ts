export function getKeyboardNavigationIndex(
  key: string,
  activeIndex: number,
  itemCount: number,
  boundary: "wrap" | "clamp" = "wrap",
): number | null {
  if (itemCount === 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (key !== "ArrowDown" && key !== "ArrowUp") return null;

  const nextIndex = activeIndex + (key === "ArrowDown" ? 1 : -1);
  return boundary === "wrap"
    ? ((nextIndex % itemCount) + itemCount) % itemCount
    : Math.min(itemCount - 1, Math.max(0, nextIndex));
}
