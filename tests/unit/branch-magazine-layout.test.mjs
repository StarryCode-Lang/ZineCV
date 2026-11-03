import { test } from "node:test";
import { strict as assert } from "node:assert";
import { getBranchTreeLayout, branchTreeNodeStep } from "../../src/ui/versioning/branch-tree-magazine-layout.ts";

test("magazine graph keeps empty branches and marks unloaded templates honestly", () => {
  const store = { currentBranchId: "main", branches: [
    { id: "main", name: "主分支", createdAt: "1", headCommitId: "one" },
    { id: "empty", name: "空分支", createdAt: "2", headCommitId: null },
    { id: "fork", name: "分支", createdAt: "3", headCommitId: "two" },
  ], commits: [
    { id: "one", branchId: "main", parentId: null, createdAt: "1", message: "first", snapshot: null },
    { id: "two", branchId: "fork", parentId: "one", createdAt: "3", message: "second", snapshot: { presentation: { templateId: "clear-single-v1" } } },
  ] };
  const { groups, forks } = getBranchTreeLayout(store);
  const rows = groups.flatMap(group => group.rows);
  assert.deepEqual(new Set(rows.map(row => row.branchId)), new Set(["main", "empty", "fork"]));
  assert.equal(rows.find(row => row.branchId === "empty").commits.length, 0);
  assert.equal(groups.find(group => group.rows.some(row => row.branchId === "main")).label, "模板待载入");
  assert.equal(groups.find(group => group.rows.some(row => row.branchId === "fork")).label, "清晰单栏");
  assert.equal(forks.length, 1);
});

test("magazine graph retains all depth columns beyond the old 200-node limit", () => {
  const commits = Array.from({ length: 1001 }, (_, index) => ({
    id: `c${index}`, branchId: "main", parentId: index ? `c${index - 1}` : null,
    createdAt: String(index).padStart(4, "0"), message: String(index), snapshot: null,
  }));
  const { groups } = getBranchTreeLayout({ currentBranchId: "main", branches: [{ id: "main", name: "main", createdAt: "0", headCommitId: "c1000" }], commits });
  const nodes = groups.flatMap(group => group.rows.flatMap(row => row.commits));
  assert.equal(nodes.length, 1001);
  assert.equal(nodes.at(-1).x - nodes[0].x, 1000 * branchTreeNodeStep);
  assert.equal(new Set(nodes.map(node => node.x)).size, 1001);
});
