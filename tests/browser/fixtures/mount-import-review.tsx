import { createRoot } from "react-dom/client";
import { nativeClient } from "../../../src/platform/workspace";
import { TemplateWorkspace } from "../../../src/ui/templates/TemplateWorkspace";
import type { ImportDraft } from "../../../src-tauri/src/domain/bindings/ImportDraft";
import type { ImportCandidateCorrection } from "../../../src-tauri/src/domain/bindings/ImportCandidateCorrection";
import "../../../src/ui/styles/index.css";

// The import review dialog is gated on the Tauri runtime, so this fixture
// exposes a scripted __TAURI_INTERNALS__ instead of registerPlatformInvoke.
// isTauriRuntime() is evaluated lazily, so defining it in the module body is
// sufficient for every later nativeInvoke call.
type ImportFixture = {
  draft: ImportDraft | null;
  applies: Array<{
    draftId: string;
    acceptedCandidateIds: string[];
    corrections: ImportCandidateCorrection[];
  }>;
  forceNullText: boolean;
};
const fixture: ImportFixture = { draft: null, applies: [], forceNullText: false };
Object.assign(window, { importReviewFixture: fixture });

const cursor = {
  documentId: "import-review-ui",
  contextId: "same-context",
  branchId: "main",
  headId: null,
  revision: "0",
};

async function mockInvoke(command: string, args: Record<string, any> = {}): Promise<unknown> {
  if (command === "document_state") {
    return { cursor, document: { schemaVersion: 2, documentId: cursor.documentId }, epoch: 4 };
  }
  if (command === "current_account") return null;
  const request = (args.request ?? {}) as Record<string, any>;
  if (command === "create_import_draft") {
    fixture.draft = {
      id: request.draftId,
      sourceKind: request.sourceKind,
      displayName: request.displayName,
      sourceHash: request.sourceHash,
      createdAt: "2026-10-29T00:00:00.000Z",
      status: "queued",
      previewAssetId: null,
      candidates: [],
      warnings: [],
      unsupportedFeatures: [],
      extractedText: null,
    };
    return structuredClone(fixture.draft);
  }
  if (command === "transition_import_draft") {
    if (!fixture.draft) throw new Error("transition before create");
    const draft = structuredClone(fixture.draft);
    if (draft.status !== request.expectedStatus) throw new Error("stale fixture transition");
    if (request.nextStatus === "review_required") {
      draft.candidates = request.candidates ?? [];
      draft.warnings = request.warnings ?? [];
      draft.unsupportedFeatures = request.unsupportedFeatures ?? [];
      draft.previewAssetId = request.previewDataUrl ? "a".repeat(64) : null;
      draft.extractedText = fixture.forceNullText ? null : (request.extractedText ?? null);
    }
    draft.status = request.nextStatus;
    fixture.draft = draft;
    return structuredClone(draft);
  }
  if (command === "get_import_draft") {
    return fixture.draft ? structuredClone(fixture.draft) : null;
  }
  throw new Error(`Unexpected import review fixture command: ${command}`);
}

(window as any).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: Record<string, any>) => mockInvoke(command, args),
};

await nativeClient.load();
createRoot(document.getElementById("root")!).render(
  <TemplateWorkspace
    importedTemplates={[]}
    currentTemplateId="legacy-v1"
    currentPageCount={1}
    selectedTemplateId={null}
    onApplyImported={async () => false}
    prepareImportTarget={async () => ({
      cursor,
      sessionEpoch: nativeClient.currentSessionEpoch,
      hostEpoch: 4,
    })}
    onApplyImport={async (draftId, acceptedCandidateIds, corrections) => {
      fixture.applies.push({
        draftId,
        acceptedCandidateIds: [...acceptedCandidateIds],
        corrections: structuredClone(corrections),
      });
    }}
    onRenameImported={() => {}}
    onBack={() => {}}
  />,
);
