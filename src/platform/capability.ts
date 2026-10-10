export type PlatformCapabilities = {
  core: "native" | "wasm" | "unavailable";
  storage: { persistent: boolean; concurrentWriters: boolean; backend: "sqlite" | "opfs-sahpool" | "unavailable" };
  secureSecrets: boolean;
  nativeDialogs: boolean;
  fileSystemAccess: boolean;
  modelDirectFetch: boolean;
  workerIsolation: boolean;
  webLocks: boolean;
};
let browserCapabilities: PlatformCapabilities | null = null;
export function registerBrowserCapabilities(value: PlatformCapabilities): void { browserCapabilities = Object.freeze(value); }
export function platformCapabilities(): PlatformCapabilities {
  if (browserCapabilities) return browserCapabilities;
  const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  return { core: native ? "native" : "unavailable", storage: { persistent: native, concurrentWriters: native, backend: native ? "sqlite" : "unavailable" },
    secureSecrets: native, nativeDialogs: native, fileSystemAccess: native, modelDirectFetch: native, workerIsolation: native, webLocks: false };
}
