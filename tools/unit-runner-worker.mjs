import { describe } from "node:test";
import { workerData } from "node:worker_threads";

// One worker keeps a resident module graph for its shard: the TypeScript
// loader, compile cache and shared src modules load once per worker instead of
// once per test file. Each worker is a fresh isolate, so module globals, mocked
// timers and environment snapshots never cross worker boundaries. Files inside
// a shard run serially, matching the single-process regression entry that this
// suite already accepts as its fallback.
await import(workerData.registerUrl);

describe("unit regression shard", { concurrency: 1 }, async () => {
  for (const { name, url } of workerData.files) {
    describe(`file ${name}`, { concurrency: 1 }, async () => {
      await import(url);
    });
  }
});
