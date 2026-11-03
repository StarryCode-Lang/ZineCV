import type { ResumeCommit, ResumeVersionStore } from "../ui/domain/version-model";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function indexById<T extends { id: string }>(items: T[]): Map<string, T> {
  const index = new Map(items.map((item) => [item.id, item]));
  if (index.size !== items.length) throw new Error("旧版版本库存在重复 ID，已停止迁移");
  return index;
}

// A conflicting backup is a distinct graph: clone its identities together so
// parent, origin and branch-head references continue to describe that graph.
export function mergeLegacyVersionStores(primary: ResumeVersionStore | null, backup: ResumeVersionStore | null): {
  store: ResumeVersionStore | null; duplicateBackupCommits: ResumeCommit[];
} {
  if (!primary) return { store: backup, duplicateBackupCommits: [] };
  if (!backup) return { store: primary, duplicateBackupCommits: [] };
  const branches = indexById(primary.branches), commits = indexById(primary.commits);
  indexById(backup.branches); indexById(backup.commits);
  const conflict = backup.branches.some((item) => branches.has(item.id) && canonical(branches.get(item.id)) !== canonical(item))
    || backup.commits.some((item) => commits.has(item.id) && canonical(commits.get(item.id)) !== canonical(item));
  if (conflict) {
    const reserve = (prefix: string, used: Set<string>, count: number) => Array.from({ length: count }, (_, index) => {
      let suffix = index, id = `${prefix}-${suffix}`;
      while (used.has(id)) id = `${prefix}-${++suffix}`;
      used.add(id); return id;
    });
    const branchIds = reserve("legacy-backup-branch", new Set(branches.keys()), backup.branches.length);
    const commitIds = reserve("legacy-backup-commit", new Set(commits.keys()), backup.commits.length);
    const branchMap = new Map(backup.branches.map((item, index) => [item.id, branchIds[index]]));
    const commitMap = new Map(backup.commits.map((item, index) => [item.id, commitIds[index]]));
    return { store: {
      ...primary,
      branches: [...primary.branches, ...backup.branches.map((item) => ({ ...item, id: branchMap.get(item.id)!, name: `${item.name}（旧版备份）`, headCommitId: item.headCommitId ? commitMap.get(item.headCommitId) ?? item.headCommitId : null }))],
      commits: [...primary.commits, ...backup.commits.map((item) => ({ ...item, id: commitMap.get(item.id)!, branchId: branchMap.get(item.branchId) ?? item.branchId, parentId: item.parentId ? commitMap.get(item.parentId) ?? item.parentId : null }))],
    }, duplicateBackupCommits: [] };
  }
  return { store: {
    ...primary,
    branches: [...primary.branches, ...backup.branches.filter((item) => !branches.has(item.id))],
    commits: [...primary.commits, ...backup.commits.filter((item) => !commits.has(item.id))],
  }, duplicateBackupCommits: backup.commits.filter((item) => commits.has(item.id)) };
}
