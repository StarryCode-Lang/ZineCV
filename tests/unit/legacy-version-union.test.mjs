import { test } from "node:test";
import { strict as assert } from "node:assert";
import { loadModule } from "./module-loader.mjs";

const { mergeLegacyVersionStores } = await loadModule("src/platform/legacyVersionUnion.ts", {});
const branch = { id: "main", name: "Main", headCommitId: "c1", createdAt: "2020" };
const commit = { id: "c1", branchId: "main", parentId: null, message: "one", createdAt: "2020", snapshot: { resumeTitle: "one" } };
const primary = { currentBranchId: "main", branches: [branch], commits: [commit] };

test("backup adds its extra branch without duplicating identical commits", () => {
  const backup = { ...primary, branches: [{ ...branch }, { id: "extra", name: "Extra", headCommitId: null, createdAt: "2020" }], commits: [{ ...commit }] };
  const result = mergeLegacyVersionStores(primary, backup);
  assert.equal(result.store.branches.length, 2);
  assert.equal(result.store.commits.length, 1);
  assert.equal(result.duplicateBackupCommits.length, 1);
  assert.equal(result.store.currentBranchId, "main");
});

test("conflicting backup retains a separate connected graph", () => {
  const backup = { ...primary, commits: [{ ...commit, message: "different" },
    { ...commit, id: "c2", parentId: "c1", message: "two" }],
    branches: [{ ...branch, headCommitId: "c2" }] };
  const result = mergeLegacyVersionStores(primary, backup);
  assert.equal(result.store.branches.length, 2);
  assert.equal(result.store.commits.length, 3);
  const other = result.store.branches[1];
  const second = result.store.commits.find((item) => item.id === other.headCommitId);
  assert.equal(second.branchId, other.id);
  assert.equal(result.store.commits.find((item) => item.id === second.parentId).message, "different");
  assert.equal(result.duplicateBackupCommits.length, 0);
  assert.throws(() => mergeLegacyVersionStores(primary, { ...backup, branches: [branch, branch] }), /重复 ID/);
});
