import type { ResumeDocument } from "../../../../src-tauri/src/domain/bindings/ResumeDocument";
import type { DocumentTarget } from "../../../platform/NativeDocumentClient";
import { canonicalJsonValue } from "../../../platform/documentBridge";
import { restoreLegacySource } from "../../../platform/legacySourceArchive";
import type { ResumeVersionSnapshot } from "../../domain/version-model";

export async function loadLegacyDraftWithArchive(snapshot: ResumeVersionSnapshot, context: {
  captureTarget: () => DocumentTarget;
  assertTarget: (target: DocumentTarget) => void;
  currentDocument: () => ResumeDocument | null;
  flush: () => Promise<void>;
  withAuthority: (action: () => Promise<void>) => Promise<void>;
  saveExtensions: (extensions: Record<string, unknown>, target: DocumentTarget) => Promise<unknown>;
  applySnapshot: (value: ResumeVersionSnapshot) => void;
}): Promise<void> {
  const target = context.captureTarget();
  await context.flush();
  context.assertTarget(target);
  await context.withAuthority(async () => {
    context.assertTarget(target);
    const current = context.currentDocument();
    if (!current) throw new Error("本机文档尚未载入");
    const restored = restoreLegacySource(current, snapshot);
    if (canonicalJsonValue(restored.legacyExtensions) !== canonicalJsonValue(current.legacyExtensions)) {
      await context.saveExtensions(restored.legacyExtensions, target);
    }
    context.assertTarget(target);
    context.applySnapshot(snapshot);
  });
}
