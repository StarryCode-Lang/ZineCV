import type { ResumeDocument } from "../../src-tauri/src/domain/bindings/ResumeDocument";
import type { ResumeVersionSnapshot } from "../ui/domain/version-model";

type LegacySource = NonNullable<ResumeVersionSnapshot["legacySourceArchive"]>;
const archivedSnapshots = new WeakMap<ResumeVersionSnapshot, LegacySource>();

function readLegacySource(document: ResumeDocument): LegacySource | null {
  const extensions = document.legacyExtensions ?? {};
  if (!("legacySourceSnapshot" in extensions) && !("legacySourceState" in extensions) && !("legacySourceHistory" in extensions)) return null;
  if ("legacySourceHistory" in extensions && !Array.isArray(extensions.legacySourceHistory)) {
    throw new Error("旧版原文历史无效，已停止操作");
  }
  return {
    ...("legacySourceSnapshot" in extensions ? { snapshot: extensions.legacySourceSnapshot } : {}),
    ...(typeof extensions.legacySourceState === "string" ? { rawState: extensions.legacySourceState } : {}),
    ...(Array.isArray(extensions.legacySourceHistory) ? { previous: extensions.legacySourceHistory } : {}),
  };
}

// Keep provenance out of normal snapshots and model contexts. It is attached
// only when a user explicitly creates a version backup.
export function rememberLegacySource(snapshot: ResumeVersionSnapshot, document: ResumeDocument): ResumeVersionSnapshot {
  const source = readLegacySource(document);
  if (source) archivedSnapshots.set(snapshot, structuredClone(source));
  return snapshot;
}

export function exportLegacySource(snapshot: ResumeVersionSnapshot, document?: ResumeDocument): ResumeVersionSnapshot {
  const source = document ? readLegacySource(document) : archivedSnapshots.get(snapshot);
  return source ? { ...snapshot, legacySourceArchive: structuredClone(source) } : snapshot;
}

export function restoreLegacySource(document: ResumeDocument, snapshot: ResumeVersionSnapshot): ResumeDocument {
  const source = snapshot.legacySourceArchive ?? archivedSnapshots.get(snapshot);
  if (source === undefined) return document;
  const validEntry = (entry: unknown): entry is { snapshot?: unknown; rawState?: string } => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    return (!("rawState" in item) || typeof item.rawState === "string") &&
      (!("snapshot" in item) || (!!item.snapshot && typeof item.snapshot === "object" && !Array.isArray(item.snapshot)));
  };
  if (!validEntry(source) || ("previous" in source && (!Array.isArray(source.previous) || !source.previous.every(validEntry)))) {
    throw new Error("版本备份中的旧版原文无效，已停止导入");
  }
  const old = readLegacySource(document);
  const current = { ...("snapshot" in source ? { snapshot: source.snapshot } : {}),
    ...("rawState" in source ? { rawState: source.rawState } : {}) };
  const oldCurrent = old && { ...("snapshot" in old ? { snapshot: old.snapshot } : {}),
    ...("rawState" in old ? { rawState: old.rawState } : {}) };
  const previous = [...(source.previous ?? []), ...(old?.previous ?? [])];
  if (oldCurrent && Object.keys(oldCurrent).length && JSON.stringify(oldCurrent) !== JSON.stringify(current)) previous.push(oldCurrent);
  const unique = [...new Map(previous.map((entry) => [JSON.stringify(entry), entry])).values()];
  const extensions = { ...document.legacyExtensions };
  delete extensions.legacySourceSnapshot;
  delete extensions.legacySourceState;
  delete extensions.legacySourceHistory;
  return {
    ...document,
    legacyExtensions: {
      ...extensions,
      ...("snapshot" in source ? { legacySourceSnapshot: structuredClone(source.snapshot) } : {}),
      ...("rawState" in source ? { legacySourceState: source.rawState } : {}),
      ...(unique.length ? { legacySourceHistory: structuredClone(unique) } : {}),
    },
  };
}

// The converted document does not represent every historical field or HTML
// attribute. Keep the original as provenance, not as the editable draft.
export function archiveLegacySource(document: ResumeDocument, source: ResumeVersionSnapshot, rawState?: string | null): ResumeDocument {
  return {
    ...document,
    legacyExtensions: {
      ...document.legacyExtensions,
      legacySourceSnapshot: structuredClone(source),
      ...(typeof rawState === "string" ? { legacySourceState: rawState } : {}),
    },
  };
}

// An editor snapshot contains only editable fields. Retain the immutable source
// archive from the same durable document when constructing the next draft.
export function retainLegacySource(document: ResumeDocument, durable: ResumeDocument): ResumeDocument {
  const original = durable.legacyExtensions ?? {};
  if (!("legacySourceSnapshot" in original) && !("legacySourceState" in original) && !("legacySourceHistory" in original)) return document;
  return {
    ...document,
    legacyExtensions: {
      ...document.legacyExtensions,
      ...("legacySourceSnapshot" in original ? { legacySourceSnapshot: original.legacySourceSnapshot } : {}),
      ...("legacySourceState" in original ? { legacySourceState: original.legacySourceState } : {}),
      ...("legacySourceHistory" in original ? { legacySourceHistory: original.legacySourceHistory } : {}),
    },
  };
}
