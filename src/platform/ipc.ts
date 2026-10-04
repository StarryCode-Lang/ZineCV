// 桌面 IPC 入口：Tauri 环境走原生命令，普通浏览器（dev/test）明确降级。
import type { AppError } from "../../src-tauri/src/domain/bindings/AppError";
import type { NativeIpcCommandName } from "../../src-tauri/src/domain/bindings/NativeIpcCommandName";

export type NativeInvoke = (
  command: NativeIpcCommandName,
  args?: Record<string, unknown>,
) => Promise<unknown>;

const APP_ERROR_CODES = new Set([
  "VALIDATION",
  "CONFLICT",
  "NOT_FOUND",
  "PERMISSION",
  "STORAGE_FULL",
  "STORAGE_CORRUPT",
  "UNSUPPORTED_SCHEMA",
  "RESOURCE_LIMIT",
  "CANCELLED",
  "ENGINE_FAILURE",
  "MIGRATION_PARTIAL",
  "PROVIDER_FAILURE",
  "IPC_FAILURE",
]);

export class NativeIpcError extends Error {
  constructor(readonly detail: AppError) {
    super(detail.message);
    this.name = "NativeIpcError";
  }
}

function isAppError(value: unknown): value is AppError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.code === "string" && APP_ERROR_CODES.has(candidate.code) &&
    typeof candidate.message === "string" &&
    typeof candidate.retryable === "boolean" &&
    typeof candidate.diagnosticId === "string" &&
    candidate.diagnosticId.length >= 8 && candidate.diagnosticId.length <= 80;
}

export const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let cachedInvoke: NativeInvoke | null = null;

export async function nativeInvoke(command: NativeIpcCommandName, args?: Record<string, unknown>): Promise<unknown> {
  if (!cachedInvoke) {
    if (!isTauriRuntime()) {
      throw new Error("Native document service is unavailable in the browser preview");
    }
    const core = await import("@tauri-apps/api/core");
    cachedInvoke = core.invoke as unknown as NativeInvoke;
  }
  try {
    return await cachedInvoke(command, args);
  } catch (error) {
    if (isAppError(error)) throw new NativeIpcError(error);
    throw error;
  }
}
