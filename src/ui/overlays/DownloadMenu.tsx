import {
  Clipboard,
  FileType2,
  ImagePlus,
  LoaderCircle,
  Trash2,
} from "lucide-react";
import { useState } from "react";

// 导出菜单选择格式与图片分辨率，具体渲染和下载由 App 统一执行。
export function DownloadMenu({
  exporting,
  onPdf,
  onPng,
  onCopy,
  onReset,
}: {
  exporting: "pdf" | "png" | null;
  onPdf: () => void;
  onPng: (dpi: number) => void;
  onCopy: () => void;
  onReset: () => void;
}) {
  const [dpi, setDpi] = useState(192);
  return (
    <div
      className="floating-menu download-menu"
      role="menu"
      aria-label="下载选项"
    >
      <div className="download-menu-heading">
        <strong>导出简历</strong>
        <span>版式与当前预览保持一致</span>
      </div>
      <button
        className="download-option pdf-option"
        role="menuitem"
        title="导出 PDF 文档"
        disabled={exporting !== null}
        onClick={onPdf}
      >
        <span className="download-option-icon">
          {exporting === "pdf" ? (
            <LoaderCircle className="export-spinner" size={18} />
          ) : (
            <FileType2 size={18} />
          )}
        </span>
        <span className="download-option-copy">
          <strong>{exporting === "pdf" ? "正在生成…" : "PDF 文档"}</strong>
          <small>适合投递与打印</small>
        </span>
      </button>
      <button
        className="download-option png-option"
        role="menuitem"
        title="导出高清 PNG 图片"
        disabled={exporting !== null}
        onClick={() => onPng(dpi)}
      >
        <span className="download-option-icon">
          {exporting === "png" ? (
            <LoaderCircle className="export-spinner" size={18} />
          ) : (
            <ImagePlus size={18} />
          )}
        </span>
        <span className="download-option-copy">
          <strong>{exporting === "png" ? "正在生成…" : "高清 PNG"}</strong>
          <small>适合预览与分享</small>
        </span>
      </button>
      <label className="download-dpi">
        <span>图片分辨率</span>
        <select
          aria-label="PNG 分辨率"
          value={dpi}
          disabled={exporting !== null}
          onChange={(event) => setDpi(Number(event.target.value))}
        >
          <option value={72}>72 DPI</option>
          <option value={144}>144 DPI</option>
          <option value={192}>192 DPI（默认）</option>
          <option value={300}>300 DPI</option>
        </select>
      </label>
      <div className="download-menu-divider" role="separator" />
      <button
        className="download-extra-option"
        role="menuitem"
        title="复制简历文本到剪贴板"
        onClick={onCopy}
      >
        <Clipboard size={15} />
        <span>复制简历文本</span>
      </button>
      <button
        className="download-extra-option danger-text"
        role="menuitem"
        title="清空当前简历内容"
        onClick={onReset}
      >
        <Trash2 size={15} />
        <span>清空简历</span>
      </button>
    </div>
  );
}
