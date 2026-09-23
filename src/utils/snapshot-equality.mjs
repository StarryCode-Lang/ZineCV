export function sameSnapshotValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameSnapshotValue(value, right[index]))
    );
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  const leftObject = left;
  const rightObject = right;
  // Snapshots are persisted as JSON, so keys whose value is undefined are
  // dropped when a commit is stored. Ignore them on both sides to keep the
  // in-memory workspace comparable with its serialized HEAD.
  const keys = Object.keys(leftObject).filter(
    (key) => leftObject[key] !== undefined,
  );
  const rightKeys = new Set(
    Object.keys(rightObject).filter((key) => rightObject[key] !== undefined),
  );
  return (
    keys.length === rightKeys.size &&
    keys.every((key) =>
      rightKeys.has(key)
        ? sameSnapshotValue(leftObject[key], rightObject[key])
        : false,
    )
  );
}
