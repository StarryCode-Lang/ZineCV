import type { AuthorityCursor } from "../../src-tauri/src/domain/bindings/AuthorityCursor";
import type { CommandEnvelope } from "../../src-tauri/src/domain/bindings/CommandEnvelope";
import type { CommandResult } from "../../src-tauri/src/domain/bindings/CommandResult";
import type { ApplyImportRequest } from "../../src-tauri/src/domain/bindings/ApplyImportRequest";
import type { DomainCommand } from "../../src-tauri/src/domain/bindings/DomainCommand";
import type { ResumeDocument } from "../../src-tauri/src/domain/bindings/ResumeDocument";
import type { NativeInvoke } from "./ipc";
import type { SwitchEditingContextRequest } from "../../src-tauri/src/domain/bindings/SwitchEditingContextRequest";
import type { SwitchEditingContextResult } from "../../src-tauri/src/domain/bindings/SwitchEditingContextResult";

export type DocumentState = { cursor: AuthorityCursor; document: ResumeDocument };
export type SaveStatus = "idle" | "saving" | "saved" | "failed";

function isNewerRevision(next: string, previous: string): boolean {
  return next.length > previous.length ||
    (next.length === previous.length && next > previous);
}

function sameCursor(left: AuthorityCursor, right: AuthorityCursor): boolean {
  return left.documentId === right.documentId &&
    left.contextId === right.contextId &&
    left.revision === right.revision &&
    left.branchId === right.branchId &&
    left.headId === right.headId;
}

export class NativeDocumentClient {
  private readonly invoke: NativeInvoke;
  private readonly newCommandId: () => string;
  private current: DocumentState | null = null;
  private tail: Promise<void> = Promise.resolve();
  private failed: unknown = null;
  private failedEnvelope: CommandEnvelope | null = null;
  private failedImportRequest: ApplyImportRequest | null = null;
  private status: SaveStatus = "idle";
  private sessionEpoch = 0;
  private readonly listeners = new Set<(status: SaveStatus) => void>();

  constructor(
    invoke: NativeInvoke,
    newCommandId: () => string = () => crypto.randomUUID(),
  ) {
    this.invoke = invoke;
    this.newCommandId = newCommandId;
  }

  get snapshot(): DocumentState | null {
    return this.current ? structuredClone(this.current) : null;
  }

  get currentSessionEpoch(): number {
    return this.sessionEpoch;
  }

  get saveStatus(): SaveStatus {
    return this.status;
  }

  subscribe(listener: (status: SaveStatus) => void): () => void {
    this.listeners.add(listener);
    try { listener(this.status); } catch { /* UI observers cannot change document authority. */ }
    return () => this.listeners.delete(listener);
  }

  async load(): Promise<DocumentState> {
    if (this.failedEnvelope) {
      throw new Error("Document has an unresolved command");
    }
    // StrictMode 下引导可能触发两次；幂等返回已加载的权威状态。
    if (this.current) {
      return this.snapshot!;
    }
    const epoch = this.sessionEpoch;
    const state = await this.invoke("document_state") as DocumentState;
    if (epoch !== this.sessionEpoch) throw new Error("Document load response is stale");
    this.validateState(state);
    this.current = structuredClone(state);
    this.setStatus("idle");
    return this.snapshot!;
  }

  // 版本操作（提交/切分支/删除）由 Rust 推进 cursor 后，前端以权威状态重新同步。
  async reload(): Promise<DocumentState> {
    if (this.failed) throw this.failed;
    if (!this.current) return this.load();
    const operation = this.tail.then(async () => {
      if (this.failed) throw this.failed;
      const epoch = this.sessionEpoch;
      const previous = this.current;
      const state = await this.invoke("document_state") as DocumentState;
      if (epoch !== this.sessionEpoch) throw new Error("Document reload response is stale");
      this.validateState(state);
      if (previous && (state.cursor.contextId !== previous.cursor.contextId ||
          state.cursor.branchId !== previous.cursor.branchId)) {
        this.sessionEpoch += 1;
      }
      this.current = structuredClone(state);
      this.setStatus("idle");
      return this.snapshot!;
    });
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }

