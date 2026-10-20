import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

// Source configuration is editable; inventory hashes describe the current scan only.
export async function collectResourceInventory(workspace) {
  const json = async p => JSON.parse(await readFile(join(workspace, p), "utf8"));
  const config = await json("docs/resource-licenses.json");
  const packageJson = await json("package.json");
  const lock = await json("package-lock.json");
  const local = p => {
    const target = resolve(workspace, p);
    const rel = relative(workspace, target);
    if (!p || isAbsolute(p) || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Resource path escapes workspace: ${p}`);
    return target;
  };
  const file = async p => {
    try {
      const bytes = await readFile(local(p));
      return { path: p, bytes: bytes.length, sha256: digest(bytes) };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { path: p, present: false };
    }
  };
  if (config.schemaVersion !== 1 || !Array.isArray(config.licenses) || !Array.isArray(config.resourceDirectories)) throw new Error("Invalid resource source configuration");
  const licenses = [];
  for (const { path, source } of config.licenses) {
    if (typeof source !== "string" || !source) throw new Error(`Missing license source: ${path}`);
    const evidence = await file(path);
    if (evidence.present === false && !path.startsWith("node_modules/")) throw new Error(`Missing local license: ${path}`);
    if (evidence.bytes === 0) throw new Error(`Empty license: ${path}`);
    const upstream = /^https?:\/\//.test(source) ? null : await file(source);
    licenses.push({ ...evidence, source,
      comparison: upstream === null ? "remote-not-checked" : upstream.present === false || evidence.present === false ? "unavailable" : evidence.sha256 === upstream.sha256 ? "identical" : "different-review-required",
      ...(upstream?.sha256 ? {sourceSha256:upstream.sha256} : {}) });
  }
  async function scan(directory) {
    const files = [];
    async function walk(p) {
      let entries;
      try { entries = await readdir(local(p), { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT" && p === directory) return false; throw error; }
      for (const entry of entries) {
        const child = `${p}/${entry.name}`;
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile()) files.push(await file(child));
      }
      return true;
    }
    const present = await walk(directory);
    return {path:directory,present,files:files.sort((a,b)=>a.path.localeCompare(b.path))};
  }
  const packageNames = new Set(Object.keys(packageJson.dependencies ?? {}));
  for (const {source} of config.licenses) {
    const name = source.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1];
    if (name) packageNames.add(name);
  }
  const packages = [...packageNames].sort().map(name => {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (!entry) throw new Error(`Missing locked production package: ${name}`);
    return {name,version:entry.version,license:entry.license ?? null};
  });
  return {schemaVersion:2,capturedAt:new Date().toISOString(),scope:"Current local resource inventory; no historical byte freeze or legal approval.",sourceComparisonComplete:licenses.every(item=>item.comparison==="identical"),packages,licenses,
    resources:await Promise.all(config.resourceDirectories.map(scan)),resourceNotes:config.resourceNotes,externalRequirements:config.externalRequirements};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? "--check";
  if (!["--write","--check"].includes(mode) || process.argv.length > 3) throw new Error("Usage: node tools/generate-resource-license-inventory.mjs [--write|--check]");
  const inventory = await collectResourceInventory(root);
  if (mode === "--write") {
    const destination = join(root,".artifacts/analysis/resource-license-inventory.json");
    await mkdir(dirname(destination),{recursive:true});
    await writeFile(destination,JSON.stringify(inventory,null,2)+"\n");
  }
  const count = status => inventory.licenses.filter(item=>item.comparison===status).length;
  console.log(`R02_LICENSE_INVENTORY mode=${mode} status=${inventory.sourceComparisonComplete ? "compared" : "review-required"} packages=${inventory.packages.length} licenseTexts=${inventory.licenses.length} different=${count("different-review-required")} unavailable=${count("unavailable")} remoteNotChecked=${count("remote-not-checked")}; source review is not approval`);
}
