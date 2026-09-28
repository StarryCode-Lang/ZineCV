import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";

test("acceptance matrix and shared PoC fixture stay complete", () => {
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "../../tools/verify-contracts.mjs")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /52 acceptance IDs/);
});
