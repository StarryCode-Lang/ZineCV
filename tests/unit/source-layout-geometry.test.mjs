import { test } from "node:test";
import { strict as assert } from "node:assert";
import { loadModule } from "./module-loader.mjs";

test("overlap checks compare boxes on the same page only", async () => {
  const { layoutOverlapRatio } = await loadModule("src/ui/services/imported-layout.ts", {});
  const box = { x: 10, y: 20, width: 100, height: 20 };
  assert.equal(layoutOverlapRatio({ boxes: [{ ...box, page: 1 }, { ...box, page: 2 }] }), 0);
  assert.equal(layoutOverlapRatio({ boxes: [{ ...box, page: 1 }, { ...box, page: 1 }] }), 1);
});
