import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const source = resolve(root, "docs/zinecv-v2/FEATURE_PARITY.md");
const target = resolve(root, "desktop/docs/feature-parity.json");
const markdown = await readFile(source, "utf8");
const entries = [];

for (const line of markdown.split(/\r?\n/)) {
  const match = line.match(/^\|\s*((?:F\d{2}|D\d{2}))\s*\|/);
  if (!match) continue;
  const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
  entries.push({
    featureId: match[1],
    title: cells[1],
    legacyEntry: cells[2] ?? "",
    targetOwner: cells[3] ?? "",
    acceptance: cells[4] ?? "",
    batches: (cells[5] ?? "").split("/").filter(Boolean),
    status: "pending",
    revision: null,
    implementationPaths: [],
    tests: [],
    evidence: [],
    environment: null,
    knownBaselineIssues: [],
    remainingIssues: [],
    reviewer: null,
  });
}

const expected = [
  ...Array.from({ length: 44 }, (_, index) => `F${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 8 }, (_, index) => `D${String(index + 1).padStart(2, "0")}`),
];
const actual = entries.map((entry) => entry.featureId);
if (new Set(actual).size !== expected.length || expected.some((id) => !actual.includes(id))) {
  throw new Error(`Feature matrix IDs do not match F01–F44/D01–D08: ${actual.join(", ")}`);
}

try {
  await readFile(target, "utf8");
  throw new Error(`Refusing to overwrite existing status: ${target}`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

await mkdir(dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(entries, null, 2) + "\n", "utf8");
process.stdout.write(`Initialized ${entries.length} pending acceptance entries at ${target}\n`);
