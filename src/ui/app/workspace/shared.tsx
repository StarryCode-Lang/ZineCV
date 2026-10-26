import {
  lazy
} from "react";
import type {
  SectionKey
} from "../../domain/resume-model";
import {
  moduleTitles
} from "../../domain/resume-model";
export const TemplateWorkspace = lazy(() =>
  import("../../templates/TemplateWorkspace").then((module) => ({
    default: module.TemplateWorkspace,
  })),
);

export const VersionControlPanel = lazy(() =>
  import("../../versioning/VersionControlPanel").then((module) => ({
    default: module.VersionControlPanel,
  })),
);

export const workspaceLoading = (
  <div role="status" className="workspace-loading">
    正在载入工作区…
  </div>
);

export function collapsedSectionsFromSettings(
  values: string[],
): Set<"basic" | SectionKey> {
  return new Set(
    values.filter(
      (value): value is "basic" | SectionKey =>
        value === "basic" || value === "summary" || value in moduleTitles,
    ),
  );
}

export const isHexColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[\da-fA-F]{6}$/.test(value);

export function downloadJsonBlob(fileName: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
export type TailParameters<F extends (...args: never[]) => unknown> = Parameters<F> extends [unknown, ...infer R] ? R : never;
