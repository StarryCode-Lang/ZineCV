import { LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppUpdateController } from "../app/useAppUpdate";
import {
  fetchAppUpdateState,
  subscribeAppUpdateState,
  type UpdaterStatus,
} from "../../platform/appUpdate";

// 更新面板：面板打开期间自行订阅权威状态事件（初始拉取 + 订阅，关闭即
// 取消），下载进度的高频更新只重渲染面板子树，不波及 App。发布说明
// （notes）是远端不可信输入，只以纯文本渲染；total 为 null 表示服务器
// 未报告大小。
function useUpdaterStatusWhileOpen(): UpdaterStatus | null {
  const [status, setStatus] = useState<UpdaterStatus | null>(null);
  useEffect(() => {
    let disposed = false;
    let disposedCleanup: (() => void) | null = null;
    void fetchAppUpdateState().then((initial) => {
      if (!disposed && initial) setStatus(initial);
    });
    void subscribeAppUpdateState((next) => {
      if (!disposed) setStatus(next);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else disposedCleanup = unlisten;
    });
    return () => {
      disposed = true;
      disposedCleanup?.();
    };
  }, []);
  return status;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatPubDate(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}

export function UpdatePanel({ controller }: { controller: AppUpdateController }) {
  const { autoBackgroundCheck, setAutoBackgroundCheck, check, download, cancelDownload, install } =
    controller;
  const status = useUpdaterStatusWhileOpen();
  const [actionError, setActionError] = useState<string | null>(null);
  const phase = status?.phase ?? "unconfigured";
  const busy = phase === "checking" || phase === "downloading" || phase === "installing";
  const target = status && "target" in status ? status.target : null;
  const received = status && "received" in status ? (status.received as number) : 0;
  const total = status?.phase === "downloading" ? status.total : null;

  const runAction = (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setActionError(null);
    void action().then((result) => {
      if (!result.ok && result.error) setActionError(result.error);
    });
  };

  return (
    <div className="floating-menu update-menu" role="dialog" aria-label="应用更新">
      <div className="download-menu-heading">
        <strong>应用更新</strong>
        <span>当前版本 {status?.currentVersion ?? "…"}</span>
      </div>

      {phase === "unconfigured" ? (
        <p className="update-status-line">此构建未配置更新服务（无签名端点），更新功能不可用。</p>
      ) : null}

      {phase === "checking" ? (
        <p className="update-status-line" role="status">
          <LoaderCircle className="export-spinner" size={15} /> 正在检查更新…
        </p>
      ) : null}

      {phase === "idle" ? (
        <p className="update-status-line">尚未检查更新或上次检查未完成。</p>
      ) : null}

      {phase === "upToDate" ? <p className="update-status-line">已是最新版本。</p> : null}

      {target ? (
        <div className="update-target">
          <strong>
            新版本 {target.version}
            {target.cached ? "（已在本机缓存）" : ""}
          </strong>
          {formatPubDate(target.pubDate) ? <small>{formatPubDate(target.pubDate)}</small> : null}
          {target.notes ? <p className="update-notes">{target.notes}</p> : null}
        </div>
      ) : null}

      {phase === "downloading" ? (
        <div className="update-progress" role="status">
          {total !== null && total > 0 ? (
            <>
              <div className="update-progress-bar">
                <div
                  className="update-progress-fill"
                  style={{ width: `${Math.min(100, (received / total) * 100).toFixed(1)}%` }}
                />
              </div>
              <small>
                {formatBytes(received)} / {formatBytes(total)}（
                {Math.min(100, Math.round((received / total) * 100))}%）
              </small>
            </>
          ) : (
            <small>正在下载，已接收 {formatBytes(received)}（服务器未报告总大小）</small>
          )}
        </div>
      ) : null}

      {phase === "readyToInstall" ? (
        <p className="update-status-line" role="status">
          更新包已下载并验证（{formatBytes(received)}）。安装时会先保存文档并退出应用，
          由 Windows 安装器完成升级并重启。
        </p>
      ) : null}

      {phase === "installing" ? (
        <p className="update-status-line" role="status">
          <LoaderCircle className="export-spinner" size={15} /> 正在启动安装器，应用即将退出…
        </p>
      ) : null}

      {actionError ? (
        <p className="update-error" role="alert">
          {actionError}
        </p>
      ) : null}

      <div className="update-actions">
        {phase === "available" ? (
          <button type="button" className="update-primary" onClick={() => runAction(download)}>
            下载 {target?.version ?? ""}
          </button>
        ) : null}
        {phase === "downloading" ? (
          <button type="button" className="update-secondary" onClick={() => runAction(cancelDownload)}>
            取消下载
          </button>
        ) : null}
        {phase === "readyToInstall" ? (
          <>
            <button type="button" className="update-primary" onClick={() => runAction(install)}>
              安装并重启
            </button>
            <span className="update-hint">也可以稍后安装：更新包已保留在本机。</span>
          </>
        ) : null}
        {phase === "idle" || phase === "upToDate" || phase === "available" ? (
          <button
            type="button"
            className="update-secondary"
            disabled={busy}
            onClick={() => {
              setActionError(null);
              void check().then((result) => {
                if (result.error) setActionError(result.error);
              });
            }}
          >
            <RefreshCw size={14} /> 检查更新
          </button>
        ) : null}
      </div>

      <div className="download-menu-divider" role="separator" />
      <label className="update-auto-check">
        <input
          type="checkbox"
          checked={autoBackgroundCheck}
          onChange={(event) => setAutoBackgroundCheck(event.target.checked)}
        />
        <span>每天自动检查更新（发现新版本时提醒）</span>
      </label>
    </div>
  );
}
