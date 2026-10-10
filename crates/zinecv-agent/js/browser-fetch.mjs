// Browser network capability only; protocol parsing and budgets stay in Rust.
export function create_stream() { return { controller: new AbortController(), reader: null }; }
export async function open_stream(handle, url, body, key) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(url, { method: "POST", headers, body, mode: "cors",
    credentials: "omit", redirect: "error", cache: "no-store", signal: handle.controller.signal });
  if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}`);
  if (!response.body) throw new Error("模型服务缺少流式响应");
  handle.reader = response.body.getReader();
}
export async function read_stream(handle) {
  const value = await handle.reader.read();
  return value.done ? null : value.value;
}
export function close_stream(handle) {
  handle.controller.abort();
  if (handle.reader) handle.reader.cancel().catch(() => {});
}
export async function fetch_json(url, method, body, key, limit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const headers = { "Content-Type": "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    const response = await fetch(url, { method, headers, body: method === "GET" ? undefined : body,
      signal: controller.signal, mode: "cors", credentials: "omit", redirect: "error", cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    let size = 0; const chunks = [];
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) throw new Error("Provider response exceeds size limit");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally { clearTimeout(timeout); controller.abort(); }
}
