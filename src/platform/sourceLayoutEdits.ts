export type SourceLayoutEdits = { templateId: string; revisionHash?: string; edits: Record<string, string> };

// These values belong to one durable editing context, not to a global template.
// Reject malformed or cross-template data instead of silently dropping it.
export function parseSourceLayoutEdits(value: unknown, templateId: string | null, revisionHash?: string): SourceLayoutEdits | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("原版式文字数据无效");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !["templateId", "revisionHash", "edits"].includes(key))) throw new Error("原版式文字数据含未知字段");
  if (typeof data.templateId !== "string" || !data.templateId || data.templateId.length > 512 || data.templateId !== templateId) throw new Error("原版式文字所属模板不匹配");
  if ((data.revisionHash !== undefined && (typeof data.revisionHash !== "string" || !data.revisionHash || data.revisionHash.length > 512)) || data.revisionHash !== revisionHash) throw new Error("原版式文字所属模板修订不匹配");
  if (!data.edits || typeof data.edits !== "object" || Array.isArray(data.edits)) throw new Error("原版式文字数据无效");
  const entries = Object.entries(data.edits as Record<string, unknown>);
  if (entries.length > 10000 || entries.some(([key, text]) => !key || key.length > 512 || typeof text !== "string" || text.length > 65536)) {
    throw new Error("原版式文字数据无效或超过限制");
  }
  if (entries.reduce((total, [key, text]) => total + key.length + (text as string).length, 0) > 4 * 1024 * 1024) {
    throw new Error("原版式文字数据超过限制");
  }
  return { templateId: data.templateId, ...(typeof data.revisionHash === "string" ? { revisionHash: data.revisionHash } : {}), edits: Object.fromEntries(entries) as Record<string, string> };
}
