// 模板元数据与简历正文分离：切换模板只能改变 presentation，不能改写 ResumeState。
export const TEMPLATE_SNAPSHOT_SCHEMA_VERSION = 2 as const;
const LEGACY_TEMPLATE_ID = "legacy-v1" as const;

export type KnownTemplateId =
  typeof LEGACY_TEMPLATE_ID | "clear-single-v1" | "compact-single-v1";

export type DensityPreset = "comfortable" | "standard" | "compact";
type PresentationOverride = string | number;

export type ResumePresentation = {
  templateId: string;
  templateVersion: number;
  densityPreset: DensityPreset;
  overrides: Record<string, PresentationOverride>;
};

type ResolvedPresentation = {
  stored: ResumePresentation;
  resolvedTemplateId: KnownTemplateId;
  fallbackReason: "unknown-template" | "unknown-version" | null;
};

const defaultLegacyPresentation = (): ResumePresentation => ({
  templateId: LEGACY_TEMPLATE_ID,
  templateVersion: 1,
  densityPreset: "standard",
  overrides: {},
});

const densityPresets = new Set<DensityPreset>([
  "comfortable",
  "standard",
  "compact",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// 只清理无法序列化的覆盖值；未知字段继续保留，供未来模板恢复或导出诊断。
export function normalizePresentation(value: unknown): ResumePresentation {
  if (!isRecord(value)) return defaultLegacyPresentation();
  const templateId =
    typeof value.templateId === "string" && value.templateId.trim()
      ? value.templateId
      : LEGACY_TEMPLATE_ID;
  const templateVersion =
    typeof value.templateVersion === "number" &&
    Number.isInteger(value.templateVersion) &&
    value.templateVersion > 0
      ? value.templateVersion
      : 1;
  const densityPreset = densityPresets.has(value.densityPreset as DensityPreset)
    ? (value.densityPreset as DensityPreset)
    : "standard";
  const overrides = isRecord(value.overrides)
    ? Object.fromEntries(
        Object.entries(value.overrides).filter(
          (entry): entry is [string, PresentationOverride] =>
            typeof entry[1] === "string" ||
            (typeof entry[1] === "number" && Number.isFinite(entry[1])),
        ),
      )
    : {};
  return { templateId, templateVersion, densityPreset, overrides };
}

export function resolvePresentation(
  value: unknown,
  availableVersions: Readonly<Record<KnownTemplateId, number>>,
): ResolvedPresentation {
  const stored = normalizePresentation(value);
  if (!(stored.templateId in availableVersions)) {
    return {
      stored,
      resolvedTemplateId: LEGACY_TEMPLATE_ID,
      fallbackReason: "unknown-template",
    };
  }
  const templateId = stored.templateId as KnownTemplateId;
  if (stored.templateVersion !== availableVersions[templateId]) {
    return {
      stored,
      resolvedTemplateId: LEGACY_TEMPLATE_ID,
      fallbackReason: "unknown-version",
    };
  }
  return { stored, resolvedTemplateId: templateId, fallbackReason: null };
}
