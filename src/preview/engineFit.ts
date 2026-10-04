import type { AuthorityCursor } from "../../src-tauri/src/domain/bindings/AuthorityCursor";
import type { CommandResult } from "../../src-tauri/src/domain/bindings/CommandResult";
import type { FitResult } from "../../src-tauri/src/domain/bindings/FitResult";
import type { NativeInvoke } from "../platform/ipc";

const cursorKeys = ["documentId", "contextId", "revision", "branchId", "headId"] as const;
const sameCursor = (a: AuthorityCursor, b: AuthorityCursor) => cursorKeys.every(key => a[key] === b[key]);
const layoutKeys = new Set(["fontSizePt", "lineHeightPt", "headingSizePt", "pageMarginPt", "moduleGapPt", "paragraphGapPt", "listGapPt"]);

function verifyFit(result: FitResult, cursor: AuthorityCursor): void {
  const plan = result.plan;
  if (!sameCursor(result.cursor, cursor) || !/^[a-f0-9]{64}$/.test(result.renderKey)
      || !/^[a-f0-9]{64}$/.test(plan.semanticHash) || plan.attempts.length > 16
      || plan.attempts.some((attempt, index) => attempt.candidateIndex !== index
        || !Number.isInteger(attempt.pageCount) || attempt.pageCount < 1 || attempt.pageCount > 200)) {
    throw new Error("Fit proposal does not match the frozen document");
  }
  const successful = ["fitted", "alreadyFits"].includes(plan.status);
  if (!["fitted", "alreadyFits", "noFit", "unreadable", "cancelled", "timedOut"].includes(plan.status)
      || successful !== Boolean(plan.fittedPresentation)) throw new Error("Invalid fit outcome");
  if (!successful) return;
  const fitted = plan.fittedPresentation!;
  if (plan.attempts.at(-1)?.pageCount !== 1
      || [...layoutKeys].some(key => !Number.isFinite(fitted[key as keyof typeof fitted]))
      || fitted.fontSizePt < 9 || fitted.headingSizePt < 9.75 || fitted.lineHeightPt < fitted.fontSizePt
      || fitted.pageMarginPt < 18 || fitted.moduleGapPt < 0 || fitted.paragraphGapPt < 0 || fitted.listGapPt < 0
      || Object.keys(plan.originalPresentation).some(key => !layoutKeys.has(key)
        && JSON.stringify(fitted[key as keyof typeof fitted]) !== JSON.stringify(plan.originalPresentation[key as keyof typeof fitted]))) {
    throw new Error("Fit proposal changes protected presentation fields or readability");
  }
}

/** Planning is read-only. Cancellation drops late proposals; an already dispatched
 * domain commit remains governed by the authoritative CAS and is not rolled back. */
export class EngineFitClient {
  private epoch = 0;
  private active = false;
  private pending: { cursor: AuthorityCursor; epoch: number; resolve: (result: FitResult | null) => void; reject: (error: unknown) => void } | null = null;
  private readonly proposals = new WeakMap<FitResult, number>();
  private readonly invoke: NativeInvoke;
  private readonly commandId: () => string;
  constructor(invoke: NativeInvoke, commandId = () => crypto.randomUUID()) {
    this.invoke = invoke;
    this.commandId = commandId;
  }

  cancel(): void {
    this.epoch += 1;
    this.pending?.resolve(null);
    this.pending = null;
  }

  request(cursor: AuthorityCursor): Promise<FitResult | null> {
    this.pending?.resolve(null);
    const epoch = ++this.epoch;
    return new Promise((resolve, reject) => {
      this.pending = { cursor: structuredClone(cursor), epoch, resolve, reject };
      void this.pump();
    });
  }

  async apply(result: FitResult, current: AuthorityCursor): Promise<CommandResult | null> {
    if (this.proposals.get(result) !== this.epoch || !sameCursor(result.cursor, current)) return null;
    verifyFit(result, current);
    if (result.plan.status !== "fitted") return null;
    // Consume once before dispatch. Duplicate clicks cannot create extra revisions.
    this.proposals.delete(result);
    return await this.invoke("apply_document_command", { envelope: {
      protocolVersion: 1, commandId: this.commandId(), documentId: result.cursor.documentId,
      contextId: result.cursor.contextId, expectedRevision: result.cursor.revision,
      expectedBranchId: result.cursor.branchId, expectedHeadId: result.cursor.headId,
      payload: { type: "setLayout", presentation: structuredClone(result.plan.fittedPresentation!) },
    } }) as CommandResult;
  }

  private async pump(): Promise<void> {
    if (this.active || !this.pending) return;
    const request = this.pending;
    this.pending = null;
    this.active = true;
    try {
      const result = await this.invoke("fit_document_one_page", { cursor: request.cursor }) as FitResult;
      if (request.epoch !== this.epoch) request.resolve(null);
      else {
        verifyFit(result, request.cursor);
        this.proposals.set(result, request.epoch);
        request.resolve(result);
      }
    } catch (error) {
      if (request.epoch !== this.epoch) request.resolve(null);
      else request.reject(error);
    } finally {
      this.active = false;
      void this.pump();
    }
  }
}
