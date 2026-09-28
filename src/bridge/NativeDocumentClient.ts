import type { AuthorityCursor } from "../../src-tauri/src/domain/bindings/AuthorityCursor";
import type { CommandEnvelope } from "../../src-tauri/src/domain/bindings/CommandEnvelope";
import type { CommandResult } from "../../src-tauri/src/domain/bindings/CommandResult";
import type { DomainCommand } from "../../src-tauri/src/domain/bindings/DomainCommand";
import type { ResumeDocument } from "../../src-tauri/src/domain/bindings/ResumeDocument";

export type DocumentState = { cursor: AuthorityCursor; document: ResumeDocument };
export type SaveStatus = "idle" | "saving" | "saved" | "failed";
export type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

function isNewerRevision(next: string, previous: string): boolean {
  return next.length > previous.length ||
    (next.length === previous.length && next > previous);
}

export class NativeDocumentClient {
  private readonly invoke: NativeInvoke;
  private readonly newCommandId: () => string;
  private current: DocumentState | null = null;
  private tail: Promise<void> = Promise.resolve();
  private failed: unknown = null;
  private failedEnvelope: CommandEnvelope | null = null;
  private status: SaveStatus = "idle";
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
    const state = await this.invoke("document_state") as DocumentState;
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
      const state = await this.invoke("document_state") as DocumentState;
      this.validateState(state);
      this.current = structuredClone(state);
      this.setStatus("idle");
      return this.snapshot!;
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
      return this.send(envelope);
    });
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }

  async retryFailed(): Promise<CommandResult> {
    await this.tail;
    if (!this.failedEnvelope || !this.failed) {
      throw new Error("No failed command is available for retry");
    }
    this.setStatus("saving");
    const operation = this.send(this.failedEnvelope);
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }

  async flush(): Promise<DocumentState> {
    await this.tail;
    if (this.failed) throw this.failed;
    if (!this.current) throw new Error("Document has not been loaded");
    return this.snapshot!;
  }

  private async send(envelope: CommandEnvelope): Promise<CommandResult> {
    try {
      const result = await this.invoke("apply_document_command", { envelope }) as CommandResult;
      if (!this.current || result?.commandId !== envelope.commandId || result.durable !== true) {
        throw new Error("Native document service did not confirm a durable command");
      }
      this.validateState({ cursor: result.cursor, document: result.document });
      if (!isNewerRevision(result.cursor.revision, this.current.cursor.revision)) {
        throw new Error("Native document service returned an older revision");
      }
      if (result.cursor.documentId !== envelope.documentId ||
          result.cursor.contextId !== envelope.contextId) {
        throw new Error("Native document service changed the command target");
      }
      this.current = { cursor: structuredClone(result.cursor), document: structuredClone(result.document) };
      this.failed = null;
      this.failedEnvelope = null;
      this.setStatus("saved");
      return result;
    } catch (error) {
      this.failed = error instanceof Error ? error : new Error(String(error));
      this.setStatus("failed");
      throw this.failed;
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
