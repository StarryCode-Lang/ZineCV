import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";
import { validateAcceptanceIds } from "../../tools/acceptance-matrix.mjs";
import { createHash } from "node:crypto";
import { readRemainingFixture, readRemainingFixtureBytes } from "../../fixtures/remaining.mjs";

test("acceptance matrix and shared PoC fixture stay complete", () => {
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "../../tools/verify-contracts.mjs")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /52 mandatory acceptance IDs and 4 supplemental IDs/);
});

test("feature matrix keeps every mandatory row and accepts explicitly identified supplements", () => {
  const mandatory = [
    ...Array.from({ length: 44 }, (_, index) => ({ featureId: `F${String(index + 1).padStart(2, "0")}` })),
    ...Array.from({ length: 8 }, (_, index) => ({ featureId: `D${String(index + 1).padStart(2, "0")}` })),
  ];
  const accepted = validateAcceptanceIds([...mandatory, { featureId: "S-IMPORT-EDGE", supplemental: true }]);
  assert.equal(accepted.size, 52);
  assert.throws(() => validateAcceptanceIds([...mandatory, { featureId: "S-IMPORT-EDGE" }]), /supplemental: true/);
  assert.throws(() => validateAcceptanceIds(mandatory.slice(1)), /Missing acceptance item F01/);
});

test("synthetic fixture rules validate scenarios and describe current inputs without frozen hashes", async () => {
  const manifest = await readRemainingFixture("manifest.json");
  assert.ok(Object.keys(manifest.fileSha256).length > 0);
  for (const [name, expected] of Object.entries(manifest.fileSha256)) {
    const bytes = await readRemainingFixtureBytes(name);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, name);
  }
  assert.equal(manifest.scenarios.length, 12);
  assert.equal((await readRemainingFixture("version-graph-1000.json")).commits.length, 1000);
});

test("fixture readers return isolated values and reject unknown logical inputs", async () => {
  const first = await readRemainingFixture("documents/one-page.json");
  const title = first.title;
  first.title = "not shared";
  assert.equal((await readRemainingFixture("fixtures/remaining.mjs#documents/one-page.json")).title, title);
  const bytes = await readRemainingFixtureBytes("documents/one-page.json");
  bytes.fill(0);
  assert.equal((await readRemainingFixture("documents/one-page.json")).title, title);
  await assert.rejects(readRemainingFixture("../missing.json"), /Unknown synthetic fixture/);
});
