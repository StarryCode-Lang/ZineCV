import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile, readFile } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { createHash } from "node:crypto";
const root = resolve(import.meta.dirname, "..");
const run = (command, args) => { const result = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true }); if (result.status !== 0) throw new Error(command + " failed: " + result.status); };
if (process.platform !== "win32") throw new Error("This build entry currently verifies the Windows host only");
const bindgen = process.env.ZINECV_WASM_BINDGEN || join(process.env.LOCALAPPDATA, "Codex/toolchains/wasm-bindgen-0.2.129/wasm-bindgen-0.2.129-x86_64-pc-windows-msvc/wasm-bindgen.exe");
if (!existsSync(bindgen)) throw new Error("Install matching wasm-bindgen 0.2.129 outside the project, or set ZINECV_WASM_BINDGEN");
run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "tools/with-msvc.ps1", "wasm-build"]);
await mkdir(resolve(root, ".artifacts/wasm-bindings"), { recursive: true });
run(bindgen, ["src-tauri/target/wasm32-unknown-unknown/release/zinecv_wasm.wasm", "--target", "web", "--out-dir", ".artifacts/wasm-bindings", "--out-name", "zinecv_wasm"]);
run(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--config", "vite.web.config.ts"]);
const files = [];
const walk = async directory => { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await walk(path); else if (entry.name !== "sw.js") files.push(path); } };
await walk(resolve(root, "dist"));
const hash = createHash("sha256"); for (const file of files.sort()) hash.update(relative(root, file)).update(await readFile(file));
const cache = "zinecv-" + hash.digest("hex").slice(0, 20);
const urls = files.map(file => "/" + relative(resolve(root, "dist"), file).replaceAll("\\", "/"));
await writeFile(resolve(root, "dist/sw.js"), 'const CACHE=' + JSON.stringify(cache) + '; const FILES=' + JSON.stringify(urls) + ';\n' +
'self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES))));\n' +
'self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith("zinecv-")&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));\n' +
'self.addEventListener("fetch",event=>{ const url=new URL(event.request.url); if(event.request.method!=="GET"||url.origin!==self.location.origin)return; event.respondWith(caches.open(CACHE).then(cache=>cache.match(event.request)).then(hit=>hit||fetch(event.request))); });\n');
console.log("Web artifact ready; offline cache assets:", files.length);
