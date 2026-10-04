import { isTauriRuntime, nativeInvoke } from "./ipc";

export type WorkspaceViewSetting = "editor" | "templates" | "versions";
export type AgentModeSetting = "bot" | "composer" | "chat";
export type AgentAnchorSetting = { right: number; bottom: number } | null;
export type AgentSizeSetting = {
  chat: { width: number; height: number };
  composer: { width: number; height: number };
};

export type WorkspaceSettings = {
  editorPaneWidth: number;
  previewZoomPercent: number | null;
  workspaceView: WorkspaceViewSetting;
  collapsedSections: string[];
  agentMode: AgentModeSetting;
  agentPosition: AgentAnchorSetting;
  agentSizes: AgentSizeSetting;
};

export type WorkspaceSettingKey = keyof WorkspaceSettings;
export type WorkspaceSettingWrite = <K extends WorkspaceSettingKey>(
  key: K,
  value: WorkspaceSettings[K],
) => void;

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  editorPaneWidth: 560,
  previewZoomPercent: null,
  workspaceView: "editor",
  collapsedSections: ["basic", "summary"],
  agentMode: "composer",
  agentPosition: null,
  agentSizes: {
    chat: { width: 460, height: 540 },
    composer: { width: 460, height: 194 },
  },
};

function defaultWorkspaceSettings(): WorkspaceSettings {
  return {
    ...DEFAULT_WORKSPACE_SETTINGS,
    agentMode:
      typeof window !== "undefined" && window.innerWidth < 760
        ? "bot"
        : DEFAULT_WORKSPACE_SETTINGS.agentMode,
    collapsedSections: [...DEFAULT_WORKSPACE_SETTINGS.collapsedSections],
    agentSizes: {
      chat: { ...DEFAULT_WORKSPACE_SETTINGS.agentSizes.chat },
      composer: { ...DEFAULT_WORKSPACE_SETTINGS.agentSizes.composer },
    },
  };
}

const settingStorageKeys: Record<WorkspaceSettingKey, string> = {
  editorPaneWidth: "resume-diy-editor-pane-width",
  previewZoomPercent: "resume-diy-preview-zoom-v1",
  workspaceView: "resume-diy-active-workspace-view-v1",
  collapsedSections: "resume-diy-collapsed-sections-v1",
  agentMode: "resume-diy-agent-mode-v1",
  agentPosition: "resume-diy-agent-position-v1",
  agentSizes: "resume-diy-agent-size-v1",
};

const migrationMarker = "workspace-preferences-migrated-v1";
const writeTails = new Map<string, Promise<void>>();

