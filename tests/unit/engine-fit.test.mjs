import { test } from "node:test";
import { strict as assert } from "node:assert";
import { EngineFitClient } from "../../src/preview/engineFit.ts";

const cursor = { documentId: "doc", contextId: "ctx", revision: "1", branchId: "main", headId: null };
const presentation = { templateId: "baseline", templateRevision: "1", fontSetId: "frozen", density: "comfortable", theme: "blue",
  fontSizePt: 11, lineHeightPt: 14, headingSizePt: 13, pageMarginPt: 22, moduleGapPt: 2, paragraphGapPt: 1, listGapPt: 1, legacyOverrides: {} };
function proposal(current = cursor) {
  return { cursor: structuredClone(current), renderKey: "a".repeat(64), plan: {
    status: "fitted", semanticHash: "b".repeat(64), originalPresentation: structuredClone(presentation),
    fittedPresentation: { ...structuredClone(presentation), fontSizePt: 10, lineHeightPt: 12 },
    attempts: [{ candidateIndex: 0, pageCount: 2 }, { candidateIndex: 1, pageCount: 1 }],
  } };
}

test("fit coalesces requests and cancellation discards late success or failure", async () => {
  const calls = [];
  const releases = [];
  const client = new EngineFitClient((command, args) => {
    calls.push({ command, args });
    return new Promise((resolve, reject) => releases.push({ resolve, reject }));
  });
  const first = client.request(cursor);
  const superseded = client.request({ ...cursor, revision: "2" });
  const newestCursor = { ...cursor, revision: "3" };
  const newest = client.request(newestCursor);
  assert.equal(await superseded, null);
  assert.equal(calls.length, 1);
  releases[0].resolve(proposal(cursor));
  assert.equal(await first, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args.cursor, newestCursor);
  client.cancel();
  releases[1].reject(new Error("late worker failure"));
  assert.equal(await newest, null);
  assert.equal(calls.length, 2);
});

test("fit application uses the full frozen CAS once and rejects cancelled or changed contexts", async () => {
  const commits = [];
  const client = new EngineFitClient(async (command, args) => {
    if (command === "fit_document_one_page") return proposal(args.cursor);
    commits.push(args.envelope);
    return { durable: true };
  }, () => "fit-command");
  const planned = await client.request(cursor);
  assert.equal(await client.apply(planned, { ...cursor, contextId: "changed" }), null);
  assert.equal(commits.length, 0);
  await client.apply(planned, cursor);
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0], { protocolVersion: 1, commandId: "fit-command", documentId: cursor.documentId,
    contextId: cursor.contextId, expectedRevision: cursor.revision, expectedBranchId: cursor.branchId,
    expectedHeadId: cursor.headId, payload: { type: "setLayout", presentation: planned.plan.fittedPresentation } });
  assert.equal(await client.apply(planned, cursor), null);
  const cancelled = await client.request(cursor);
  client.cancel();
  assert.equal(await client.apply(cancelled, cursor), null);
  assert.equal(commits.length, 1);
});

test("fit rejects cursor mismatch, unreadable layouts and protected-field changes before application", async () => {
  for (const mutate of [
    result => { result.cursor.headId = "different-head"; },
    result => { result.plan.fittedPresentation.fontSizePt = 8; },
    result => { result.plan.fittedPresentation.fontSetId = "different-font"; },
    result => { result.plan.attempts[1].candidateIndex = 16; },
  ]) {
    const result = proposal();
    mutate(result);
    const client = new EngineFitClient(async () => result);
    await assert.rejects(client.request(cursor));
  }
  let commits = 0;
  const result = proposal();
  result.plan.status = "timedOut";
  result.plan.fittedPresentation = null;
  const client = new EngineFitClient(async command => { if (command === "fit_document_one_page") return result; commits++; });
  const planned = await client.request(cursor);
  assert.equal(await client.apply(planned, cursor), null);
  assert.equal(commits, 0);
});
