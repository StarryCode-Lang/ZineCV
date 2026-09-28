// 工作区偏好 KV：localStorage 保持同步首屏读取（旧组件不改动为异步），
// 桌面模式同时镜像到 SQLite settings 表，保证备份/换机迁移时不丢偏好。
import { isTauriRuntime, nativeInvoke } from "./ipc";

export async function kvWrite(key: string, value: string | null): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await nativeInvoke("write_setting", { key, value });
  } catch (error) {
    console.error(`Setting ${key} mirror failed`, error);
  }
}

export async function kvRead(key: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  try {
    const value = (await nativeInvoke("read_setting", { key })) as string | null;
    return value ?? null;
  } catch (error) {
    console.error(`Setting ${key} read failed`, error);
    return null;
  }
}
