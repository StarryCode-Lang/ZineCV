import { useRef, useState } from "react";
import type { ImportCandidate } from "../../../src-tauri/src/domain/bindings/ImportCandidate";
import type { Entry } from "../../../src-tauri/src/domain/bindings/Entry";
import type { ModuleKind } from "../../../src-tauri/src/domain/bindings/ModuleKind";
import { moduleTitles } from "../domain/resume-model";
import { importBodyFromText, importBodyText, mergeImportEntries, splitImportEntry } from "../services/import-review-edits";

const entryFields = [
  ["title", "学校/单位/项目"], ["role", "专业/职位/身份"], ["department", "院系/部门"],
  ["city", "城市"], ["start", "开始时间"], ["end", "结束时间"],
] as const;

export function ImportCandidateEditor({ candidate, value, disabled, onChange }: {
  candidate: ImportCandidate;
  value: ImportCandidate["value"];
  disabled: boolean;
  onChange: (value: ImportCandidate["value"]) => void;
}) {
  const carets = useRef(new Map<string, number>());
  const [error, setError] = useState("");
  if (value.type === "basicField") return <label className="import-review-field">
    校正后的{candidate.label}
    <input aria-label={`校正${candidate.label}`} value={value.value} disabled={disabled}
      maxLength={2000} onChange={event => onChange({ ...value, value: event.currentTarget.value })} />
  </label>;
  if (value.type === "summaryBody") return <label className="import-review-field">
    校正后的正文（编辑后使用纯文本段落）
    <textarea aria-label={`校正${candidate.label}正文`} value={importBodyText(value.body)} disabled={disabled}
      maxLength={100_000} onChange={event => onChange({ ...value, body: importBodyFromText(event.currentTarget.value) })} />
  </label>;
  const replaceEntry = (index: number, replacement: Entry) => onChange({ ...value,
    entries: value.entries.map((entry, position) => position === index ? replacement : entry) });
  return <div className="import-review-entry-editor">
    <label className="import-review-field">模块归属
      <select aria-label={`${candidate.label}模块归属`} value={value.kind} disabled={disabled}
        onChange={event => {
          const kind = event.currentTarget.value as ModuleKind;
          onChange({ ...value, kind, title: moduleTitles[kind] });
        }}>
        {Object.entries(moduleTitles).map(([kind, title]) => <option key={kind} value={kind}>{title}</option>)}
      </select>
    </label>
    <p>拆分：把光标放在正文分界处，再选择“在光标处拆分”。合并保留第一条字段，后条不同字段会加入正文供核对。编辑正文后使用纯文本段落；原始候选保留供对照。</p>
    {error ? <p role="alert">{error}</p> : null}
    {value.entries.map((entry, index) => <fieldset key={entry.id} disabled={disabled}>
      <legend>经历 {index + 1}</legend>
      {entryFields.map(([field, label]) => <label key={field} className="import-review-field">{label}
        <input aria-label={`${candidate.label}经历${index + 1}${label}`} value={entry[field]} maxLength={2000}
          onChange={event => replaceEntry(index, { ...entry, [field]: event.currentTarget.value })} />
      </label>)}
      <label className="import-review-field">正文
        <textarea aria-label={`${candidate.label}经历${index + 1}正文`} value={importBodyText(entry.body)} maxLength={100_000}
          onSelect={event => carets.current.set(entry.id, event.currentTarget.selectionStart)}
          onChange={event => replaceEntry(index, { ...entry, body: importBodyFromText(event.currentTarget.value) })} />
      </label>
      <div className="import-review-entry-actions">
        <button type="button" onClick={() => {
          try {
            const split = splitImportEntry(entry, carets.current.get(entry.id) ?? 0);
            onChange({ ...value, entries: [...value.entries.slice(0, index), ...split, ...value.entries.slice(index + 1)] });
            setError("");
          } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
        }}>在光标处拆分经历 {index + 1}</button>
        <button type="button" disabled={index === value.entries.length - 1} onClick={() => {
          const merged = mergeImportEntries(entry, value.entries[index + 1]);
          onChange({ ...value, entries: [...value.entries.slice(0, index), merged, ...value.entries.slice(index + 2)] });
          setError("");
        }}>将经历 {index + 1} 与下一条合并</button>
      </div>
    </fieldset>)}
  </div>;
}
