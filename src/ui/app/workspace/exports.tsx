import type { Dispatch, SetStateAction } from "react";
import type { DatabaseBackupPayload } from "../../../../src-tauri/src/domain/bindings/DatabaseBackupPayload";
import type { DatabaseRestoreResult } from "../../../../src-tauri/src/domain/bindings/DatabaseRestoreResult";
import type { ExportResult } from "../../../../src-tauri/src/domain/bindings/ExportResult";
import type { NativeExportResult } from "../../../../src-tauri/src/domain/bindings/NativeExportResult";
import type { ExportWriteOutcome } from "../../../../src-tauri/src/domain/bindings/ExportWriteOutcome";
import type { ExportHostController } from "../ExportReviewHost";
import type { EditorNavigationTarget } from "../useEditorNavigation";
import { sameCursor } from "../../../platform/NativeDocumentClient";
import { loadJobMaterials } from "../../../platform/jobs";
import { platformCapabilities } from "../../../platform/capability";
import { hasDocumentRuntime as isTauriRuntime, nativeInvoke, NativeIpcError } from "../../../platform/ipc";
import {
  commitPreparedLegacyMigration,
  legacyMigrationNamespace,
  parseLegacyDataFile,
  prepareLegacyMigration,
} from "../../../platform/legacyImport";
import { materializeVersionStore } from "../../../platform/versionDetails";
import {
  flushDraftBeforeVersionAction,
  nativeClient
} from "../../../platform/workspace";
import { flushAgentSessionWrites } from "../../agent/sessions";
import type {
  ConfirmAction,
  ModuleKey,
  ResumeState,
  SectionKey
} from "../../domain/resume-model";
import type { ResumeVersionSnapshot, ResumeVersionStore } from "../../domain/version-model";
import { type HeaderPanel } from "../../layout/AppHeader";
import type { PreviewOverflowFinding } from "../../preview/PreviewOverflowGuard";
import { buildResumePlainText } from "../../services/resume-copy";
import { checkExportContent, checkExportJobSupport } from "../../services/export-checks";
import { checkExportOutput } from "../../services/export-output-checks";
import {
  createVersionBackup,
  type ResumeVersionBackup,
} from "../../services/version-backup";
import { downloadJsonBlob } from './shared';
export async function runCopyResume(context: {
  resume: ResumeState;
  moduleOrder: SectionKey[];
  moduleNames: Record<ModuleKey, string>;
  summaryTitle: string;
  notify: (message: string) => void;
}): Promise<void> {
  const { resume, moduleOrder, moduleNames, summaryTitle, notify } = context;

  const plain = buildResumePlainText({
    resume,
    moduleOrder,
    moduleNames,
    summaryTitle,
  });
  try {
    if (isTauriRuntime() && await nativeInvoke("write_clipboard_text", { text: plain })) {
      // Windows reports the actual native write result, including contention.
    } else if (navigator.clipboard?.writeText)
      await navigator.clipboard.writeText(plain);
    else {
      const textarea = document.createElement("textarea");
      textarea.value = plain;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        if (!document.execCommand("copy")) throw new Error("Clipboard rejected copy");
      } finally {
        textarea.remove();
      }
    }
    notify("简历文本已复制");
  } catch {
    notify("复制失败，剪贴板可能被占用或权限不足，请重试");
  }

}

export async function runExportVersionBackup(context: {
  versionStore: ResumeVersionStore;
  hasUncommittedChanges: boolean;
  workingSnapshot: ResumeVersionSnapshot;
  notify: (message: string) => void;
  exportFileName: string;
}, includeDraft: boolean): Promise<void> {
  const { versionStore, hasUncommittedChanges, workingSnapshot, notify, exportFileName } = context;

  let backup: ResumeVersionBackup;
  try {
    const documentId = nativeClient.snapshot?.document.documentId;
    const nativeDefaultBranchId = documentId ? `main:${documentId}` : "main";
    backup = createVersionBackup(
      await materializeVersionStore(versionStore),
      includeDraft && hasUncommittedChanges ? workingSnapshot : null,
      nativeDefaultBranchId,
    );
  } catch (error) {
    notify(error instanceof Error ? error.message : "版本备份导出失败");
    return;
  }
  downloadJsonBlob(
    `${exportFileName}-版本备份-${new Date().toISOString().slice(0, 10)}.json`,
    backup,
  );
  notify(
    includeDraft ? "版本备份已导出，包含当前未提交草稿" : "版本备份已导出",
  );

}

