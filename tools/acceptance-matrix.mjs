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

// Stored contexts avoid repeating run identity on every feature. Consumers get plain rows.
export function decodeFeatureMatrix(value) {
  if (Array.isArray(value)) return structuredClone(value);
  if (value?.schemaVersion !== 2 || !Array.isArray(value.features) || !value.contexts) throw new Error("Invalid feature matrix format");
  return value.features.map(({ contextRef, ...row }) => {
    if (contextRef === undefined) return structuredClone(row);
    if (!Object.hasOwn(value.contexts, contextRef)) throw new Error(`Unknown feature context: ${contextRef}`);
    const context = value.contexts[contextRef];
    if (!context || typeof context !== "object" || Array.isArray(context) || Object.keys(context).some(key=>!["revision","environment"].includes(key))) throw new Error(`Invalid feature context: ${contextRef}`);
    if (Object.hasOwn(row, "revision") || Object.hasOwn(row, "environment")) throw new Error("Feature context conflicts with inline identity");
    return structuredClone({ ...row, ...context });
  });
}

export function encodeFeatureMatrix(rows) {
  const contexts = {}, keys = new Map();
  const features = rows.map(({revision, environment, ...row}) => {
    // Rows without a captured context remain editable without inventing one.
    const context = { ...(revision !== undefined ? {revision} : {}), ...(environment !== undefined ? {environment} : {}) };
    if (!Object.keys(context).length) return structuredClone(row);
    const signature = JSON.stringify(context);
    if (!keys.has(signature)) {
      const key = `context-${keys.size + 1}`;
      keys.set(signature, key); contexts[key] = context;
    }
    return structuredClone({...row, contextRef:keys.get(signature)});
  });
  return {schemaVersion:2,contexts,features};
}

// Historical batch records share run defaults and successful checks, without dropping facts.
export function decodeEvidenceBundle(value) {
  if (value?.schemaVersion === 1) return structuredClone(value);
  if (value?.schemaVersion !== 2 || !value.records || !value.recordDefaults || !value.checks) throw new Error("Invalid evidence bundle format");
  const {recordDefaults, checks, records, ...metadata} = value;
  return {...structuredClone(metadata),schemaVersion:1,records:Object.fromEntries(Object.entries(records).map(([id, record]) => {
    const {checkRefs, ...fields} = record;
    if (!Array.isArray(checkRefs)) throw new Error(`Missing checks for ${id}`);
    if (Object.hasOwn(fields,"checks")) throw new Error(`Conflicting evidence checks for ${id}`);
    const expanded = {...recordDefaults,...fields,checks:checkRefs.map(ref=>{
      if (!Object.hasOwn(checks, ref)) throw new Error(`Unknown evidence check: ${ref}`);
      return checks[ref];
    })};
    if (expanded.featureId !== id) throw new Error(`Evidence feature mismatch: ${id}`);
    return [id,structuredClone(expanded)];
  }))};
}

export function encodeEvidenceBundle(value) {
  const source = decodeEvidenceBundle(value);
  const rows = Object.values(source.records);
  const recordDefaults = {};
  for (const key of ["schemaVersion","revision","recordedAt","coverageStatus","provenance"]) {
    if (rows.length && rows[0][key] !== undefined && rows.every(row=>JSON.stringify(row[key])===JSON.stringify(rows[0][key]))) recordDefaults[key]=rows[0][key];
  }
  const checks={}, signatures=new Map();
  const records=Object.fromEntries(Object.entries(source.records).map(([id, record])=>{
    const {checks:recordChecks,...fields}=structuredClone(record);
    for (const key of Object.keys(recordDefaults)) delete fields[key];
    const checkRefs=recordChecks.map(check=>{
      const signature=JSON.stringify(check);
      if (!signatures.has(signature)) {
        const base=/^[a-z0-9][a-z0-9:_-]*$/i.test(check.stage ?? "") ? check.stage : `check-${signatures.size+1}`;
        let key=base;
        for(let suffix=2;Object.hasOwn(checks,key);suffix++) key=`${base}-${suffix}`;
        signatures.set(signature,key);checks[key]=check;
      }
      return signatures.get(signature);
    });
    return [id,{...fields,checkRefs}];
  }));
  return {...source,schemaVersion:2,recordDefaults,checks,records};
}
