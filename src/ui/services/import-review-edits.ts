import type { Entry } from "../../../src-tauri/src/domain/bindings/Entry";
import type { RichBlock } from "../../../src-tauri/src/domain/bindings/RichBlock";
import { richBlockText } from "./export-checks";

export const importBodyText = richBlockText;

export function importBodyFromText(text: string): RichBlock[] {
  return text.replace(/\r\n?/g, "\n").split("\n").map(line => ({
    type: "paragraph", children: line ? [{ type: "text", text: line, marks: [] }] : [],
  }));
}

// Splitting is an explicit caret operation. Original candidates and evidence
// remain untouched; these are only editable review values until atomic apply.
export function splitImportEntry(entry: Entry, offset: number): [Entry, Entry] {
  const text = importBodyText(entry.body);
  if (!Number.isInteger(offset) || offset <= 0 || offset >= text.length
    || /[\uD800-\uDBFF]/u.test(text[offset - 1]) && /[\uDC00-\uDFFF]/u.test(text[offset])) {
    throw new Error("请把光标放在正文中需要拆分的位置，且不要拆开一个字符。");
  }
  const before = text.slice(0, offset), after = text.slice(offset);
  if (!before.trim() || !after.trim()) throw new Error("拆分后两条经历都需要保留正文。");
  return [
    { ...structuredClone(entry), body: importBodyFromText(before) },
    { ...structuredClone(entry), id: `${entry.id}:split:${crypto.randomUUID()}`, body: importBodyFromText(after) },
  ];
}

export function mergeImportEntries(first: Entry, next: Entry): Entry {
  const keys = ["title", "role", "department", "city", "start", "end", "college", "mode"] as const;
  const labels = ["标题", "身份", "院系/部门", "城市", "开始", "结束", "学院", "类型"];
  const differentFields = keys.flatMap((key, index) => next[key] && next[key] !== first[key]
    ? [`${labels[index]}：${next[key]}`] : []);
  return { ...structuredClone(first), body: [
    ...structuredClone(first.body),
    ...(differentFields.length ? importBodyFromText(`合并片段 · ${differentFields.join("；")}`) : []),
    ...structuredClone(next.body),
  ] };
}
