import { BranchTree } from "./BranchTree";
import { AnimatePresence } from "motion/react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  Download,
  ChevronDown,
  GitBranch,
  GitCommitHorizontal,
  HardDrive,
  Plus,
  Trash2,
  Upload,
  LocateFixed,
} from "lucide-react";
import type {
  ResumeBranch,
  ResumeCommit,
  ResumeVersionSnapshot,
  ResumeVersionStore,
} from "../../domain/version-model";
import {
  parseVersionBackup,
  type ParsedVersionBackup,
  type ResumeVersionBackup,
} from "../../services/version-backup";
import { motion, motionTransitions } from "../../motion/primitives";
import { getKeyboardNavigationIndex } from "../../utils/menu-keyboard";

const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

// 可视化版本库：提供提交、分支切换、历史恢复和分支删除。
export function VersionControlPanel({
  store,
  importedTemplateNames,
  storageStatus,
  storageBusy,
  dirty,
  onCommit,
  onCreateBranch,
  onExportBackup,
  onRequestImport,
  onLoadDraft,
  onSwitchBranch,
  onLoadCommit,
  onDeleteCommit,
  onJumpToBranch,
  onDeleteBranch,
}: {
  store: ResumeVersionStore;
  importedTemplateNames: Readonly<Record<string, string>>;
  storageStatus: string;
  storageBusy: boolean;
  dirty: boolean;
  onCommit: (message: string) => Promise<boolean> | boolean;
  onCreateBranch: (name: string) => Promise<boolean> | boolean;
  onExportBackup: (includeDraft: boolean) => void;
  onRequestImport: (backup: ResumeVersionBackup) => void;
  onLoadDraft: (snapshot: ResumeVersionSnapshot) => void;
  onSwitchBranch: (branchId: string) => void;
  onLoadCommit: (commit: ResumeCommit) => void;
  onDeleteCommit: (commit: ResumeCommit) => void;
  onJumpToBranch: (branch: ResumeBranch) => void;
  onDeleteBranch: (branch: ResumeBranch) => void;
}) {
  const [message, setMessage] = useState("");
  const [branchName, setBranchName] = useState("");
  const [submitting, setSubmitting] = useState<"commit" | "branch" | null>(
    null,
  );
  const submittingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const commitInputRef = useRef<HTMLTextAreaElement | null>(null);
  const branchMenuRef = useRef<HTMLDivElement | null>(null);
  const branchMenuId = useId();
  const [includeDraft, setIncludeDraft] = useState(false);
  const [importedBackup, setImportedBackup] =
    useState<ParsedVersionBackup | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [storageEstimate, setStorageEstimate] = useState<string | null>(null);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  useEffect(() => {
    if (!branchMenuOpen) return;
    branchMenuRef.current
      ?.querySelector<HTMLButtonElement>(
        '[role="option"][aria-selected="true"]',
      )
      ?.focus();
  }, [branchMenuOpen]);
  useEffect(() => {
    if (!branchMenuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!branchMenuRef.current?.contains(event.target as Node))
        setBranchMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setBranchMenuOpen(false);
      branchMenuRef.current
        ?.querySelector<HTMLButtonElement>(".themed-select-trigger")
        ?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [branchMenuOpen]);
  const currentBranch = store.branches.find(
    (branch) => branch.id === store.currentBranchId,
  );
  const commitDisabledReason = storageBusy
    ? "正在保存，请稍候"
    : submitting === "commit"
      ? "正在提交，请稍候"
      : !dirty
        ? "当前内容没有新修改"
        : !message.trim()
          ? "填写版本说明后可提交"
          : "";
  const branchDisabledReason = storageBusy
    ? "正在保存，请稍候"
    : submitting === "branch"
      ? "正在创建分支，请稍候"
      : !branchName.trim()
        ? "输入分支名称后可创建"
        : "";
  const submitCommit = async () => {
    const trimmed = message.trim();
    if (!trimmed || !dirty || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting("commit");
    try {
      if (await onCommit(trimmed)) setMessage("");
    } finally {
      submittingRef.current = false;
      setSubmitting(null);
    }
  };

  const submitBranch = async () => {
    const trimmed = branchName.trim();
    if (!trimmed || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting("branch");
    try {
      if (await onCreateBranch(trimmed)) setBranchName("");
    } finally {
      submittingRef.current = false;
      setSubmitting(null);
    }
  };

  const estimatedVersionBytes = useMemo(
    () => new Blob([JSON.stringify(store)]).size,
    [store],
  );
  useEffect(() => {
    let active = true;
    const storageManager = navigator.storage;
    if (!storageManager?.estimate) return;
    void storageManager.estimate().then(({ usage, quota }) => {
      if (!active || typeof usage !== "number") return;
      const quotaText =
        typeof quota === "number" ? ` / ${formatBytes(quota)}` : "";
      setStorageEstimate(`${formatBytes(usage)}${quotaText}`);
    });
    return () => {
      active = false;
    };
  }, [store]);

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      const parsed = parseVersionBackup(await file.text());
      setImportedBackup(parsed);
      setImportError(null);
      setDraftLoaded(false);
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : "备份文件读取失败",
      );
    }
  };

  return (
    <div className="version-workspace" data-version-workspace>
      <div className="version-heading">
        <div>
          <span className="version-kicker">
            <GitBranch size={14} /> 简历版本库
          </span>
          <h2>简历版本管理</h2>
          <p>保存关键节点，按投递方向创建独立分支。</p>
        </div>
        <button
          type="button"
          className={`working-state ${dirty ? "dirty" : "clean"}`}
          aria-label={
            dirty ? "有未提交修改，前往保存当前版本" : "当前内容已提交"
          }
          title={dirty ? "点击填写版本说明并提交" : "当前内容已提交"}
          disabled={!dirty || storageBusy}
          onClick={() => {
            commitInputRef.current?.scrollIntoView({
              behavior: "smooth",
              block: "center",
            });
            commitInputRef.current?.focus({ preventScroll: true });
          }}
        >
          <GitCommitHorizontal size={14} />
          {dirty ? "有未提交修改 · 点击提交" : "已同步到当前版本"}
        </button>
      </div>

      <p className="version-storage-status" role="status">
        {storageStatus}
      </p>
      <section className="version-section" data-version-section="branch">
        <div className="version-section-title">
          <GitBranch size={16} />
          <strong>当前分支</strong>
          <span>{store.branches.length} 个分支</span>
        </div>
        <div className="branch-toolbar">
          <div className="themed-select" ref={branchMenuRef}>
            <button
              type="button"
              className="themed-select-trigger"
              aria-label="切换简历分支"
              aria-haspopup="listbox"
              aria-controls={branchMenuId}
              aria-expanded={branchMenuOpen}
              disabled={storageBusy}
              onClick={() => setBranchMenuOpen((open) => !open)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setBranchMenuOpen(true);
                }
              }}
            >
              <span>{currentBranch?.name ?? "选择分支"}</span>
              <ChevronDown size={15} />
            </button>
            <AnimatePresence initial={false}>
              {branchMenuOpen ? (
                <motion.div
                  id={branchMenuId}
                  className="themed-select-menu"
                  role="listbox"
                  aria-label="简历分支"
                  initial={{ opacity: 0, y: -5, scale: 0.985 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -3, scale: 0.99 }}
                  transition={{
                    y: motionTransitions.standard,
                    scale: motionTransitions.standard,
                    opacity: motionTransitions.fade,
                  }}
                  onKeyDown={(event) => {
                    const options = Array.from(
                      event.currentTarget.querySelectorAll<HTMLButtonElement>(
                        '[role="option"]',
                      ),
                    );
                    const active = options.indexOf(
                      document.activeElement as HTMLButtonElement,
                    );
                    const nextIndex = getKeyboardNavigationIndex(
                      event.key,
                      active,
                      options.length,
                      "clamp",
                    );
                    if (nextIndex !== null) {
                      event.preventDefault();
                      options[nextIndex]?.focus();
                    }
                  }}
                >
                  {store.branches.map((branch) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={branch.id === store.currentBranchId}
                      key={branch.id}
                      onClick={() => {
                        setBranchMenuOpen(false);
                        branchMenuRef.current
                          ?.querySelector<HTMLButtonElement>(
                            ".themed-select-trigger",
                          )
                          ?.focus();
                        onSwitchBranch(branch.id);
                      }}
                    >
                      <span>{branch.name}</span>
                      {branch.id === store.currentBranchId ? (
                        <small>当前</small>
                      ) : null}
                    </button>
                  ))}
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
          <button
            className="branch-text-action"
            type="button"
            disabled={storageBusy || !currentBranch?.headCommitId}
            onClick={() => currentBranch && onJumpToBranch(currentBranch)}
          >
            <LocateFixed size={15} /> 跳转到当前分支
          </button>
          <button
            className="branch-text-action danger"
            aria-label="删除当前分支"
            title={
              storageBusy
                ? "正在保存，请稍候"
                : currentBranch?.id === "main"
                  ? "默认版本分支不可删除"
                  : "删除当前分支"
            }
            disabled={storageBusy || currentBranch?.id === "main"}
            onClick={() => currentBranch && onDeleteBranch(currentBranch)}
          >
            <Trash2 size={15} /> 删除当前分支
          </button>
        </div>
        <div className="branch-create-row">
          <input
            value={branchName}
            maxLength={30}
            placeholder="例如：项目投递版"
            aria-label="新分支名称"
            onChange={(event) => setBranchName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitBranch();
              }
            }}
          />
          <button
            aria-describedby="branch-create-hint"
            title={branchDisabledReason || "新建分支"}
            disabled={storageBusy || submitting !== null || !branchName.trim()}
            onClick={() => void submitBranch()}
          >
            <Plus size={15} /> 新建分支
          </button>
        </div>
        {branchDisabledReason ? (
          <p className="version-field-hint" id="branch-create-hint">
            {branchDisabledReason}
          </p>
        ) : null}
      </section>

      <section
        className="version-section commit-section"
        data-version-section="commit"
      >
        <div className="version-section-title">
          <GitCommitHorizontal size={16} />
          <strong>保存当前版本</strong>
        </div>
        <textarea
          ref={commitInputRef}
          value={message}
          maxLength={80}
          placeholder="写下这次修改，例如：完善项目经历"
          aria-label="版本说明"
          aria-describedby="commit-hint"
          onChange={(event) => setMessage(event.target.value)}
        />
        <button
          className="commit-button"
          aria-describedby="commit-hint"
          title={commitDisabledReason || "提交到当前分支"}
          disabled={
            storageBusy || submitting !== null || !dirty || !message.trim()
          }
          onClick={() => void submitCommit()}
        >
          <GitCommitHorizontal size={16} />
          {dirty ? "提交到当前分支" : "当前内容已提交"}
        </button>
        {commitDisabledReason ? (
          <p className="version-field-hint" id="commit-hint">
            {commitDisabledReason}
          </p>
        ) : null}
      </section>

      <section className="version-history" data-version-section="history">
        <BranchTree
          store={store}
          importedTemplateNames={importedTemplateNames}
          dirty={dirty}
          disabled={storageBusy}
          onLoad={onLoadCommit}
          onDelete={onDeleteCommit}
        />
      </section>

      <section
        className="version-section version-backup-section"
        data-version-section="backup"
      >
        <div className="version-section-title">
          <HardDrive size={16} />
          <strong>备份与迁移</strong>
        </div>
        <p className="version-capacity-hint">
          当前版本库数据约 {formatBytes(estimatedVersionBytes)}
          ；浏览器存储使用量
          {storageEstimate ? `估算为 ${storageEstimate}` : "暂不可估算"}
          。以上仅供参考，实际可用空间由浏览器和设备决定。
        </p>
        <div className="version-backup-actions">
          <button
            type="button"
            disabled={storageBusy}
            title={storageBusy ? "正在保存，请稍候" : "选择版本备份文件"}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={15} /> 选择版本备份
          </button>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept="application/json,.json"
            aria-label="选择版本备份文件"
            onChange={handleImportFile}
          />
          <label className="version-draft-option">
            <input
              type="checkbox"
              checked={includeDraft}
              disabled={!dirty || storageBusy}
              title={
                storageBusy
                  ? "正在保存，请稍候"
                  : !dirty
                    ? "当前内容没有新修改"
                    : "附带当前未提交草稿"
              }
              onChange={(event) => setIncludeDraft(event.target.checked)}
            />
            附带当前未提交草稿
          </label>
          <button
            type="button"
            disabled={storageBusy}
            title={storageBusy ? "正在保存，请稍候" : "导出版本备份"}
            onClick={() => onExportBackup(includeDraft && dirty)}
          >
            <Download size={15} /> 导出版本备份
          </button>
        </div>
        {importError ? (
          <p className="version-import-error" role="alert">
            {importError}；当前版本库未改变。
          </p>
        ) : null}
        {importedBackup ? (
          <div className="version-import-preview" role="status">
            <strong>已读取版本备份</strong>
            <p>
              包含 {importedBackup.branchCount} 个分支、
              {importedBackup.commitCount} 次提交
              {importedBackup.hasDraft ? "，以及 1 份未提交草稿" : ""}
              。替换只作用于版本库，不会自动载入草稿。
            </p>
            <div className="version-import-actions">
              {importedBackup.backup.draft ? (
                <button
                  type="button"
                  disabled={draftLoaded}
                  onClick={() => {
                    const draft = importedBackup.backup.draft;
                    if (!draft) return;
                    onLoadDraft(draft.snapshot);
                    setDraftLoaded(true);
                  }}
                >
                  {draftLoaded ? "草稿已载入" : "载入此草稿"}
                </button>
              ) : null}
              <button
                type="button"
                disabled={storageBusy}
                onClick={() => onRequestImport(importedBackup.backup)}
              >
                替换当前版本库
              </button>
              <button
                type="button"
                onClick={() => {
                  setImportedBackup(null);
                  setImportError(null);
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