  switchEditingContext(
    request: SwitchEditingContextRequest,
  ): Promise<SwitchEditingContextResult> {
    const immutableRequest = structuredClone(request);
    const operation = this.tail.then(async () => {
      if (this.failed) throw this.failed;
      if (!this.current) throw new Error("Document has not been loaded");
      const expected = immutableRequest.expectedCursor;
      const currentCursor = this.current.cursor;
      if (currentCursor.documentId !== expected.documentId ||
          currentCursor.contextId !== expected.contextId ||
          currentCursor.revision !== expected.revision ||
          currentCursor.branchId !== expected.branchId ||
          currentCursor.headId !== expected.headId) {
        throw new Error("Editing context changed before the switch was committed");
      }
      const prior = this.current;
      const epoch = ++this.sessionEpoch;
      this.setStatus("saving");
      try {
        const raw = await this.invoke("switch_editing_context", { request: immutableRequest }) as SwitchEditingContextResult;
        if (epoch !== this.sessionEpoch || this.current !== prior) {
          throw new Error("Editing context switch response is stale");
        }
        this.validateState({ cursor: raw?.cursor, document: raw?.document });
        if (raw.cursor.documentId !== prior.cursor.documentId ||
            !isNewerRevision(raw.cursor.revision, prior.cursor.revision) ||
            raw.created !== false && raw.created !== true) {
          throw new Error("Native document service returned an invalid context switch");
        }
        this.current = structuredClone({ cursor: raw.cursor, document: raw.document });
        this.failed = null;
        this.failedEnvelope = null;
        this.setStatus("saved");
        return structuredClone(raw);
      } catch (error) {
        if (epoch === this.sessionEpoch && this.current === prior) {
          this.setStatus("idle");
        }
        throw error instanceof Error ? error : new Error(String(error));
      }
    });
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }

  submit(payload: DomainCommand): Promise<CommandResult> {
    const immutablePayload = structuredClone(payload);
    const operation = this.tail.then(async () => {
      if (this.failed) throw this.failed;
      if (!this.current) throw new Error("Document has not been loaded");
      const cursor = this.current.cursor;
      const epoch = this.sessionEpoch;
      const envelope: CommandEnvelope = {
        protocolVersion: 1,
        commandId: this.newCommandId(),
        documentId: cursor.documentId,
        contextId: cursor.contextId,
        expectedRevision: cursor.revision,
        expectedBranchId: cursor.branchId,
        expectedHeadId: cursor.headId,
        payload: immutablePayload,
      };
      this.failedEnvelope = envelope;
      this.setStatus("saving");
      return this.send(envelope, false, epoch);
    });
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }

  async retryFailed(): Promise<CommandResult> {
    await this.tail;
    if (this.failedImportRequest && this.failed) {
      this.setStatus("saving");
      const operation = this.sendImport(this.failedImportRequest, true, this.sessionEpoch);
      this.tail = operation.then(() => {}, () => {});
      return operation;
    }
    if (!this.failedEnvelope || !this.failed) {
      throw new Error("No failed command is available for retry");
    }
    this.setStatus("saving");
    const operation = this.send(this.failedEnvelope, true, this.sessionEpoch);
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }

  applyImport(
    draftId: string,
    acceptedCandidateIds: string[],
    expectedCursor: AuthorityCursor,
  ): Promise<CommandResult> {
    const immutableDraftId = draftId;
    const immutableCandidateIds = [...acceptedCandidateIds];
    const operation = this.tail.then(async () => {
      if (this.failed) throw this.failed;
      if (!this.current) throw new Error("Document has not been loaded");
      if (!sameCursor(this.current.cursor, expectedCursor)) {
        throw new Error("Import target changed after the candidates were prepared");
      }
      const request: ApplyImportRequest = {
        commandId: this.newCommandId(),
        cursor: structuredClone(expectedCursor),
        draftId: immutableDraftId,
        acceptedCandidateIds: immutableCandidateIds,
      };
      this.failedImportRequest = request;
      this.setStatus("saving");
      return this.sendImport(request, false, this.sessionEpoch);
    });
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }

  async flush(): Promise<DocumentState> {
    await this.tail;
    if (this.failed) throw this.failed;
    if (!this.current) throw new Error("Document has not been loaded");
    return this.snapshot!;
  }

