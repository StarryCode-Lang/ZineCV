export function validateAcceptanceIds(matrix) {
  if (!Array.isArray(matrix)) throw new Error("Feature matrix must be an array");
  const ids = new Set(matrix.map((entry) => entry?.featureId));
  if (ids.size !== matrix.length) throw new Error("Duplicate acceptance IDs in feature matrix");
  const mandatoryIds = new Set();
  for (const [prefix, count] of [["F", 44], ["D", 8]]) {
    for (let number = 1; number <= count; number += 1) {
      const id = `${prefix}${String(number).padStart(2, "0")}`;
      if (!ids.has(id)) throw new Error(`Missing acceptance item ${id}`);
      mandatoryIds.add(id);
    }
  }
  for (const entry of matrix) {
    if (mandatoryIds.has(entry.featureId)) continue;
    if (entry.supplemental !== true || !/^S-[A-Z0-9][A-Z0-9-]*$/.test(entry.featureId ?? "")) {
      throw new Error(`Supplemental item ${entry.featureId} needs supplemental: true and an S- ID`);
    }
  }
  return mandatoryIds;
}
