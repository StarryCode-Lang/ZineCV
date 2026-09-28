type TemplateActivity = { favorite: boolean; lastUsedAt: number | null };
export type TemplateLibrary = Record<string, TemplateActivity>;
const STORAGE_KEY = "resume-diy-template-library-v1";

export function readTemplateLibrary(): TemplateLibrary {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "{}",
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).flatMap(([id, activity]) => {
        if (!activity || typeof activity !== "object") return [];
        return [
          [
            id,
            {
              favorite: activity.favorite === true,
              lastUsedAt:
                typeof activity.lastUsedAt === "number" &&
                Number.isFinite(activity.lastUsedAt) &&
                activity.lastUsedAt > 0
                  ? activity.lastUsedAt
                  : null,
            },
          ],
        ];
      }),
    );
  } catch {
    return {};
  }
}

export function updateTemplateLibrary(
  id: string,
  action: "favorite" | "use" | "remove",
): TemplateLibrary {
  const next = readTemplateLibrary();
  const current = Object.hasOwn(next, id)
    ? next[id]
    : { favorite: false, lastUsedAt: null };
  if (action === "remove") delete next[id];
  else
    Object.defineProperty(next, id, {
      value:
        action === "favorite"
          ? { ...current, favorite: !current.favorite }
          : { ...current, lastUsedAt: Date.now() },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}
