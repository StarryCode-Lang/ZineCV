import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const matrix = JSON.parse(await readFile(resolve(root, "docs/feature-parity.json"), "utf8"));
const fixture = JSON.parse(await readFile(resolve(root, "contracts/poc-contract-v1.json"), "utf8"));
const ids = new Set(matrix.map((entry) => entry.featureId));
for (const prefix of ["F", "D"]) {
  const count = prefix === "F" ? 44 : 8;
  for (let number = 1; number <= count; number++) {
    const id = `${prefix}${String(number).padStart(2, "0")}`;
    if (!ids.has(id)) throw new Error(`Missing acceptance item ${id}`);
  }
}
if (ids.size !== 52) throw new Error(`Unexpected duplicate or extra matrix ID: ${ids.size}`);
for (const entry of matrix) {
  if (!["pending", "in_progress", "passed", "blocked", "failed"].includes(entry.status)) {
    throw new Error(`Invalid status for ${entry.featureId}`);
  }
  if (entry.status === "passed" && (!entry.revision || entry.tests.length === 0 || entry.evidence.length === 0)) {
    throw new Error(`Passed item ${entry.featureId} lacks revision, tests or evidence`);
  }
}
if (fixture.contractVersion !== "poc-contract-v1") throw new Error("Unexpected PoC contract version");
if (fixture.document.documentId !== fixture.renderRequest.documentId) throw new Error("Render target mismatch");
if (fixture.renderRequest.purpose !== "preview") throw new Error("Unexpected sample render purpose");
process.stdout.write("52 acceptance IDs and poc-contract-v1 verified; no feature status was promoted.\n");