  private async send(
    envelope: CommandEnvelope,
    reconcile = false,
    epoch = this.sessionEpoch,
  ): Promise<CommandResult> {
    try {
      const result = await this.invoke("apply_document_command", { envelope }) as CommandResult;
      if (epoch !== this.sessionEpoch) throw new Error("Document command response is stale");
      if (!this.current || result?.commandId !== envelope.commandId || result.durable !== true) {
        throw new Error("Native document service did not confirm a durable command");
      }
      this.validateState({ cursor: result.cursor, document: result.document });
      if (!isNewerRevision(result.cursor.revision, envelope.expectedRevision)) {
        throw new Error("Native document service returned an invalid receipt revision");
      }
      if (result.cursor.documentId !== envelope.documentId ||
          result.cursor.contextId !== envelope.contextId) {
        throw new Error("Native document service changed the command target");
      }
      let state: DocumentState = { cursor: result.cursor, document: result.document };
      if (reconcile || !isNewerRevision(result.cursor.revision, this.current.cursor.revision)) {
        state = await this.invoke("document_state") as DocumentState;
        if (epoch !== this.sessionEpoch) throw new Error("Document receipt reload is stale");
        this.validateState(state);
        if (state.cursor.documentId !== envelope.documentId ||
            state.cursor.contextId !== envelope.contextId ||
            isNewerRevision(result.cursor.revision, state.cursor.revision) ||
            isNewerRevision(this.current.cursor.revision, state.cursor.revision)) {
          throw new Error("Native document service returned an inconsistent receipt state");
        }
      }
      this.current = structuredClone(state);
      this.failed = null;
      this.failedEnvelope = null;
      this.failedImportRequest = null;
      this.setStatus("saved");
      return result;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (epoch === this.sessionEpoch) {
        this.failed = failure;
        this.setStatus("failed");
      }
      throw failure;
    }
  }

  private async sendImport(
    request: ApplyImportRequest,
    reconcile = false,
    epoch = this.sessionEpoch,
  ): Promise<CommandResult> {
    const prior = this.current;
    if (!prior) throw new Error("Document has not been loaded");
    try {
      const result = await this.invoke("apply_import", { request }) as CommandResult;
      if (epoch !== this.sessionEpoch || this.current !== prior) {
        throw new Error("Import response belongs to an inactive editing context");
      }
      if (result?.commandId !== request.commandId || result.durable !== true) {
        throw new Error("Native import service did not confirm a durable command");
      }
      this.validateState({ cursor: result.cursor, document: result.document });
      if (!isNewerRevision(result.cursor.revision, request.cursor.revision) ||
          result.cursor.documentId !== request.cursor.documentId ||
          result.cursor.contextId !== request.cursor.contextId ||
          result.cursor.branchId !== request.cursor.branchId) {
        throw new Error("Native import service returned an invalid target or revision");
      }
      let state: DocumentState = { cursor: result.cursor, document: result.document };
      if (reconcile || !isNewerRevision(result.cursor.revision, prior.cursor.revision)) {
        state = await this.invoke("document_state") as DocumentState;
        if (epoch !== this.sessionEpoch || this.current !== prior) {
          throw new Error("Import receipt reload belongs to an inactive editing context");
        }
        this.validateState(state);
        if (state.cursor.documentId !== request.cursor.documentId ||
            state.cursor.contextId !== request.cursor.contextId ||
            isNewerRevision(result.cursor.revision, state.cursor.revision) ||
            isNewerRevision(prior.cursor.revision, state.cursor.revision)) {
          throw new Error("Native import service returned an inconsistent receipt state");
        }
      }
      this.current = structuredClone(state);
      this.failed = null;
      this.failedEnvelope = null;
      this.failedImportRequest = null;
      this.setStatus("saved");
      return result;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (epoch === this.sessionEpoch && this.current === prior) {
        this.failed = failure;
        this.setStatus("failed");
      }
      throw failure;
    }
  }

  private validateState(state: DocumentState): void {
    if (!state?.cursor || !state.document ||
        state.document.schemaVersion !== 2 ||
        state.cursor.documentId !== state.document.documentId ||
        state.cursor.contextId.trim() === "" ||
        !/^(0|[1-9]\d*)$/.test(state.cursor.revision)) {
      throw new Error("Native document service returned an invalid document state");
    }
  }

  private setStatus(status: SaveStatus): void {
    this.status = status;
    for (const listener of this.listeners) {
      try { listener(status); } catch { /* UI observers cannot change a durable receipt. */ }
    }
  }
}
