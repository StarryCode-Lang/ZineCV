// Development-only UI refresh on a proven native host; never a release receipt.
import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { watch } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { build } from "vite";
import { buildInputManifest } from "./build-receipt.mjs";
import { startNativeHost, stopNativeHost } from "../tests/native/host-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const directory = join(root, ".artifacts/ui-workbench");
const outDir = join(directory, "dist");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const nativeInput = path => /^(Cargo\.toml|Cargo\.lock)$/.test(path) || /^(crates\/|src-tauri\/|\.cargo\/|rust-toolchain|contracts\/poc-contract|public\/|index.html|vite.config|package-lock)/.test(path) || (path.startsWith("src/") && !path.endsWith(".css"));
const started = performance.now();
const receipt = JSON.parse(await readFile(join(root, ".artifacts/build-receipts/build-native.json")));
if (receipt.provenance?.successfulBuild !== true || receipt.stage !== "build:native") throw Error("A successful native build receipt is required");
const expected = receipt.inputs.filter(file => nativeInput(file.path));
const actual = (await buildInputManifest(root, "build:native")).filter(file => nativeInput(file.path));
if (JSON.stringify(expected) !== JSON.stringify(actual)) throw Error("Non-CSS inputs changed. Use npm run dev for React/native development; npm run build:native only for an explicit release update.");
const executable = join(root, "src-tauri/target/release/zinecv-desktop.exe");
if (sha(await readFile(executable)) !== receipt.outputs.executable.sha256) throw Error("Native executable does not match its receipt");
await mkdir(directory, { recursive: true });
// This output is independent of the frozen production dist and executable.
if (process.env.ZINECV_RELEASE_FONTS === "engine") throw Error("UI workbench requires ordinary development fonts; unset ZINECV_RELEASE_FONTS");
const compileUi = () => build({ root, build: { outDir, emptyOutDir: true } });
await compileUi();
let host;
const watchers = [];
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  watchers.forEach(watcher => watcher.close());
  if (host) await stopNativeHost(host);
};
try {
  host = await startNativeHost(join(directory, "profile"), { executable });
  let style;
  let served = 0;
  const reload = async () => {
    const files = (await readdir(join(outDir, "assets"))).filter(file => file.endsWith(".css"));
    if (!files.length) throw Error("Compiled CSS is missing");
    const css = (await Promise.all(files.map(file => readFile(join(outDir, "assets", file), "utf8")))).join("\n");
    const next = await host.page.addStyleTag({ content: css });
    await next.evaluate(element => element.dataset.zinecvWorkbench = "development-only");
    if (style) await style.evaluate(element => element.remove());
    style = next;
    served = files.length;
  };
  await reload();
  const checkOnly = process.argv.includes("--check");
  if (checkOnly) {
    const evidence = await host.page.evaluate(async () => ({
      development: document.querySelector("style[data-zinecv-workbench]")?.dataset.zinecvWorkbench,
      headerHeight: document.querySelector(".topbar").getBoundingClientRect().height,
      nativeDocument: Boolean((await window.__TAURI_INTERNALS__.invoke("document_state")).document),
    }));
    if (!served || evidence.development !== "development-only" || !evidence.nativeDocument) throw Error("Fresh UI and real native IPC were not proven");
    await host.page.getByRole("button", { name: "导出", exact: true }).click();
    await host.page.locator(".download-menu").waitFor();
    await host.page.keyboard.press("Escape");
    const report = { mode: "development-css-on-proven-native-host", releaseQualification: false, seconds: (performance.now() - started) / 1000, served, ...evidence };
    await writeFile(join(directory, "check.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } else {
    console.log("Native CSS workbench ready. Isolated development data; production exe unchanged. Save CSS to refresh. React/native changes require npm run dev. Ctrl+C stops.");
    let timer;
    let busy = false;
    let pending = false;
    const refresh = async () => {
      if (busy) { pending = true; return; }
      busy = true;
      do {
        pending = false;
        try { const current = (await buildInputManifest(root, "build:native")).filter(file => nativeInput(file.path)); if (JSON.stringify(expected) !== JSON.stringify(current)) throw Error("Non-CSS inputs changed; restart with npm run dev"); await compileUi(); await reload(); console.log("UI refreshed without Rust compilation"); }
        catch (error) { console.error(error); }
      } while (pending && !stopping);
      busy = false;
    };
    watchers.push(watch(join(root, "src"), { recursive: true }, (_event, file) => { if (!String(file).endsWith(".css")) return; clearTimeout(timer); timer = setTimeout(() => void refresh(), 250); }));
    await new Promise(done => { process.once("SIGINT", done); process.once("SIGTERM", done); host.child.once("exit", done); });
    clearTimeout(timer);
  }
} finally { await stop(); }
