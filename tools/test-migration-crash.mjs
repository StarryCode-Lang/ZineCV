import { spawnSync } from "node:child_process";

for (const phase of ["before-commit", "after-commit"]) {
  const result = spawnSync(process.execPath, ["--test", "tests/native/webview-migration.test.mjs"], {
    stdio: "inherit", env: { ...process.env, ZINECV_TEST_MIGRATION_PHASE: phase },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
