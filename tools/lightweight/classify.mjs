/**
 * classify.mjs — single source of truth for process role classification and memory
 * aggregation used by tools/lightweight/measure-memory.mjs (live) and
 * tools/lightweight/reclassify.mjs (offline re-derivation of already captured raw samples).
 *
 * Why structural classification: the sampler's hot loop deliberately avoids WMI, so live
 * samples carry pid/ppid/name but NOT command lines. Roles are therefore derived from
 * structure (which is what actually identifies the tree):
 *   - pid === host pid                                  -> host
 *   - zinecv-desktop.exe, pid !== host pid              -> renderWorker
 *   - msedgewebview2.exe whose parent is not WebView2   -> webview2Browser (direct child of the host)
 *   - other msedgewebview2.exe                          -> webview2Child
 * When a command line IS available (the pre-teardown CIM snapshot), it refines the label to
 * webview2Renderer / webview2Gpu / webview2Utility / webview2Crashpad via --type=, and it
 * verifies the render worker's --zinecv-render-worker switch.
 */

const isWorkerSwitch = (cmd) => /--zinecv-render-worker/.test(cmd || "");

export function classifyProcesses(procs, rootPid) {
  const webview2Pids = new Set((procs || []).filter((proc) => /^msedgewebview2\.exe$/i.test(proc.name)).map((proc) => proc.pid));
  // The browser process is the WebView2 process whose parent is not itself a WebView2 process.
  const browserPids = new Set((procs || [])
    .filter((proc) => webview2Pids.has(proc.pid) && !webview2Pids.has(proc.ppid))
    .map((proc) => proc.pid));
  const typeRoles = {
    renderer: "webview2Renderer",
    "gpu-process": "webview2Gpu",
    utility: "webview2Utility",
    "crashpad-handler": "webview2Crashpad",
  };
  return (procs || []).map((proc) => {
    if (proc.pid === rootPid) return { ...proc, role: "host" };
    if (/^zinecv-desktop\.exe$/i.test(proc.name)) {
      const cmd = proc.cmd || "";
      return { ...proc, role: "renderWorker",
        workerCommandLineVerified: cmd.length ? isWorkerSwitch(cmd) : null };
    }
    if (/^msedgewebview2\.exe$/i.test(proc.name)) {
      const type = /--type=([a-z0-9-]+)/.exec(proc.cmd || "")?.[1] ?? null;
      if (type && typeRoles[type]) return { ...proc, role: typeRoles[type], webview2Type: type, webview2RoleSource: "commandLine" };
      if (browserPids.has(proc.pid)) return { ...proc, role: "webview2Browser", webview2RoleSource: "structure" };
      return { ...proc, role: "webview2Child", webview2RoleSource: "structure" };
    }
    return { ...proc, role: "other" };
  });
}

/** The four reporting scopes the lightweight claim is graded on. */
export function scopeOf(role) {
  if (role === "host") return "host";
  if (role === "renderWorker") return "renderWorker";
  if (String(role).startsWith("webview2")) return "webview2";
  return "other";
}

/**
 * Aggregate one time window of derived samples.
 * `derived` entries: { tMs, atEpochMs, deltaMs, fastMs, cimMs, topologyRefreshed, procs[], byRole, totalWs, totalPriv }
 */
