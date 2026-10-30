import type { AuthorityCursor } from "../../src-tauri/src/domain/bindings/AuthorityCursor";
import type { CommandEnvelope } from "../../src-tauri/src/domain/bindings/CommandEnvelope";
import type { CommandResult } from "../../src-tauri/src/domain/bindings/CommandResult";
import type { ApplyImportRequest } from "../../src-tauri/src/domain/bindings/ApplyImportRequest";
import type { ImportCandidateCorrection } from "../../src-tauri/src/domain/bindings/ImportCandidateCorrection";
import type { DomainCommand } from "../../src-tauri/src/domain/bindings/DomainCommand";
import type { NativeInvoke } from "./ipc";
import type { SwitchEditingContextRequest } from "../../src-tauri/src/domain/bindings/SwitchEditingContextRequest";
import type { SwitchEditingContextResult } from "../../src-tauri/src/domain/bindings/SwitchEditingContextResult";
import type { CreateDocumentRequest } from "../../src-tauri/src/domain/bindings/CreateDocumentRequest";
import type { CreateDocumentResult } from "../../src-tauri/src/domain/bindings/CreateDocumentResult";
import type { SwitchActiveDocumentRequest } from "../../src-tauri/src/domain/bindings/SwitchActiveDocumentRequest";
import type { SwitchActiveDocumentResult } from "../../src-tauri/src/domain/bindings/SwitchActiveDocumentResult";
import { documentsEqual } from "./documentBridge";
import type { ActiveDocumentState } from "../../src-tauri/src/domain/bindings/ActiveDocumentState";

export type DocumentState = Pick<ActiveDocumentState, "cursor" | "document"> &
  Partial<Pick<ActiveDocumentState, "meta" | "recentExports" | "pendingImportCount">> & { epoch?: number | bigint };
export type DocumentTarget = { cursor: AuthorityCursor; sessionEpoch: number };
export type SaveStatus = "idle" | "saving" | "saved" | "failed";

function isNewerRevision(next: string, previous: string): boolean {
  return next.length > previous.length ||
    (next.length === previous.length && next > previous);
}

export function sameCursor(left: AuthorityCursor, right: AuthorityCursor): boolean {
  return left.documentId === right.documentId &&
    left.contextId === right.contextId &&
    left.revision === right.revision &&
    left.branchId === right.branchId &&
    left.headId === right.headId;
}