export async function runExportFullDatabaseBackup(context: {
  databaseBackupOperation: "exporting" | "restoring" | null;
  notify: (message: string) => void;
  setDatabaseBackupOperation: Dispatch<SetStateAction<"exporting" | "restoring" | null>>;
  exportFileName: string;
}): Promise<void> {
  const { databaseBackupOperation, notify, setDatabaseBackupOperation, exportFileName } = context;

  if (databaseBackupOperation) return;
  if (!isTauriRuntime()) {
    notify("完整数据库备份仅在桌面应用中可用");
    return;
  }
  setDatabaseBackupOperation("exporting");
  try {
    await flushDraftBeforeVersionAction();
    await flushAgentSessionWrites();
    const payload = (await nativeInvoke("export_database_backup")) as DatabaseBackupPayload;
    downloadJsonBlob(
      `${exportFileName}-完整数据库备份-${new Date().toISOString().slice(0, 10)}.json`,
      payload,
    );
    notify("完整数据库备份已导出；文件包含本机账户和加密连接密文，请妥善保管");
  } catch (error) {
    notify(error instanceof Error ? error.message : "完整数据库备份失败");
  } finally {
    setDatabaseBackupOperation(null);
  }

}

export async function runRequestFullDatabaseRestore(context: {
  notify: (message: string) => void;
  requestConfirmation: (action: ConfirmAction) => void;
  databaseBackupOperation: "exporting" | "restoring" | null;
  setDatabaseBackupOperation: Dispatch<SetStateAction<"exporting" | "restoring" | null>>;
}, file: File): Promise<void> {
  const { notify, requestConfirmation, databaseBackupOperation, setDatabaseBackupOperation } = context;

  const maximumFileBytes = 180 * 1024 * 1024;
  if (file.size > maximumFileBytes) {
    notify("完整数据库备份文件超过 180 MiB 上限");
    return;
  }
  try {
    const parsed = JSON.parse(await file.text()) as Partial<DatabaseBackupPayload>;
    if (
      parsed.format !== "zinecv-sqlite-full-backup" ||
      parsed.formatVersion !== 1 ||
      typeof parsed.databaseBase64 !== "string" ||
      typeof parsed.databaseSha256 !== "string" ||
      typeof parsed.schemaVersion !== "number"
    ) {
      throw new Error("文件不是受支持的完整数据库备份");
    }
    const payload = parsed as DatabaseBackupPayload;
    requestConfirmation({
      title: "恢复完整数据库？",
      description: `这会替换当前本机数据库中的简历、版本、模板、账户、对话与连接设置。恢复前会自动保留当前数据库副本。当前简历将先保存；恢复后需要重新登录。备份记录的 schema 为 ${payload.schemaVersion}，其中 ${payload.unavailableSecretCount ?? 0} 个 Key 在导出时已无法解密。当前文件包含加密保存的 Key 密文，但整个备份文件未加密。`,
      confirmLabel: "恢复完整数据库",
      onConfirm: () => {
        void (async () => {
          if (databaseBackupOperation) return;
          setDatabaseBackupOperation("restoring");
          try {
            await flushDraftBeforeVersionAction();
            await flushAgentSessionWrites();
            const result = (await nativeInvoke("restore_database_backup", {
              payload,
            })) as DatabaseRestoreResult;
            window.sessionStorage.setItem(
              "zinecv.full-database-restore-notice",
              JSON.stringify(result),
            );
            window.location.reload();
          } catch (error) {
            setDatabaseBackupOperation(null);
            const appError = error instanceof NativeIpcError ? error.detail : null;
            const reason = appError?.code === "STORAGE_CORRUPT"
              ? "备份文件未通过完整性或数据库校验"
              : "当前数据未能完成恢复";
            notify(
              `完整数据库恢复失败；${reason}，当前数据库未替换${appError?.diagnosticId ? `（诊断编号 ${appError.diagnosticId}）` : ""}`,
            );
          }
        })();
      },
    });
  } catch (error) {
    notify(error instanceof Error ? error.message : "完整数据库备份读取失败");
  }

}

