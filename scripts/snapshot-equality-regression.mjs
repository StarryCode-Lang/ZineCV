import assert from "node:assert/strict";
import { sameSnapshotValue } from "../src/utils/snapshot-equality.mjs";

const snapshot = {
  resume: {
    basic: { name: "Lin", email: "lin@example.com" },
    education: [{ school: "Example University", year: "2026" }],
  },
  layout: { font: "宋体", fontSize: "13", pageMargin: "30" },
};
const reordered = {
  layout: { pageMargin: "30", fontSize: "13", font: "宋体" },
  resume: {
    education: [{ year: "2026", school: "Example University" }],
    basic: { email: "lin@example.com", name: "Lin" },
  },
};

assert.equal(sameSnapshotValue(snapshot, reordered), true);
assert.equal(
  sameSnapshotValue(snapshot, {
    ...reordered,
    resume: {
      ...reordered.resume,
      education: [{ ...reordered.resume.education[0], year: "2025" }],
    },
  }),
  false,
);
assert.equal(sameSnapshotValue([1, 2], [2, 1]), false);

// A stored commit drops undefined-valued keys (JSON serialization); the
// in-memory workspace keeps them. Both must still compare as equal.
assert.equal(
  sameSnapshotValue(
    JSON.parse(JSON.stringify({
      resume: { work: [{ id: "a", title: "x", mode: undefined, college: undefined }] },
    })),
    { resume: { work: [{ id: "a", title: "x", mode: undefined, college: undefined }] } },
  ),
  true,
);
// A key that gains a real value is still a change.
assert.equal(
  sameSnapshotValue(
    JSON.parse(JSON.stringify({ resume: { work: [{ id: "a", mode: undefined }] } })),
    { resume: { work: [{ id: "a", mode: "全日制" }] } },
  ),
  false,
);

console.log(
  JSON.stringify({
    status: "PASS",
    checks: [
      "nested object key order is ignored",
      "changed snapshot values are detected",
      "array order remains significant",
      "undefined-valued keys are ignored like in serialized snapshots",
    ],
  }),
);