function transportEpoch(value: number | bigint): number {
  if ((typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) ||
      (typeof value === "bigint" && (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)))) {
    throw new Error("Document epoch is not a safe transport integer");
  }
  return Number(value);
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

  captureTarget(): DocumentTarget {
    if (!this.current) throw new Error("Document has not been loaded");
    return { cursor: structuredClone(this.current.cursor), sessionEpoch: this.sessionEpoch };
  }

  assertTarget(target: DocumentTarget): void {
    const cursor = this.current?.cursor;
    // Earlier writes in this same queue may advance revision. They cannot
    // change the captured document, context, branch, head or session lineage.
    if (!cursor || target.sessionEpoch !== this.sessionEpoch ||
        cursor.documentId !== target.cursor.documentId || cursor.contextId !== target.cursor.contextId ||
        cursor.branchId !== target.cursor.branchId || cursor.headId !== target.cursor.headId ||
        isNewerRevision(target.cursor.revision, cursor.revision)) {
      throw new Error("Document target changed after the operation was scheduled");
    }
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
    this.installState(state);
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
      if (previous && (state.cursor.documentId !== previous.cursor.documentId ||
          state.cursor.contextId !== previous.cursor.contextId || state.cursor.branchId !== previous.cursor.branchId ||
          state.cursor.headId !== previous.cursor.headId ||
          state.epoch !== undefined && previous.epoch !== undefined && transportEpoch(state.epoch) !== transportEpoch(previous.epoch))) {
        this.sessionEpoch += 1;
      }
      this.installState(state);
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
    const scheduledTarget = this.current ? this.captureTarget() : null;
    const operation = this.tail.then(async () => {
      if (this.failed) throw this.failed;
      if (!this.current) throw new Error("Document has not been loaded");
      if (!scheduledTarget) throw new Error("Document was not loaded when the operation was scheduled");
      this.assertTarget(scheduledTarget);
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
        const unchanged = raw.created === false && sameCursor(raw.cursor, prior.cursor) &&
          documentsEqual(raw.document, prior.document);
        if (raw.cursor.documentId !== prior.cursor.documentId ||
            (!unchanged && !isNewerRevision(raw.cursor.revision, prior.cursor.revision)) ||
            raw.created !== false && raw.created !== true) {
          throw new Error("Native document service returned an invalid context switch");
        }
        this.installState({ cursor: raw.cursor, document: raw.document });
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

  /// M3：切换 active 文档。调用前调用方必须完成 flush（编辑缓冲 + 草稿 +
  /// 本队列），因此切换操作运行时队列已排空。epoch 在发出前递增，使一切
  /// 在途响应立刻过期；失败时 current 保持原文档，内容不迁移。
  switchDocument(
    request: SwitchActiveDocumentRequest,
  ): Promise<SwitchActiveDocumentResult> {
    const immutableRequest = structuredClone(request);
    const scheduledTarget = this.current ? this.captureTarget() : null;
    const operation = this.tail.then(async () => {
      if (this.failed) throw new Error("Document has an unresolved command");
      if (!this.current) throw new Error("Document has not been loaded");
      if (!scheduledTarget) throw new Error("Document was not loaded when the operation was scheduled");
      this.assertTarget(scheduledTarget);
      if (immutableRequest.expectedCurrentId !== this.current.cursor.documentId) throw new Error("Document switch target changed");
      const expectedEpoch = transportEpoch(immutableRequest.expectedEpoch);
      if (this.current.epoch !== undefined && expectedEpoch !== transportEpoch(this.current.epoch)) throw new Error("Document switch epoch changed");
      const prior = this.current;
      const epoch = ++this.sessionEpoch;
      this.setStatus("saving");
      try {
        const raw = await this.invoke("switch_active_document", { request: { ...immutableRequest, expectedEpoch } }) as SwitchActiveDocumentResult;
        if (epoch !== this.sessionEpoch || this.current !== prior) {
          throw new Error("Document switch response is stale");
        }
        this.validateState({ cursor: raw?.cursor, document: raw?.document });
        if (raw.documentId !== immutableRequest.targetDocumentId || raw.cursor.documentId !== immutableRequest.targetDocumentId) {
          throw new Error("Native document service returned an invalid switch");
        }
        this.installState(raw);
        this.failed = null;
        this.failedEnvelope = null;
        this.failedImportRequest = null;
        this.setStatus("saved");
        return structuredClone(raw);
      } catch (error) {
        if (this.current === prior) this.setStatus("idle");
        throw error instanceof Error ? error : new Error(String(error));
      }
    });
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }

  /// M3：新建文档（空白/复制）——宿主创建后立即切换为 active；调用方必须已 flush。
  createDocument(request: CreateDocumentRequest): Promise<CreateDocumentResult> {
    const immutableRequest = structuredClone(request);
    const scheduledTarget = this.current ? this.captureTarget() : null;
    const operation = this.tail.then(async () => {
      if (this.failed) throw new Error("Document has an unresolved command");
      if (!this.current) throw new Error("Document has not been loaded");
      if (!scheduledTarget) throw new Error("Document was not loaded when the operation was scheduled");
      this.assertTarget(scheduledTarget);
      const prior = this.current;
      const epoch = ++this.sessionEpoch;
      this.setStatus("saving");
      try {
        const raw = await this.invoke("document_create", {
          request: { ...immutableRequest, expectedEpoch: transportEpoch(immutableRequest.expectedEpoch) },
        }) as CreateDocumentResult;
        if (epoch !== this.sessionEpoch || this.current !== prior) {
          throw new Error("Document create response is stale");
        }
        if (raw?.receipt?.commandId !== immutableRequest.commandId || raw.receipt.documentId !== `doc:${immutableRequest.commandId}`) {
          throw new Error("Native document service returned an invalid create target");
        }
        if (raw.activeState) {
          this.validateState(raw.activeState);
          if (raw.activeState.cursor.documentId !== raw.receipt.documentId) throw new Error("Native create receipt has a different active target");
          this.installState(raw.activeState);
        }
        this.failed = null;
        this.failedEnvelope = null;
        this.failedImportRequest = null;
        this.setStatus("saved");
        return structuredClone(raw);
      } catch (error) {
        if (this.current === prior) this.setStatus("idle");
        throw error instanceof Error ? error : new Error(String(error));
      }
    });
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }

  submit(payload: DomainCommand, target?: DocumentTarget): Promise<CommandResult> {
    const immutablePayload = structuredClone(payload);
    const scheduledTarget = target ? structuredClone(target) : this.current ? this.captureTarget() : null;
    const operation = this.tail.then(async () => {
      if (this.failed) throw this.failed;
      if (!this.current) throw new Error("Document has not been loaded");
      if (!scheduledTarget) throw new Error("Document was not loaded when the operation was scheduled");
      this.assertTarget(scheduledTarget);
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
    corrections: ImportCandidateCorrection[] = [],
  ): Promise<CommandResult> {
    const immutableDraftId = draftId;
    const immutableCandidateIds = [...acceptedCandidateIds];
    const immutableCursor = structuredClone(expectedCursor);
    const immutableCorrections = structuredClone(corrections);
    const scheduledTarget = this.current ? this.captureTarget() : null;
    const operation = this.tail.then(async () => {
      if (this.failed) throw this.failed;
      if (!this.current) throw new Error("Document has not been loaded");
      if (!scheduledTarget) throw new Error("Document was not loaded when the operation was scheduled");
      this.assertTarget(scheduledTarget);
      if (!sameCursor(this.current.cursor, immutableCursor)) {
        throw new Error("Import target changed after the candidates were prepared");
      }
      const request: ApplyImportRequest = {
        commandId: this.newCommandId(),
        cursor: immutableCursor,
        draftId: immutableDraftId,
        acceptedCandidateIds: immutableCandidateIds,
        // Absent corrections preserve the original protocol identity, so an
        // uncorrected apply keeps its exact retry receipt.
        ...(immutableCorrections.length ? { corrections: immutableCorrections } : {}),
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
      this.installState(state);
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
      this.installState(state);
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

  private installState(state: DocumentState): void {
    const previous = this.current;
    if (state.epoch !== undefined && previous?.epoch !== undefined) {
      const nextEpoch = transportEpoch(state.epoch), priorEpoch = transportEpoch(previous.epoch);
      if (nextEpoch < priorEpoch || nextEpoch === priorEpoch && state.cursor.documentId !== previous.cursor.documentId) {
        throw new Error("Document state response belongs to a stale host epoch");
      }
    }
    const sameDocument = previous?.cursor.documentId === state.cursor.documentId;
    this.current = structuredClone({
      ...(sameDocument && previous?.epoch !== undefined ? { epoch: previous.epoch } : {}),
      ...(sameDocument && previous?.meta !== undefined ? { meta: previous.meta } : {}), ...state,
      ...(sameDocument && state.recentExports === undefined && previous?.recentExports !== undefined ? { recentExports: previous.recentExports } : {}),
      ...(sameDocument && state.pendingImportCount === undefined && previous?.pendingImportCount !== undefined ? { pendingImportCount: previous.pendingImportCount } : {}),
    });
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
