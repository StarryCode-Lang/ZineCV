import { describe } from "node:test";
import { readdir } from "node:fs/promises";

const directory = new URL("../tests/unit/", import.meta.url);
const files = (await readdir(directory)).filter(file => file.endsWith(".test.mjs")).sort();
if (!files.length) throw new Error("No unit test files found");

// Imports register all cases before execution. Each module retains its lexical
// scope; serial execution preserves global restoration and mock timer isolation.
describe("unit regression", { concurrency: 1 }, async () => {
  for (const file of files) await import(new URL(file, directory));
});