function serializeSetting(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseRaw(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function validSizes(value: unknown): value is AgentSizeSetting {
  if (!value || typeof value !== "object") return false;
  const candidate = value as AgentSizeSetting;
  return [
    candidate.chat?.width,
    candidate.chat?.height,
    candidate.composer?.width,
    candidate.composer?.height,
  ].every((dimension) => Number.isFinite(dimension) && dimension >= 0 && dimension <= 4000);
}

function parseWorkspaceSettings(rawValues: Partial<Record<WorkspaceSettingKey, string>>): WorkspaceSettings {
  const result = defaultWorkspaceSettings();

  for (const key of Object.keys(settingStorageKeys) as WorkspaceSettingKey[]) {
    const raw = rawValues[key];
    if (raw === undefined || raw === null) continue;
    const value = parseRaw(raw);
    switch (key) {
      case "editorPaneWidth":
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 10_000)
          throw new Error("本地设置 editorPaneWidth 格式无效");
        result.editorPaneWidth = value;
        break;
      case "previewZoomPercent":
        if (value === null) {
          result.previewZoomPercent = null;
          break;
        }
        if (typeof value !== "number" || !Number.isFinite(value) || value < 20 || value > 200)
          throw new Error("本地设置 previewZoomPercent 格式无效");
        result.previewZoomPercent = value;
        break;
      case "workspaceView":
        if (value !== "editor" && value !== "templates" && value !== "versions")
          throw new Error("本地设置 workspaceView 格式无效");
        result.workspaceView = value;
        break;
      case "collapsedSections":
        if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
          throw new Error("本地设置 collapsedSections 格式无效");
        result.collapsedSections = [...new Set(value)];
        break;
      case "agentMode":
        if (value !== "bot" && value !== "composer" && value !== "chat")
          throw new Error("本地设置 agentMode 格式无效");
        result.agentMode = value;
        break;
      case "agentPosition":
        if (value !== null && (!value || typeof value !== "object" ||
            !Number.isFinite((value as AgentAnchorSetting)?.right) ||
            !Number.isFinite((value as AgentAnchorSetting)?.bottom)))
          throw new Error("本地设置 agentPosition 格式无效");
        result.agentPosition = value as AgentAnchorSetting;
        break;
      case "agentSizes":
        if (!validSizes(value)) throw new Error("本地设置 agentSizes 格式无效");
        result.agentSizes = value;
        break;
    }
  }
  return result;
}

function readCacheRaw(key: WorkspaceSettingKey): string | null {
  try {
    return window.localStorage.getItem(settingStorageKeys[key]);
  } catch {
    return null;
  }
}

export function readCachedWorkspaceSettings(): WorkspaceSettings {
  const rawValues: Partial<Record<WorkspaceSettingKey, string>> = {};
  for (const key of Object.keys(settingStorageKeys) as WorkspaceSettingKey[]) {
    const raw = readCacheRaw(key);
    if (raw !== null) rawValues[key] = raw;
  }
  try {
    return parseWorkspaceSettings(rawValues);
  } catch {
    return defaultWorkspaceSettings();
  }
}

async function readDatabaseSetting(key: string): Promise<string | null> {
  return ((await nativeInvoke("read_setting", { key })) as string | null) ?? null;
}

async function writeDatabaseSetting(key: string, value: string | null): Promise<void> {
  const previous = writeTails.get(key) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      await nativeInvoke("write_setting", { key, value });
    });
  writeTails.set(key, operation);
  try {
    await operation;
  } finally {
    if (writeTails.get(key) === operation) writeTails.delete(key);
  }
}

export async function loadWorkspaceSettings(): Promise<WorkspaceSettings> {
  if (!isTauriRuntime()) return readCachedWorkspaceSettings();

  const keys = Object.keys(settingStorageKeys) as WorkspaceSettingKey[];
  const [marker, ...values] = await Promise.all([
    readDatabaseSetting(migrationMarker),
    ...keys.map((key) => readDatabaseSetting(settingStorageKeys[key])),
  ]);
  const rawValues: Partial<Record<WorkspaceSettingKey, string>> = {};
  keys.forEach((key, index) => {
    const value = values[index];
    if (value !== null) rawValues[key] = value;
  });

  if (marker !== "1") {
    for (const key of keys) {
      if (rawValues[key] !== undefined) continue;
      // Legacy browser storage is an optional one-time migration source. Invalid or
      // inaccessible cache values are ignored; SQLite read/write failures still abort.
      let cached: string | null;
      try {
        cached = window.localStorage.getItem(settingStorageKeys[key]);
      } catch {
        continue;
      }
      if (cached === null) continue;
      try {
        parseWorkspaceSettings({ [key]: cached });
      } catch {
        continue;
      }
      await writeDatabaseSetting(settingStorageKeys[key], cached);
      rawValues[key] = cached;
    }
    await writeDatabaseSetting(migrationMarker, "1");
  }

  return parseWorkspaceSettings(rawValues);
}

export async function writeWorkspaceSetting<K extends WorkspaceSettingKey>(
  key: K,
  value: WorkspaceSettings[K],
): Promise<void> {
  const raw = serializeSetting(value);
  parseWorkspaceSettings({ [key]: raw });

  if (isTauriRuntime()) {
    await writeDatabaseSetting(settingStorageKeys[key], raw);
    try {
      window.localStorage.setItem(settingStorageKeys[key], raw);
    } catch {
      // SQLite has acknowledged the authoritative write; the browser cache is optional.
    }
    return;
  }

  try {
    if (value === null) window.localStorage.removeItem(settingStorageKeys[key]);
    else window.localStorage.setItem(settingStorageKeys[key], raw);
  } catch (error) {
    throw new Error(`本地设置 ${key} 写入失败`, { cause: error });
  }
}
