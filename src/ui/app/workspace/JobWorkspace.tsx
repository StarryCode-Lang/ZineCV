import { useEffect, useMemo, useRef, useState } from "react";
import type { JobMaterial } from "../../../../src-tauri/src/domain/bindings/JobMaterial";
import type { JobMaterialListResult } from "../../../../src-tauri/src/domain/bindings/JobMaterialListResult";
import { hasDocumentRuntime } from "../../../platform/ipc";
import { loadJobMaterials, prepareJobDelete, prepareJobLink, prepareJobSave, prepareJobUnlink, type JobMaterialInput } from "../../../platform/jobs";
import type { ResumeState } from "../../domain/resume-model";
import type { ResumeVersionStore } from "../../domain/version-model";
import { jobFacts, jobRequirements, suggestJobEvidence } from "../../services/job-relevance";

const blank: JobMaterialInput = { title: "", company: "", jobDescription: "", sourceNote: "" };
const inputFrom = (material: JobMaterial | null): JobMaterialInput => material ? {
  title: material.title, company: material.company, jobDescription: material.jobDescription, sourceNote: material.sourceNote,
} : { ...blank };

export type JobTailoringSelection = { material: JobMaterial; referenceIds: string[] };

export function JobWorkspace({ resume, versions, disabled, onCreateBranch, onRequestTailoring }: {
  resume: ResumeState; versions: ResumeVersionStore; disabled: boolean;
  onCreateBranch: (name: string) => Promise<boolean>;
  onRequestTailoring?: (selection: JobTailoringSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<JobMaterialListResult>({ materials: [], links: [], revisions: [] });
  const [selected, setSelected] = useState<JobMaterial | null>(null);
  const [input, setInput] = useState<JobMaterialInput>({ ...blank });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [branchId, setBranchId] = useState(versions.currentBranchId);
  const [branchName, setBranchName] = useState("");
  const [selectedFacts, setSelectedFacts] = useState<string[]>([]);
  const [retry, setRetry] = useState<(() => Promise<void>) | null>(null);
  const [discard, setDiscard] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const facts = useMemo(() => open ? jobFacts(resume) : [], [open, resume]);
  const evidence = facts.filter(fact => selectedFacts.includes(fact.id));
  const requirements = useMemo(() => jobRequirements(selected?.jobDescription ?? ""), [selected]);
  const dirty = JSON.stringify(input) !== JSON.stringify(inputFrom(selected));

  useEffect(() => {
    if (!open) return;
    let active = true;
    dialog.current?.showModal();
    void loadJobMaterials().then(result => { if (active) setData(result); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; dialog.current?.close(); };
  }, [open]);

  const run = async (action: () => Promise<void>, retryable = true) => {
    if (busyRef.current || disabled) return;
    busyRef.current = true; setBusy(true); setError(""); setStatus("");
    try {
      await action();
      setData(await loadJobMaterials());
      setRetry(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      if (retryable) setRetry(() => action);
    } finally { busyRef.current = false; setBusy(false); }
  };
  const close = () => {
    if (busyRef.current) return;
    if (dirty || retry) { setDiscard(true); return; }
    setOpen(false);
  };
  const choose = (material: JobMaterial | null) => {
    if (dirty || retry) { setError("请先保存当前材料，或关闭并明确放弃修改后再选择其他材料"); return; }
    setSelected(material); setInput(inputFrom(material)); setSelectedFacts([]); setStatus(""); setError("");
  };
  const save = () => {
    const action = prepareJobSave(input, selected);
    void run(async () => {
      const material = await action();
      setSelected(material); setInput(inputFrom(material)); setStatus(`已保存材料修订 ${material.revision}`);
    });
  };
  const link = () => {
    if (!selected) return;
    const action = prepareJobLink(selected, branchId);
    void run(async () => { await action(); setStatus("岗位材料已关联所选分支"); });
  };
  if (!hasDocumentRuntime()) return null;
  return <>
    <button type="button" className="job-workspace-trigger" disabled={disabled} onClick={() => { setError(""); setOpen(true); }}>岗位定制</button>
    {open ? <dialog ref={dialog} className="job-workspace" aria-labelledby="job-workspace-title" inert={disabled || undefined}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }}
      onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}>
      <header><div><h2 id="job-workspace-title">岗位定制</h2><p>岗位材料保存在本机。先选择已有事实，再核对要求与缺口。</p></div><button type="button" disabled={busy} onClick={close}>关闭</button></header>
      {error ? <p role="alert" className="job-error">{error}</p> : null}
      {status ? <p role="status">{status}</p> : null}
      {retry ? <div className="job-actions"><button disabled={busy} onClick={() => void run(retry)}>重试上次操作</button><button disabled={busy} onClick={() => { setRetry(null); setError(""); }}>放弃重试，继续核对</button></div> : null}
      {discard ? <div role="alert" className="job-discard"><p>当前材料有未保存修改或未确认的操作。关闭将放弃本地修改；已经落盘的操作仍保留。</p><button onClick={() => setDiscard(false)}>返回核对</button><button onClick={() => { setSelected(null); setInput({ ...blank }); setRetry(null); setDiscard(false); setOpen(false); }}>放弃修改并关闭</button></div> : null}
      <div className="job-columns">
        <nav aria-label="岗位材料"><button disabled={busy || dirty || !!retry} onClick={() => choose(null)}>新建岗位材料</button>{data.materials.map(material =>
          <button key={material.id} className={selected?.id === material.id ? "is-active" : ""} disabled={busy} onClick={() => choose(material)}>{material.title}<small>{material.company || "未填写公司"} · 修订 {material.revision}</small></button>)}</nav>
        <section>
          <form onSubmit={event => { event.preventDefault(); save(); }}>
            <fieldset disabled={busy || !!retry}>
              <label>岗位名称<input required maxLength={160} value={input.title} onChange={event => setInput({ ...input, title: event.target.value })} /></label>
              <label>公司<input maxLength={160} value={input.company} onChange={event => setInput({ ...input, company: event.target.value })} /></label>
              <label>职位描述<textarea aria-label="职位描述" rows={7} maxLength={30000} value={input.jobDescription} onChange={event => setInput({ ...input, jobDescription: event.target.value })} /></label>
              <label>来源备注<input maxLength={2000} value={input.sourceNote} onChange={event => setInput({ ...input, sourceNote: event.target.value })} /></label>
              <button type="submit" disabled={!dirty || !input.title.trim()}>保存岗位材料</button>
            </fieldset>
          </form>
          {selected ? <>
            <section className="job-branches"><h3>岗位分支</h3><p>可在版本管理中先载入所需的已保存状态，再从当前内容创建独立岗位分支。其他分支不会随本分支编辑而改变。</p>
              <div className="job-actions"><input aria-label="新岗位分支名称" value={branchName} onChange={event => setBranchName(event.target.value)} maxLength={80} /><button disabled={busy || dirty || !!retry || !branchName.trim()} onClick={() => {
                const name = branchName.trim();
                void run(async () => { if (!await onCreateBranch(name)) throw new Error("岗位分支创建未完成，请核对版本列表后重试"); setBranchName(""); setStatus("岗位分支已创建，请在列表中选择并关联材料"); }, false);
              }}>从当前保存状态创建分支</button></div>
              <div className="job-actions"><select aria-label="关联岗位分支" value={branchId} onChange={event => setBranchId(event.target.value)}>{versions.branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><button disabled={busy || dirty || !!retry} onClick={link}>关联当前材料修订</button></div>
              <ul>{data.links.filter(item => item.jobMaterialId === selected.id).map(item => <li key={item.id}>
                {versions.branches.find(branch => branch.id === item.branchId)?.name ?? "分支已移除"} · 材料修订 {item.jobMaterialRevision}
                {item.jobMaterialRevision !== selected.revision ? <><strong> 材料已更新，请重新核对</strong><details><summary>查看当时依据</summary><pre>{data.revisions.find(revision => revision.id === selected.id && revision.revision === item.jobMaterialRevision)?.jobDescription ?? "历史依据不可用，请重新关联"}</pre></details></> : null}
                <button disabled={busy || !!retry} onClick={() => { const action = prepareJobUnlink(item.id); void run(async () => { await action(); }); }}>解除关联</button>
              </li>)}</ul>
            </section>
            <section><h3>选择可供核对的事实</h3><p>仅所选字段和经历用于对应。文字重合只是定位线索，需自行确认，未匹配项不会补写成经历。</p>
              <div className="job-facts">{facts.map(fact => <label key={fact.id}><input type="checkbox" checked={selectedFacts.includes(fact.id)} onChange={event => setSelectedFacts(current => event.target.checked ? [...current, fact.id] : current.filter(id => id !== fact.id))} />{fact.label}<small>{fact.text}</small></label>)}</div>
              <table><thead><tr><th>岗位要求</th><th>已有事实线索</th><th>缺口与建议</th></tr></thead><tbody>{requirements.map((requirement, index) => {
                const matches = suggestJobEvidence(requirement, evidence);
                return <tr key={index}><td>{requirement}</td><td>{matches.length ? matches.map(fact => <p key={fact.id}>{fact.label}：{fact.text}</p>) : "所选事实未找到文字线索"}</td><td>{matches.length ? "逐项核对真实职责、成果与要求，再优化表达" : "补充真实事实或保留缺口，不补造技能、经历或指标"}</td></tr>;
              })}</tbody></table>
              <button disabled={!onRequestTailoring || busy || dirty || !!retry || !evidence.length || evidence.length > 7} onClick={() => {
                onRequestTailoring?.({ material: selected, referenceIds: evidence.map(fact => fact.id) }); setOpen(false);
              }}>将所选事实与岗位送入助手草稿</button>
              {evidence.length > 7 ? <p role="alert">一次最多选择 7 项事实，另保留一个引用名额用于岗位材料；本地对照仍可查看全部事实。</p> : null}
              <p>不会自动发送或修改正文；发送前可核对范围，建议仍需逐项接受。未配置模型时仍可保存材料和手动管理岗位分支。</p>
            </section>
            <details><summary>删除岗位材料</summary><p>删除将同时移除本材料的历史修订和分支关联，不删除简历或分支。</p><button disabled={busy || dirty || !!retry} onClick={() => {
              const action = prepareJobDelete(selected.id);
              void run(async () => { await action(); setSelected(null); setInput({ ...blank }); });
            }}>确认删除此岗位材料及其修订</button></details>
          </> : null}
        </section>
      </div>
    </dialog> : null}
  </>;
}