export async function runImportLegacyBrowserData(context: {
  setPanel: (next: HeaderPanel, anchor?: HTMLElement | undefined) => void;
  requestConfirmation: (action: ConfirmAction) => void;
  refreshAfterLegacyMigration: () => Promise<void>;
  notify: (message: string) => void;
}, file: File): Promise<void> {
  const { setPanel, requestConfirmation, refreshAfterLegacyMigration, notify } = context;

  setPanel(null);
  try {
    const raw = await file.text();
    const json = JSON.parse(raw);
    const parsed = parseLegacyDataFile(json);
    await flushDraftBeforeVersionAction();
    const cursor = nativeClient.snapshot?.cursor;
    if (!cursor) throw new Error("本机文档尚未载入");
    const namespace = await legacyMigrationNamespace(parsed, file.name);
    const prepared = await prepareLegacyMigration(raw, parsed, cursor, namespace);
    const branchCount = parsed.store?.branches.length ?? 0;
    const commitCount = parsed.store?.commits.length ?? 0;
    const reviewMessages = [...prepared.report.issues, ...prepared.report.sources.flatMap((source) => source.issues)]
      .filter((issue) => issue.severity === "review")
      .map((issue) => issue.message);
    const conflictLabels = prepared.report.conflicts.map((conflict) => conflict.entityKind);
    const identityConflictSummary = prepared.identityConflicts.length
      ? `检测到 ${prepared.identityConflicts.length} 个已导入实体的内容发生变化（${prepared.identityConflicts.slice(0, 4).map((conflict) => `${conflict.entityKind}:${conflict.legacyId}，已有 ${conflict.existingVariantCount} 个版本`).join("；")}）。确认后会按内容生成独立身份并追加，保留旧记录，不覆盖。`
      : "未发现与本机迁移映射冲突的实体。";
    requestConfirmation({
      title: "审阅并导入旧版数据？",
      description: `来源命名空间：${namespace}（重复导入会复用本机身份映射）。原生预演检查了 ${prepared.report.sources.length} 个来源、${prepared.dryRun.stagedDocumentCount} 个转换文档；${parsed.store ? `将追加 ${branchCount} 个分支、${commitCount} 次提交` : "未发现版本图"}；${prepared.request.currentDraft ? "当前工作区草稿会按本次确认更新" : "当前工作区草稿保持不变"}。${identityConflictSummary}${conflictLabels.length ? `另有跨文件冲突类别：${[...new Set(conflictLabels)].join("、")}；同名分支会附加来源标识并分别保留。` : "未发现跨文件来源冲突。"}${reviewMessages.length ? `待确认提示：${[...new Set(reviewMessages)].slice(0, 5).join("；")}` : "没有待确认的结构提示。"}本次在一个 SQLite 事务中写入版本图、可选草稿、模板、偏好、来源映射和幂等回执；另将迁入 ${prepared.report.totals.accountRecords} 个账户、${prepared.report.totals.providerProfiles} 个公开连接配置、${prepared.report.totals.agentSessions} 个 Agent 会话。旧 Key 不迁入，需重新输入；活跃登录令牌不迁入，旧运行标记中断。资源文件等剩余类别以提交回执为准，不计入完整迁移。`,
      confirmLabel: "确认并原子导入",
      onConfirm: () => {
        void (async () => {
          const receipt = await commitPreparedLegacyMigration(prepared);
          await refreshAfterLegacyMigration();
          notify(`旧版迁移已原子提交：新增 ${receipt.versionBranchCount} 个分支、${receipt.versionCommitCount} 次提交${receipt.currentDraftApplied ? "，已应用确认的当前草稿" : "，当前草稿保持不变"}；账户 ${receipt.accountCount} 个、连接 ${receipt.providerCount} 个、会话 ${receipt.sessionCount} 个，${receipt.secretReentryCount} 个连接需重输 Key。未迁移：${receipt.remainingCategories.join("、")}`);
        })().catch((error) => {
          notify(error instanceof Error ? error.message : "旧版数据导入失败；原数据未改动");
        });
      },
    });
  } catch (error) {
    notify(error instanceof Error ? error.message : "旧版数据导入失败");
  }

}

