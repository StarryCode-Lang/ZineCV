import { isTauriRuntime, nativeInvoke } from "../../platform/ipc";

type TemplateActivity = { favorite: boolean; lastUsedAt: number | null };
export type TemplateLibrary = Record<string, TemplateActivity>;
const STORAGE_KEY = "resume-diy-template-library-v1";
let nativeLibrary: TemplateLibrary | null = null;
type NativeActivity = { templateId: string; favorite: boolean; lastUsedAt: number | null };

function parseTemplateLibrary(serialized: string): TemplateLibrary {
  try {
    const value: unknown = JSON.parse(serialized);
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

export function readTemplateLibrary(): TemplateLibrary {
  if (isTauriRuntime()) return nativeLibrary ?? {};
  return parseTemplateLibrary(localStorage.getItem(STORAGE_KEY) ?? "{}");
}

export async function loadTemplateLibrary(): Promise<TemplateLibrary> {
  if (!isTauriRuntime()) return readTemplateLibrary();
  const legacy = parseTemplateLibrary(localStorage.getItem(STORAGE_KEY) ?? "{}");
  const rows = (await nativeInvoke("bootstrap_template_activity", {
    legacyJson: JSON.stringify(legacy),
  })) as NativeActivity[];
  nativeLibrary = Object.fromEntries(
    rows.map(({ templateId, favorite, lastUsedAt }) => [templateId, { favorite, lastUsedAt }]),
  );
  return nativeLibrary;
}

export async function updateTemplateLibrary(
  id: string,
  action: "favorite" | "use" | "remove",
): Promise<TemplateLibrary> {
  if (isTauriRuntime()) {
    const row = (await nativeInvoke("update_template_activity", { id, action })) as NativeActivity | null;
    const next = { ...readTemplateLibrary() };
    if (row) next[id] = { favorite: row.favorite, lastUsedAt: row.lastUsedAt };
    else delete next[id];
    nativeLibrary = next;
    return next;
  }
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
  const serialized = JSON.stringify(next);
  localStorage.setItem(STORAGE_KEY, serialized);
  return next;
}
