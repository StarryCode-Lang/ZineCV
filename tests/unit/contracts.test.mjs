import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";
import { validateAcceptanceIds } from "../../tools/acceptance-matrix.mjs";

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
