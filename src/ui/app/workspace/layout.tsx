import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Presentation } from "../../../../src-tauri/src/domain/bindings/Presentation";
import { sameCursor } from "../../../platform/NativeDocumentClient";
import {
  flushDraftBeforeVersionAction,
  nativeClient,
  runDraftAuthorityAction,
  snapshotFromLoadedDocument,
} from "../../../platform/workspace";
import { EngineFitClient } from "../../../preview/engineFit";
import {
  type ImportedTemplate
} from "../../domain/imported-template";
import type {
  ResumeLayout
} from "../../domain/resume-model";
import {
  normalizePresentation,
  type KnownTemplateId,
  type ResumePresentation
} from "../../domain/template-model";
import { templateRegistry } from "../../templates/registry";
export async function runPlanOnePage(context: {
  engineFitOriginalRef: RefObject<{ presentation: Presentation; contentKey: string; } | null>;
  setPresentation: Dispatch<SetStateAction<ResumePresentation>>;
  applyLayoutSnapshot: (layout: ResumeLayout) => void;
  engineFitClient: EngineFitClient;
}, isCancelled: () => boolean, finalizing = false): Promise<boolean> {
  const { engineFitOriginalRef, setPresentation, applyLayoutSnapshot, engineFitClient } = context;

  await flushDraftBeforeVersionAction();
  if (isCancelled()) return false;
  const frozen = nativeClient.snapshot;
  if (!frozen) throw new Error("本地文档尚未载入");
  const contentKey = (state: typeof frozen) => JSON.stringify([
    state.cursor.documentId, state.cursor.contextId, state.cursor.branchId, state.cursor.headId,
    state.document.title, state.document.basic, state.document.sections, state.document.sourceRef,
  ]);
  if (!finalizing) engineFitOriginalRef.current = {
    presentation: structuredClone(frozen.document.presentation), contentKey: contentKey(frozen),
  };
  const restoreLayout = async () => {
    const original = engineFitOriginalRef.current;
    await flushDraftBeforeVersionAction();
    await runDraftAuthorityAction(async () => {
      const current = nativeClient.snapshot;
      if (!original || !current || isCancelled() || contentKey(current) !== original.contentKey) return;
      const restored = await nativeClient.submit({ type: "setLayout", presentation: original.presentation });
      const snapshot = await snapshotFromLoadedDocument(restored.document);
      if (isCancelled()) return;
      setPresentation(normalizePresentation(snapshot.presentation));
      applyLayoutSnapshot(snapshot.layout);
    });
  };
  try {
    const proposal = await engineFitClient.request(frozen.cursor);
    if (!proposal || isCancelled()) return false;
    await flushDraftBeforeVersionAction();
    const current = nativeClient.snapshot;
    if (!current || isCancelled() || !sameCursor(current.cursor, frozen.cursor)) return false;
    if (proposal.plan.status === "alreadyFits") {
      if (finalizing) engineFitOriginalRef.current = null;
      return true;
    }
    if (proposal.plan.status !== "fitted") {
      if (finalizing) await restoreLayout();
      return false;
    }
    let applied = false;
    await runDraftAuthorityAction(async () => {
      const queued = nativeClient.snapshot;
      if (!queued || isCancelled() || !sameCursor(queued.cursor, frozen.cursor)) return;
      const result = await engineFitClient.apply(proposal, queued.cursor);
      if (!result) return;
      // Once dispatched, CAS may commit even after cancellation. Reload its
      // cursor before a queued manual save, while leaving cancelled UI intact.
      const loaded = await nativeClient.reload();
      if (!sameCursor(loaded.cursor, result.cursor)) return;
      const snapshot = await snapshotFromLoadedDocument(result.document);
      if (isCancelled() || !sameCursor(nativeClient.snapshot!.cursor, result.cursor)) return;
      setPresentation(normalizePresentation(snapshot.presentation));
      applyLayoutSnapshot(snapshot.layout);
      if (finalizing) engineFitOriginalRef.current = null;
      applied = true;
    });
    return applied;
  } catch (error) {
    if (finalizing && !isCancelled()) await restoreLayout();
    engineFitOriginalRef.current = null;
    throw error;
  }

}

export function runMakeLayout(context: Omit<ResumeLayout, "lineHeight" | "moduleSpacing">, lineHeight: string, moduleSpacing: string): ResumeLayout {
  const { font, fontSize, pageMargin, theme, dateFormat, titleFormat, separator, textAlign } = context;
  return ({
    font, fontSize, lineHeight, moduleSpacing, pageMargin, theme, dateFormat, titleFormat, separator, textAlign,
  });
}

export function runApplyFormatPreset(context: {
  setPresentation: Dispatch<SetStateAction<ResumePresentation>>;
  applyTemplateDefaults: (templateId: KnownTemplateId) => void;
  setTheme: Dispatch<SetStateAction<string>>;
  setFormatAutoFitRevision: Dispatch<SetStateAction<number>>;
}, templateId: KnownTemplateId, importedAccent?: string, importedLayout?: ImportedTemplate["layout"], sideBandBackground?: string, sideBandForeground?: string, autoFit = true): void {
  const { setPresentation, applyTemplateDefaults, setTheme, setFormatAutoFitRevision } = context;

  const template = templateRegistry[templateId];
  setPresentation({
    templateId,
    templateVersion: template.version,
    densityPreset: template.defaultDensity,
    overrides: importedLayout
      ? {
        importedLayout,
        ...(sideBandBackground
          ? { importedSideBandBackground: sideBandBackground }
          : {}),
        ...(sideBandForeground
          ? { importedSideBandForeground: sideBandForeground }
          : {}),
      }
      : {},
  });
  applyTemplateDefaults(templateId);
  if (importedAccent) setTheme(importedAccent);
  if (autoFit) setFormatAutoFitRevision((revision) => revision + 1);

}
