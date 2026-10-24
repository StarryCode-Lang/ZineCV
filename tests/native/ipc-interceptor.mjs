// Real Tauri freezes invoke. Intercept its mutable fetch transport instead;
// commands without a test handler still reach the actual native dispatcher.
export async function installIpcInterceptor(page, { commands = null } = {}) {
  await page.evaluate((commands) => {
    if (window.__zinecvIpcInterceptor) return;
    // Real Playwright forwards the second evaluate argument; native harnesses
    // may omit it, leaving commands undefined. Treat both as "intercept all".
    const intercepted = commands == null ? null : new Set(commands);
    const originalFetch = window.fetch.bind(window);
    const fetch = async (input, options) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      const handler = window.__zinecvTestInvoke;
      if (!handler || !(url.hostname === "ipc.localhost" || url.protocol === "ipc:")) return originalFetch(input, options);
      const command = decodeURIComponent(url.pathname.replace(/^\//, ""));
      // Measurement only replaces the save picker. Leave all other native
      // responses intact: decoding and rebuilding each one creates extra
      // body streams/Blobs and Mojo routes inside the measured renderer.
      if (intercepted && !intercepted.has(command)) return originalFetch(input, options);
      const args = typeof options?.body === "string" ? JSON.parse(options.body) : null;
      if (!args) throw new Error(`Unsupported IPC test payload for ${command}`);
      const forward = async () => {
        const response = await originalFetch(input, options);
        const contentType = response.headers.get("content-type") || "";
        const value = contentType.startsWith("application/json") ? await response.json()
          : contentType.startsWith("text/plain") ? await response.text() : await response.arrayBuffer();
        if (response.headers.get("Tauri-Response") !== "ok") throw value;
        return value;
      };
      try {
        const value = await handler(command, args, forward);
        if (value instanceof ArrayBuffer) return new Response(value, { headers: { "Content-Type": "application/octet-stream", "Tauri-Response": "ok" } });
        return new Response(JSON.stringify(value ?? null), { headers: { "Content-Type": "application/json", "Tauri-Response": "ok" } });
      } catch (error) {
        return new Response(JSON.stringify(error instanceof Error ? { message: error.message } : error),
          { headers: { "Content-Type": "application/json", "Tauri-Response": "error" } });
      }
    };
    window.fetch = fetch;
    if (window.fetch !== fetch) throw new Error("Native IPC test transport interceptor did not install");
    window.__zinecvIpcInterceptor = { installed: true, commands };
  }, commands);
}