export function summarizeWindow(derived, fromMs, toMs) {
  const inside = derived.filter((sample) => sample.tMs >= fromMs && sample.tMs <= toMs);
  const roleNames = new Set();
  for (const sample of inside) for (const role of Object.keys(sample.byRole)) roleNames.add(role);

  const roles = {};
  for (const role of roleNames) {
    let maxWs = 0, maxPriv = 0, lastWs = 0, lastPriv = 0, maxCount = 0;
    for (const sample of inside) {
      const bucket = sample.byRole[role];
      if (!bucket) continue;
      maxWs = Math.max(maxWs, bucket.ws); maxPriv = Math.max(maxPriv, bucket.priv);
      maxCount = Math.max(maxCount, bucket.count);
      lastWs = bucket.ws; lastPriv = bucket.priv;
    }
    roles[role] = { maxWorkingSetBytes: maxWs, maxPrivateBytes: maxPriv, lastWorkingSetBytes: lastWs, lastPrivateBytes: lastPriv, maxProcessCount: maxCount };
  }

  const scopeNames = new Set(Object.keys(roles).map(scopeOf));
  const scopes = {};
  for (const scope of scopeNames) {
    let maxWs = 0, maxPriv = 0, lastWs = 0, lastPriv = 0, maxCount = 0;
    for (const sample of inside) {
      let ws = 0, priv = 0, count = 0;
      for (const [role, bucket] of Object.entries(sample.byRole)) {
        if (scopeOf(role) !== scope) continue;
        ws += bucket.ws; priv += bucket.priv; count += bucket.count;
      }
      maxWs = Math.max(maxWs, ws); maxPriv = Math.max(maxPriv, priv); maxCount = Math.max(maxCount, count);
      lastWs = ws; lastPriv = priv;
    }
    scopes[scope] = { maxWorkingSetBytes: maxWs, maxPrivateBytes: maxPriv, lastWorkingSetBytes: lastWs, lastPrivateBytes: lastPriv, maxProcessCount: maxCount };
  }

  const tree = { maxWorkingSetBytes: 0, maxPrivateBytes: 0, lastWorkingSetBytes: 0, lastPrivateBytes: 0, atMaxWorkingSetMs: null, maxProcessCount: 0 };
  for (const sample of inside) {
    if (sample.totalWs > tree.maxWorkingSetBytes) { tree.maxWorkingSetBytes = sample.totalWs; tree.atMaxWorkingSetMs = sample.tMs; }
    tree.maxPrivateBytes = Math.max(tree.maxPrivateBytes, sample.totalPriv);
    tree.lastWorkingSetBytes = sample.totalWs; tree.lastPrivateBytes = sample.totalPriv;
    tree.maxProcessCount = Math.max(tree.maxProcessCount, sample.procs.length);
  }
  return {
    windowMs: { from: fromMs, to: toMs },
    sampleCount: inside.length,
    firstSampleMs: inside.length ? inside[0].tMs : null,
    lastSampleMs: inside.length ? inside[inside.length - 1].tMs : null,
    tree,
    scopes,
    roles,
  };
}

/**
 * The fixed checkpoint windows, keyed off named timeline marks.
 * tOf(name) -> relative ms or null.
 */
export function computeWindows(derived, tOf, { idleSettleMs = 3000 } = {}) {
  return {
    coldBoot: summarizeWindow(derived, tOf("hostSpawned") ?? 0, tOf("draftReady") ?? 0),
    idle: summarizeWindow(derived, (tOf("contentPrepStart") ?? 0) - idleSettleMs, tOf("idleCheckpoint") ?? 0),
    contentPrep: summarizeWindow(derived, tOf("contentPrepStart") ?? 0, tOf("contentPrepDone") ?? 0),
    preview: summarizeWindow(derived, tOf("contentPrepDone") ?? 0, tOf("previewCheckpoint") ?? 0),
    export: summarizeWindow(derived, tOf("previewReleased") ?? 0, tOf("exportCheckpoint") ?? 0),
    whole: summarizeWindow(derived, 0, tOf("cleanupDone") ?? Number.MAX_SAFE_INTEGER),
  };
}

/** Build the per-sample derived view (role buckets + totals) from raw sampler samples. */
export function deriveSamples(rawSamples, rootPid, t0EpochMs) {
  return (rawSamples || [])
    .filter((entry) => entry.kind === "sample")
    .map((entry) => {
      // A process that already exited contributes nothing to the live tree sum.
      const procs = (entry.procs || []).filter((proc) => proc.present !== false);
      const classified = classifyProcesses(procs, rootPid);
      const byRole = {};
      let totalWs = 0, totalPriv = 0;
      for (const proc of classified) {
        const bucket = byRole[proc.role] ??= { ws: 0, priv: 0, count: 0 };
        bucket.ws += proc.ws; bucket.priv += proc.priv; bucket.count += 1;
        totalWs += proc.ws; totalPriv += proc.priv;
      }
      return {
        index: entry.index,
        atEpochMs: entry.atEpochMs,
        tMs: entry.atEpochMs - t0EpochMs,
        deltaMs: entry.deltaMs ?? null,
        fastMs: entry.fastMs ?? null,
        cimMs: entry.cimMs ?? null,
        queryMs: (entry.fastMs ?? 0) + (entry.cimMs ?? 0),
        topologyRefreshed: entry.topologyRefreshed === true,
        procs: classified,
        byRole,
        totalWs,
        totalPriv,
      };
    });
}