export async function runDownloadResume(context: {
  exportingFormat: "pdf" | "png" | null;
  previewOverflow: PreviewOverflowFinding | null;
  notify: (message: string) => void;
  previewOverflowMessage: string | null;
  setPanel: (next: HeaderPanel, anchor?: HTMLElement) => void;
  setExportingFormat: Dispatch<SetStateAction<"pdf" | "png" | null>>;
  exportFileName: string;
  exportHost?: ExportHostController | null;
  branchName?: string;
  navigateToEditor?: (target: EditorNavigationTarget) => void;
}, format: "pdf" | "png", dpi?: number): Promise<void> {
  const { exportingFormat, previewOverflow, previewOverflowMessage, setPanel, setExportingFormat,
    exportHost, navigateToEditor } = context;
  const notify = exportHost?.notify ?? context.notify;
  if (exportingFormat) return;
  if (previewOverflow) { notify(previewOverflowMessage || "预览内容超出 A4 可用区域，导出已暂停。"); return; }
  if (!exportHost) { notify("投递检查界面尚未就绪，请重新打开完整工作区。"); return; }
  if (!exportHost.begin(format)) return;
  setPanel(null); setExportingFormat(format);
  let sourceLabel = "当前简历", completed = 0, expectedFiles = 1;
  const nativeFiles = platformCapabilities().nativeDialogs;
  const recordingErrors: string[] = [];
  let frozenDocumentId: string | null = null;
  try {
    // Capture before flushing: a click on A must never render B after an await.
    const clickedTarget = nativeClient.captureTarget();
    await flushDraftBeforeVersionAction();
    nativeClient.assertTarget(clickedTarget);
    const state = await nativeClient.reload();
    nativeClient.assertTarget(clickedTarget);
    const cursor = structuredClone(state.cursor), document = structuredClone(state.document);
    sourceLabel = document.title || "未命名简历";
    const branchName = context.branchName || "当前分支";
    const findings = checkExportContent(document);
    if (state.pendingImportCount) findings.push({ id: "pending-import", severity: "suggestion", field: "imports",
      message: `本简历还有 ${state.pendingImportCount} 份未完成的导入核对；未确认候选不会自动纳入本次导出。` });
    const jobs = nativeFiles ? await loadJobMaterials() : { materials: [], links: [], revisions: [] };
    const jobSupport = checkExportJobSupport(document, cursor.branchId, jobs);
    findings.push(...jobSupport.findings);
    if (!nativeClient.snapshot || !sameCursor(cursor, nativeClient.snapshot.cursor)) throw new Error("检查期间目标修订已变化，请重新导出");
    const date = new Date().toISOString().slice(0, 10);
    const suggestedName = `${sourceLabel}-${branchName}-${date}`.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").slice(0, 100);
    const decision = await exportHost.review({ cursor, documentTitle: sourceLabel, branchName, format,
      findings, jobEvidence: jobSupport.evidence, recentExports: state.recentExports,
      phase: "content", fileName: suggestedName }, navigateToEditor);
    if (!decision.proceed) { notify(`已取消“${sourceLabel}”的导出`); return; }
    if (findings.some(finding => finding.severity === "error")) throw new Error("投递检查仍有需要处理的错误");
    if (!nativeClient.snapshot || !sameCursor(cursor, nativeClient.snapshot.cursor)) throw new Error("检查后目标修订已变化，请重新导出");
    const fileName = (decision.fileName || suggestedName).replace(new RegExp(`\\.${format}$`, "i"), "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "").trim();
    if (!fileName) throw new Error("导出文件名不能为空");
    notify(`正在冻结“${sourceLabel}”并生成 ${format.toUpperCase()}…`);
    const bundle = await nativeInvoke("render_document_export", { cursor, product: format,
      ...(format === "png" && dpi !== undefined ? { dpi } : {}) }) as ExportResult | NativeExportResult;
    if (!bundle?.cursor || !sameCursor(bundle.cursor, cursor) || !bundle.renderKey) throw new Error("导出回执与请求的冻结修订不一致");
    const nativeBundle = "exportId" in bundle ? bundle : null;
    frozenDocumentId = nativeBundle ? bundle.cursor.documentId : null;
    if (nativeFiles && (!nativeBundle?.exportId || !nativeBundle.source || !nativeBundle.artifacts.length)) throw new Error("当前宿主无法确认导出来源，请重新打开更新后的应用");
    sourceLabel = `${nativeBundle?.source.documentTitle || sourceLabel} / ${nativeBundle?.source.branchName || branchName} / 修订 ${bundle.cursor.revision}`;
    // From here onward, a document switch is allowed. Validate the frozen reply,
    // never replace its identity or bytes with the newly active workspace.
    const outputFindings = await checkExportOutput(bundle, format);
    if (outputFindings.length) {
      await exportHost.review({ cursor: bundle.cursor, documentTitle: nativeBundle?.source.documentTitle || document.title,
        branchName: nativeBundle?.source.branchName || branchName, format, findings: outputFindings, phase: "output" }, navigateToEditor);
      notify(`“${sourceLabel}”的冻结文件检查未通过，没有写入文件。`); return;
    }
    const saveFile = async (path: string, dataBase64: string, artifactId: string) => {
      const artifact = nativeBundle?.artifacts.find(item => item.artifactId === artifactId);
      if (nativeBundle && !artifact) throw new Error("冻结产物标识缺失，未执行写盘");
      const args = { path, dataBase64, ...(nativeBundle ? { exportId: nativeBundle.exportId, artifactId, writeId: crypto.randomUUID() } : {}) };
      let outcome: ExportWriteOutcome | null;
      try { outcome = await nativeInvoke("write_export_file", args) as ExportWriteOutcome | null; }
      catch (reason) {
        // A lost response retries the exact write identity; the native host
        // checks the existing file and never overwrites an external change.
        if (!nativeBundle || reason instanceof NativeIpcError && !reason.detail.retryable) throw reason;
        outcome = await nativeInvoke("write_export_file", args) as ExportWriteOutcome;
      }
      if (nativeFiles && (!outcome || outcome.bytes !== artifact?.bytes || outcome.sha256 !== artifact.sha256)) throw new Error("写盘回执异常；文件可能已保存，请核对所选目标位置");
      completed++;
      if (nativeFiles && outcome && (outcome.recordingError || !outcome.receipt)) recordingErrors.push(outcome.recordingError || "宿主未返回导出记录");
    };
    const data = bundle.data;
    if (format === "pdf" || data.longPng && !data.longImageLimited) {
      const target = await nativeInvoke("pick_export_path", { kind: format, defaultName: `${fileName}.${format}` });
      if (typeof target !== "string") { notify(`已取消“${sourceLabel}”的保存`); return; }
      await saveFile(target, format === "pdf" ? data.pdfBase64 : data.longPng!.dataBase64, format === "pdf" ? "pdf" : "png:long");
      notify(recordingErrors.length ? `“${sourceLabel}”的文件已保存，但导出记录失败：${recordingErrors.join("；")}`
        : nativeFiles ? `“${sourceLabel}”已保存：${target}` : `“${sourceLabel}”已发起下载：${target}`);
    } else {
      expectedFiles = data.pngPages.length;
      const directory = await nativeInvoke("pick_export_directory");
      if (typeof directory !== "string") { notify(`已取消“${sourceLabel}”的保存`); return; }
      for (const page of data.pngPages) await saveFile(`${directory}\\${fileName}-第${page.page}页.png`, page.dataBase64, `png:${page.page}`);
      notify(recordingErrors.length ? `“${sourceLabel}”已保存 ${completed} 页，但部分导出记录失败：${recordingErrors.join("；")}`
        : nativeFiles ? `“${sourceLabel}”已按 ${completed} 页保存到 ${directory}` : `“${sourceLabel}”已发起 ${completed} 页图片下载`);
    }
  } catch (reason) {
    const detail = reason instanceof Error ? reason.message : String(reason);
    const recordNotice = recordingErrors.length ? `；已保存文件的导出记录失败：${recordingErrors.join("；")}` : "";
    notify(completed ? `“${sourceLabel}”已${nativeFiles ? "保存" : "发起下载"} ${completed}/${expectedFiles} 个文件，后续导出未完成：${detail}${recordNotice}`
      : `“${sourceLabel}”导出未完成：${detail}`);
  } finally {
    if (completed && frozenDocumentId && nativeClient.snapshot?.cursor.documentId === frozenDocumentId) {
      await nativeClient.reload().catch(() => {});
    }
    setExportingFormat(null); exportHost.finish();
  }
}
