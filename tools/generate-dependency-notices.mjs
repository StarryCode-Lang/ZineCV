// Explicit maintenance command; ordinary development does not fetch or regenerate.
import { readFile, readdir, writeFile, mkdir, copyFile } from "node:fs/promises";
import { dirname, join, basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const json = async path => JSON.parse(await readFile(path, "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const write = process.argv.includes("--write");
if (process.argv.includes("--check-fast")) {
  const manifest = await json(join(root, "docs/licenses/dependency-notices.json"));
  if (hash(await readFile(join(root, "Cargo.lock"))) !== manifest.cargoLockSha256
    || hash(await readFile(join(root, "package-lock.json"))) !== manifest.npmLockSha256
    || hash(await readFile(join(root, "docs/licenses/dependency-notices.txt"))) !== manifest.noticeSha256) {
    throw new Error("Dependency notices need regeneration for current locks/content");
  }
  for (const pkg of manifest.packages.filter(pkg => pkg.sourceOffer)) {
    if (hash(await readFile(join(root, "docs/licenses", pkg.sourceOffer.bundledArchive))) !== pkg.sourceOffer.sha256) throw new Error("MPL source archive differs");
  }
  console.log(`DEPENDENCY_NOTICES packages=${manifest.packages.length} currentLocks=matched missing=0`);
  process.exit(0);
}
const cargo = spawnSync("cargo", ["metadata", "--offline", "--locked", "--format-version", "1", "--filter-platform", "x86_64-pc-windows-msvc"],
  { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
if (cargo.status !== 0) throw new Error(cargo.stderr || "cargo metadata failed");
const metadata = JSON.parse(cargo.stdout);
const upstream = await json(join(root, "docs/licenses/rust-upstream.json"));
const texts = new Map(), packages = [], missing = [];
const addText = (text, source) => {
  text = text.replace(/\r\n?/g, "\n");
  const digest = hash(text);
  const item = texts.get(digest) ?? { text, sources: new Set() };
  item.sources.add(source); texts.set(digest, item);
  return digest;
};
async function licenseFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!/^(licen[sc]e|copying|copyright|notice)/i.test(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isFile()) result.push({ name: entry.name, text: await readFile(path, "utf8") });
    else if (entry.isDirectory()) {
      for (const child of await readdir(path, { withFileTypes: true })) {
        if (child.isFile()) result.push({ name: entry.name + "/" + child.name, text: await readFile(join(path, child.name), "utf8") });
      }
    }
  }
  return result;
}
const apache = await readFile(join(root, "docs/licenses/pdfjs-dist-apache-2.0.txt"), "utf8");
const sourceAudit = String.raw`
import sys, tarfile, pathlib, hashlib
root = pathlib.Path(sys.argv[1]).resolve()
prefix = sys.argv[3] + '/'
checked = 0
with tarfile.open(sys.argv[2]) as archive:
    for member in archive.getmembers():
        assert member.isdir() or member.isfile(), 'unexpected source archive link'
        if member.isdir():
            continue
        assert member.name.startswith(prefix), 'unexpected source archive root'
        path = root.joinpath(member.name.removeprefix(prefix)).resolve()
        assert path.is_relative_to(root), 'source path escape'
        expected = hashlib.sha256(archive.extractfile(member).read()).digest()
        assert hashlib.sha256(path.read_bytes()).digest() == expected, 'modified ' + member.name
        checked += 1
assert checked > 0
print(checked)
`;
for (const pkg of metadata.packages.filter(pkg => pkg.source).sort((a, b) => (a.name + a.version).localeCompare(b.name + b.version))) {
  const files = await licenseFiles(dirname(pkg.manifest_path));
  const record = { ecosystem: "cargo", name: pkg.name, version: pkg.version, declaredLicense: pkg.license,
    source: `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`, notices: [] };
  if (files.length) for (const file of files) record.notices.push(addText(file.text, `${pkg.name}@${pkg.version}/${file.name}`));
  else {
    const matches = upstream.records.filter(item => item.packages.includes(pkg.name)).flatMap(item => item.files);
    for (const file of matches) record.notices.push(addText(file.text, file.source));
    if (!record.notices.length && /Apache-2\.0/.test(pkg.license ?? "")) {
      record.selectedLicense = "Apache-2.0";
      record.note = "Published crate omits a standalone license file; its Cargo metadata explicitly grants Apache-2.0 as an option. Standard license text supplied; upstream author metadata retained without inventing a copyright statement.";
      record.authors = pkg.authors;
      record.notices.push(addText(apache, "Apache-2.0 standard text; package license expression"));
    }
  }
  if (pkg.license?.includes("MPL-2.0")) {
    const directory = dirname(pkg.manifest_path);
    const lock = await readFile(join(root, "Cargo.lock"), "utf8");
    const block = lock.split("[[package]]").find(block => block.includes(`name = "${pkg.name}"\n`) && block.includes(`version = "${pkg.version}"\n`));
    const checksum = block?.match(/^checksum = "([a-f\d]+)"$/m)?.[1];
    const archive = join(dirname(dirname(dirname(directory))), "cache", basename(dirname(directory)), `${pkg.name}-${pkg.version}.crate`);
    const bytes = await readFile(archive);
    if (hash(bytes) !== checksum) throw new Error(`Source archive checksum mismatch: ${pkg.name}`);
    record.sourceOffer = { license: "MPL-2.0", unchangedUpstreamSource: true,
      bundledArchive: `mpl-sources/${pkg.name}-${pkg.version}.crate`, sha256: hash(bytes), url: record.source };
    const audit = spawnSync("python", ["-c", sourceAudit, directory, archive, `${pkg.name}-${pkg.version}`], { encoding: "utf8", windowsHide: true });
    if (audit.status !== 0) throw new Error(`MPL source verification failed: ${pkg.name}: ${audit.stderr}`);
    record.sourceOffer.verifiedSourceFiles = Number(audit.stdout.trim());
    if (write) { await mkdir(join(root, "docs/licenses/mpl-sources"), { recursive: true }); await copyFile(archive, join(root, "docs/licenses", record.sourceOffer.bundledArchive)); }
  }
  if (!record.notices.length) missing.push(`cargo:${pkg.name}@${pkg.version}`);
  packages.push(record);
}
const lock = await json(join(root, "package-lock.json"));
const npmUpstream = await json(join(root, "docs/licenses/npm-upstream.json"));
for (const [path, spec] of Object.entries(lock.packages).filter(([path, spec]) => path && !spec.dev).sort()) {
  const directory = join(root, path), pkg = await json(join(directory, "package.json")).catch(error => {
    if (error.code === "ENOENT" && spec.optional) return null;
    throw error;
  });
  if (!pkg) continue; // Optional binaries for other host platforms are not installed/shipped.
  const files = await licenseFiles(directory);
  const record = { ecosystem: "npm", name: pkg.name, version: pkg.version,
    declaredLicense: pkg.license ?? spec.license, source: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`, notices: [] };
  for (const file of files) record.notices.push(addText(file.text, `${pkg.name}@${pkg.version}/${file.name}`));
  if (!record.notices.length && pkg.name === "isarray") {
    const readme = await readFile(join(directory, "README.md"), "utf8");
    const start = readme.indexOf("## License");
    if (start >= 0) record.notices.push(addText(readme.slice(start), `${pkg.name}@${pkg.version}/README.md#License`));
  }
  if (!record.notices.length && pkg.name.startsWith("@napi-rs/canvas-")) {
    const parent = await json(join(root, "node_modules/@napi-rs/canvas/package.json"));
    if (parent.version === pkg.version) record.notices.push(addText(await readFile(join(root, "node_modules/@napi-rs/canvas/LICENSE"), "utf8"), `@napi-rs/canvas@${parent.version}/LICENSE (same-version platform binary)`));
  }
  if (!record.notices.length) {
    const fallback = npmUpstream.records.find(item => item.name === pkg.name && item.version === pkg.version);
    if (fallback) { record.notices.push(addText(fallback.text, fallback.source)); record.note = fallback.note; }
  }
  if (!record.notices.length) missing.push(`npm:${pkg.name}@${pkg.version}`);
  packages.push(record);
}
if (missing.length) throw new Error("Missing upstream license text: " + missing.join(", "));
const manifest = { schemaVersion: 1, scope: "Windows Cargo metadata dependency closure (including build/dev superset) and installed production npm lock packages; absent optional binaries for other platforms excluded; not a claim that every listed crate is linked",
  cargoLockSha256: hash(await readFile(join(root, "Cargo.lock"))), npmLockSha256: hash(await readFile(join(root, "package-lock.json"))), packages,
  texts: Object.fromEntries([...texts].map(([digest, item]) => [digest, { sources: [...item.sources].sort() }])) };
const notice = ["ZineCV third-party dependency notices", manifest.scope,
  "MPL-2.0 source is provided in the adjacent mpl-sources directory and at the listed source URLs. Those sources retain MPL rights; first-party terms do not restrict them.",
  ...packages.map(pkg => `${pkg.ecosystem}:${pkg.name}@${pkg.version}\nLicense: ${pkg.declaredLicense}\nSource: ${pkg.source}\n${pkg.selectedLicense ? "Selected license: " + pkg.selectedLicense + "\n" : ""}${pkg.note ?? ""}\nNotices: ${pkg.notices.join(", ")}${pkg.sourceOffer ? "\nMPL source: " + pkg.sourceOffer.bundledArchive : ""}`),
  ...[...texts].map(([digest, item]) => `\n===== ${digest} =====\n${item.text}`)].join("\n\n") + "\n";
manifest.noticeSha256 = hash(notice);
if (write) {
  await writeFile(join(root, "docs/licenses/dependency-notices.txt"), notice);
  await writeFile(join(root, "docs/licenses/dependency-notices.json"), JSON.stringify(manifest, null, 2) + "\n");
} else {
  const actual = await json(join(root, "docs/licenses/dependency-notices.json"));
  if (JSON.stringify(actual) !== JSON.stringify(manifest)) throw new Error("Dependency notice inventory differs; review current inputs and regenerate with --write");
  if (await readFile(join(root, "docs/licenses/dependency-notices.txt"), "utf8") !== notice) throw new Error("Dependency notice content differs from current inputs");
}
console.log(JSON.stringify({ mode: write ? "write" : "check", packages: packages.length, cargo: packages.filter(pkg => pkg.ecosystem === "cargo").length,
  npm: packages.filter(pkg => pkg.ecosystem === "npm").length, uniqueLicenseTexts: texts.size, noticeBytes: Buffer.byteLength(notice), missing: 0 }));
