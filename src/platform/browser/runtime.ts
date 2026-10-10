import { registerPlatformInvoke, type NativeInvoke } from "../ipc";
import { registerBrowserCapabilities, type PlatformCapabilities } from "../capability";

type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> };
type EventChannel = { onmessage: (event: { runId: string; seq: number; epoch: number; kind: string; text: string }) => void };

export async function startBrowserRuntime(): Promise<void> {
  const pending = new Map<number, Pending>();
  const channels = new Map<string, { channel: EventChannel; seq: number }>();
  let worker: Worker | null = null, ready: Promise<unknown> | null = null, sequence = 0;
  const stop = (reason: unknown) => {
    worker?.terminate(); worker = null; ready = null;
    for (const value of pending.values()) { clearTimeout(value.timer); value.reject(reason); }
    pending.clear(); channels.clear();
  };
  const request = (command: string, args: Record<string, unknown> = {}): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => stop(new Error("浏览器核心响应超时，请重试；已确认保存的数据仍保留")), 120_000);
    pending.set(id, { resolve, reject, timer });
    worker?.postMessage({ id, command, args });
  });
  const ensureReady = () => {
    if (ready) return ready;
    worker = new Worker(new URL("./core-worker.mjs", import.meta.url), { type: "module" });
    worker.onerror = event => stop(new Error(event.message || "浏览器核心停止，请重试"));
    worker.onmessage = ({ data }) => {
      if (data.type === "agent_delta") {
        const listener = channels.get(data.runId);
        listener?.channel.onmessage({ runId: data.runId, seq: ++listener.seq, epoch: 1, kind: "delta", text: data.text });
        return;
      }
      const value = pending.get(data.id); if (!value) return;
      clearTimeout(value.timer); pending.delete(data.id);
      if (data.error) {
        try { JSON.parse(data.error); value.reject(data.error); }
        catch { value.reject(new Error(String(data.error))); }
      } else value.resolve(data.result);
    };
    ready = request("initialize").catch(error => { stop(error); throw error; });
    return ready;
  };
  const capabilities = await ensureReady() as PlatformCapabilities;
  registerBrowserCapabilities(capabilities);
  const invoke: NativeInvoke = async (command, args = {}) => {
    if (command === "pick_export_path") return String(args.defaultName ?? "ZineCV.pdf").split(/[\\/]/).pop();
    if (command === "pick_export_directory") return "浏览器下载";
    if (command === "write_export_file") {
      const name = String(args.path).split(/[\\/]/).pop() || "ZineCV-export";
      const binary = atob(String(args.dataBase64));
      const bytes = Uint8Array.from(binary, value => value.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: name.endsWith(".pdf") ? "application/pdf" : "image/png" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = name;
      document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
      return null;
    }
    await ensureReady();
    if (command === "restore_database_backup") {
      const backup = await request("export_database_backup");
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url;
      anchor.download = `ZineCV-恢复前备份-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
    const { onEvent, ...wireArgs } = args;
    const runId = typeof args.runId === "string" ? args.runId : "";
    if (onEvent && command === "agent_chat") channels.set(runId, { channel: onEvent as EventChannel, seq: 0 });
    try { return await request(command, wireArgs); }
    finally { if (command === "agent_chat") channels.delete(runId); }
  };
  registerPlatformInvoke(invoke);
  window.addEventListener("pagehide", () => stop(new Error("页面已关闭")), { once: true });
}
