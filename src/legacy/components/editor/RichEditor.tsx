import { FloatingSurface } from "../overlays/FloatingSurface";
import { useRef, useState } from "react";
import {
  Bold,
  Eraser,
  Italic,
  Link2,
  List,
  ListOrdered,
  Redo2,
  RotateCcw,
  Strikethrough,
  Underline,
} from "lucide-react";

import { sanitizeRichHtml } from "../../utils/resume";

const toolbarCommands = [
  { label: "撤销", command: "undo", Icon: RotateCcw },
  { label: "重做", command: "redo", Icon: Redo2 },
  { label: "粗体", command: "bold", Icon: Bold },
  { label: "斜体", command: "italic", Icon: Italic },
  { label: "下划线", command: "underline", Icon: Underline },
  { label: "删除线", command: "strikeThrough", Icon: Strikethrough },
  { label: "项目符号", command: "insertUnorderedList", Icon: List },
  { label: "编号列表", command: "insertOrderedList", Icon: ListOrdered },
  { label: "插入链接", command: "createLink", Icon: Link2 },
  { label: "清除格式", command: "removeFormat", Icon: Eraser },
];

export function RichEditor({
  value,
  onChange,
  onCommand,
}: {
  value: string;
  onChange: (html: string) => void;
  onCommand: (command: string, value?: string) => void;
}) {
  const linkAnchor = useRef<HTMLElement | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const editorRef = useRef<HTMLDivElement | null>(null);
  const linkSelection = useRef<{ start: number; end: number } | null>(null);
  const syncValueFromDom = () => {
    const root = editorRef.current;
    if (root) onChange(sanitizeRichHtml(root.innerHTML));
  };
  const applyCommand = (command: string, commandValue?: string) => {
    onCommand(command, commandValue);
    syncValueFromDom();
  };
  const runCommand = (command: string) => {
    if (command === "createLink") {
      const selection = window.getSelection();
      const root = editorRef.current;
      if (
        selection &&
        selection.rangeCount > 0 &&
        root?.contains(selection.anchorNode)
      ) {
        const range = selection.getRangeAt(0);
        const before = range.cloneRange();
        before.selectNodeContents(root);
        before.setEnd(range.startContainer, range.startOffset);
        const start = before.toString().length;
        linkSelection.current = { start, end: start + range.toString().length };
      } else linkSelection.current = null;
      setLinkOpen(true);
    } else applyCommand(command);
  };
  const saveLink = () => {
    const rawUrl = linkUrl.trim();
    const url = /^(https?:\/\/|mailto:)/i.test(rawUrl)
      ? rawUrl
      : rawUrl
        ? `https://${rawUrl.replace(/^\/+/, "")}`
        : "";
    const root = editorRef.current;
    if (url && root) {
      root.focus();
      const saved = linkSelection.current;
      if (saved && saved.end > saved.start) {
        const range = document.createRange();
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let offset = 0;
        let startSet = false;
        let node = walker.nextNode();
        while (node) {
          const length = node.textContent?.length ?? 0;
          if (!startSet && saved.start <= offset + length) {
            range.setStart(node, Math.max(0, saved.start - offset));
            startSet = true;
          }
          if (startSet && saved.end <= offset + length) {
            range.setEnd(node, Math.max(0, saved.end - offset));
            break;
          }
          offset += length;
          node = walker.nextNode();
        }
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        applyCommand("createLink", url);
      } else {
        const safeUrl = url
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
        applyCommand("insertHTML", `<a href="${safeUrl}">${safeUrl}</a>`);
      }
    }
    setLinkOpen(false);
    setLinkUrl("");
    linkSelection.current = null;
  };
  return (
    <div className={`rich-editor ${linkOpen ? "link-open" : ""}`}>
      <div
        className="rich-toolbar"
        aria-label="富文本工具栏"
        onMouseDown={(event) => event.preventDefault()}
      >
        {toolbarCommands.map(({ label, command, Icon }) => (
          <button
            key={command}
            aria-label={label}
            title={label}
            onClick={(event) => {
              if (command === "createLink")
                linkAnchor.current = event.currentTarget;
              runCommand(command);
            }}
          >
            <Icon size={15} />
          </button>
        ))}
        <span className="rich-toolbar-note">正文按当前简历排版规则显示</span>
      </div>
      <div
        ref={editorRef}
        className="rich-body"
        contentEditable
        suppressContentEditableWarning
        aria-label="经历描述"
        dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(value) }}
        onInput={(event) =>
          onChange(sanitizeRichHtml(event.currentTarget.innerHTML))
        }
        onPaste={(event) => {
          event.preventDefault();
          const rich = event.clipboardData.getData("text/html");
          const plain = event.clipboardData.getData("text/plain");
          const escapedPlain = plain
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\r?\n/g, "<br>");
          applyCommand("insertHTML", sanitizeRichHtml(rich || escapedPlain));
        }}
      />
      {linkOpen ? (
        <FloatingSurface
          anchor={linkAnchor.current}
          onClose={() => setLinkOpen(false)}
        >
          <div
            className="link-dialog"
            role="dialog"
            aria-label="插入或编辑链接"
          >
            <div className="link-dialog-title">插入/编辑链接</div>
            <label>
              链接地址
              <input
                autoFocus
                value={linkUrl}
                onChange={(event) => setLinkUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveLink();
                  if (event.key === "Escape") setLinkOpen(false);
                }}
                placeholder="https://"
              />
            </label>
            <div className="link-dialog-actions">
              <button
                onClick={() => {
                  setLinkOpen(false);
                  setLinkUrl("");
                  linkSelection.current = null;
                }}
              >
                取消
              </button>
              <button className="primary" onClick={saveLink}>
                保存链接
              </button>
            </div>
          </div>
        </FloatingSurface>
      ) : null}
    </div>
  );
}
