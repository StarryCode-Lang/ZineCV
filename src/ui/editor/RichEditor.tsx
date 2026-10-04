import { FloatingSurface } from "../overlays/FloatingSurface";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { OrderedList as BaseOrderedList } from "@tiptap/extension-list";
import StarterKit from "@tiptap/starter-kit";
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

import { registerEditorBuffer } from "../../platform/editorBuffers";
import {
  EMPTY_RICH_HTML,
  isAllowedRichLink,
  normalizeLinkUrl,
  normalizeRichEditorHtml,
  safePasteHtml,
} from "./richEditorContent";

const toolbarCommands = [
  { label: "撤销", command: "undo", Icon: RotateCcw },
  { label: "重做", command: "redo", Icon: Redo2 },
  { label: "粗体", command: "bold", Icon: Bold },
  { label: "斜体", command: "italic", Icon: Italic },
  { label: "下划线", command: "underline", Icon: Underline },
  { label: "删除线", command: "strike", Icon: Strikethrough },
  { label: "项目符号", command: "bulletList", Icon: List },
  { label: "编号列表", command: "orderedList", Icon: ListOrdered },
  { label: "插入链接", command: "createLink", Icon: Link2 },
  { label: "清除格式", command: "removeFormat", Icon: Eraser },
] as const;

const OrderedListWithNullableStart = BaseOrderedList.extend({
  addAttributes() {
    return {
      start: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const raw = element.getAttribute("start");
          if (raw === null || !/^\d+$/.test(raw)) return null;
          const value = Number(raw);
          return Number.isSafeInteger(value) && value <= 4_294_967_295
            ? value
            : null;
        },
      },
    };
  },
  renderHTML({ HTMLAttributes }) {
    const { start, type: _type, ...attributes } = HTMLAttributes;
    return [
      "ol",
      {
        ...this.options.HTMLAttributes,
        ...attributes,
        ...(start === null || start === undefined ? {} : { start }),
      },
      0,
    ];
  },
});

const richTextExtensions = [
  StarterKit.configure({
    blockquote: false,
    code: false,
    codeBlock: false,
    dropcursor: false,
    gapcursor: false,
    heading: false,
    horizontalRule: false,
    link: {
      autolink: false,
      linkOnPaste: false,
      openOnClick: false,
      protocols: ["https", "http", "mailto"],
      isAllowedUri: isAllowedRichLink,
      HTMLAttributes: { target: null, rel: null },
    },
    orderedList: false,
    trailingNode: false,
  }),
  OrderedListWithNullableStart,
];

type RichEditorProps = {
  value: string;
  onChange: (html: string) => void;
  fieldKey: string;
  resetKey?: string | number;
};

export function RichEditor({
  value,
  onChange,
  fieldKey,
  resetKey = 0,
}: RichEditorProps) {
  const [externalRevision, setExternalRevision] = useState(0);
  const lastObservedValue = useRef(value);
  const lastLocalValue = useRef<string | null>(null);
  const observedResetKey = useRef(resetKey);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const publish = useCallback((html: string) => {
    lastLocalValue.current = html;
    onChangeRef.current(html);
  }, []);

  useLayoutEffect(() => {
    if (!Object.is(observedResetKey.current, resetKey)) {
      observedResetKey.current = resetKey;
      lastObservedValue.current = value;
      lastLocalValue.current = null;
      return;
    }
    if (value === lastObservedValue.current) return;
    lastObservedValue.current = value;
    if (value !== lastLocalValue.current) {
      lastLocalValue.current = null;
      setExternalRevision((current) => current + 1);
    }
  }, [resetKey, value]);

  return (
    <RichEditorSurface
      key={`${String(resetKey)}:${externalRevision}`}
      value={value}
      fieldKey={fieldKey}
      onChange={publish}
    />
  );
}

function RichEditorSurface({
  value,
  fieldKey,
  onChange,
}: {
  value: string;
  fieldKey: string;
  onChange: (html: string) => void;
}) {
  const editorRef = useRef<Editor | null>(null);
  const composing = useRef(false);
  const compositionFinalizing = useRef(false);
  const pendingCompositionHtml = useRef<string | null>(null);
  const compositionFrame = useRef<number | null>(null);
  const lastPublishedHtml = useRef(normalizeRichEditorHtml(value));
  const publishRef = useRef(onChange);
  publishRef.current = onChange;

  const publishEditorHtml = useCallback((html: string) => {
    const normalized = normalizeRichEditorHtml(html);
    if (normalized === lastPublishedHtml.current) return;
    lastPublishedHtml.current = normalized;
    publishRef.current(normalized);
  }, []);

  const flushComposition = useCallback((): boolean => {
    const hadBuffer =
      composing.current ||
      compositionFinalizing.current ||
      pendingCompositionHtml.current !== null;
    if (!hadBuffer) return false;
    composing.current = false;
    compositionFinalizing.current = false;
    if (compositionFrame.current !== null) {
      cancelAnimationFrame(compositionFrame.current);
      compositionFrame.current = null;
    }
    const currentEditor = editorRef.current;
    const html = currentEditor
      ? normalizeRichEditorHtml(currentEditor.getHTML())
      : pendingCompositionHtml.current;
    pendingCompositionHtml.current = null;
    if (html !== null) publishEditorHtml(html);
    return true;
  }, [publishEditorHtml]);

  const queueCompositionCommit = useCallback(() => {
    if (compositionFrame.current !== null) {
      cancelAnimationFrame(compositionFrame.current);
    }
    const commit = () => {
      compositionFrame.current = null;
      if (!compositionFinalizing.current) return;
      compositionFinalizing.current = false;
      const currentEditor = editorRef.current;
      const html = currentEditor
        ? normalizeRichEditorHtml(currentEditor.getHTML())
        : pendingCompositionHtml.current;
      pendingCompositionHtml.current = null;
      if (html !== null) publishEditorHtml(html);
    };
    compositionFrame.current = requestAnimationFrame(commit);
  }, [publishEditorHtml]);

  const onUpdate = useCallback(({ editor: currentEditor }: { editor: Editor }) => {
    const html = normalizeRichEditorHtml(currentEditor.getHTML());
    if (composing.current || compositionFinalizing.current) {
      pendingCompositionHtml.current = html;
      return;
    }
    publishEditorHtml(html);
  }, [publishEditorHtml]);

  const onCompositionStart = useCallback(() => {
    if (compositionFrame.current !== null) {
      cancelAnimationFrame(compositionFrame.current);
      compositionFrame.current = null;
    }
    composing.current = true;
    compositionFinalizing.current = false;
    pendingCompositionHtml.current =
      editorRef.current?.getHTML() ?? EMPTY_RICH_HTML;
  }, []);

  const onCompositionUpdate = useCallback(() => {
    const currentEditor = editorRef.current;
    if (composing.current && currentEditor) {
      pendingCompositionHtml.current = normalizeRichEditorHtml(currentEditor.getHTML());
    }
  }, []);

  const onCompositionEnd = useCallback(() => {
    if (!composing.current) return;
    composing.current = false;
    compositionFinalizing.current = true;
    queueCompositionCommit();
  }, [queueCompositionCommit]);

  const handlePaste = useCallback((_view: unknown, event: ClipboardEvent) => {
    const html = event.clipboardData?.getData("text/html") ?? "";
    const plain = event.clipboardData?.getData("text/plain") ?? "";
    if (!html && !plain) return true;
    event.preventDefault();
    const currentEditor = editorRef.current;
    if (currentEditor) {
      currentEditor
        .chain()
        .focus()
        .insertContent(safePasteHtml(html, plain))
        .run();
    }
    return true;
  }, []);

  const editor = useEditor(
    {
      extensions: richTextExtensions,
      content: normalizeRichEditorHtml(value) || EMPTY_RICH_HTML,
      immediatelyRender: true,
      onUpdate,
      editorProps: {
        attributes: {
          "aria-label": "经历描述",
          class: "rich-body",
          "data-rich-field": fieldKey,
        },
        handlePaste,
      },
    },
    [],
  );
  editorRef.current = editor;

  useEffect(
    () => registerEditorBuffer(fieldKey, flushComposition),
    [fieldKey, flushComposition],
  );
  useEffect(() => {
    if (!editor) return;
    const root = editor.view.dom;
    root.addEventListener("compositionstart", onCompositionStart);
    root.addEventListener("compositionupdate", onCompositionUpdate);
    root.addEventListener("compositionend", onCompositionEnd);
    return () => {
      root.removeEventListener("compositionstart", onCompositionStart);
      root.removeEventListener("compositionupdate", onCompositionUpdate);
      root.removeEventListener("compositionend", onCompositionEnd);
    };
  }, [editor, onCompositionEnd, onCompositionStart, onCompositionUpdate]);
  useEffect(
    () => () => {
      if (composing.current || compositionFinalizing.current) flushComposition();
    },
    [flushComposition],
  );

  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState("");
  const linkAnchor = useRef<HTMLElement | null>(null);

  const closeLinkDialog = (restoreSelection: boolean) => {
    setLinkOpen(false);
    setLinkUrl("");
    setLinkError("");
    if (restoreSelection && editor) {
      requestAnimationFrame(() => editor.commands.focus());
    }
  };

  const runCommand = (command: (typeof toolbarCommands)[number]["command"]) => {
    if (!editor) return;
    if (command === "createLink") {
      linkAnchor.current = document.activeElement as HTMLElement | null;
      setLinkUrl(editor.getAttributes("link").href ?? "");
      setLinkError("");
      setLinkOpen(true);
      return;
    }
    const chain = editor.chain().focus();
    if (command === "undo") chain.undo().run();
    else if (command === "redo") chain.redo().run();
    else if (command === "bold") chain.toggleBold().run();
    else if (command === "italic") chain.toggleItalic().run();
    else if (command === "underline") chain.toggleUnderline().run();
    else if (command === "strike") chain.toggleStrike().run();
    else if (command === "bulletList") chain.toggleBulletList().run();
    else if (command === "orderedList") chain.toggleOrderedList().run();
    else if (command === "removeFormat") chain.unsetAllMarks().clearNodes().run();
  };

  const saveLink = () => {
    if (!editor) return;
    const url = normalizeLinkUrl(linkUrl);
    if (!url) {
      setLinkError("请输入有效的 http、https 或 mailto 链接。");
      return;
    }
    const chain = editor.chain().focus();
    if (editor.state.selection.empty) {
      chain
        .insertContent({
          type: "text",
          text: url,
          marks: [{ type: "link", attrs: { href: url } }],
        })
        .run();
    } else {
      chain.setLink({ href: url }).run();
    }
    closeLinkDialog(true);
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
            type="button"
            aria-label={label}
            title={label}
            aria-pressed={
              editor && command === "bold"
                ? editor.isActive("bold")
                : editor && command === "italic"
                  ? editor.isActive("italic")
                  : editor && command === "underline"
                    ? editor.isActive("underline")
                    : editor && command === "strike"
                      ? editor.isActive("strike")
                      : editor && command === "bulletList"
                        ? editor.isActive("bulletList")
                        : editor && command === "orderedList"
                          ? editor.isActive("orderedList")
                          : undefined
            }
            onClick={(event) => {
              if (command === "createLink") linkAnchor.current = event.currentTarget;
              runCommand(command);
            }}
          >
            <Icon size={15} />
          </button>
        ))}
        <span className="rich-toolbar-note">正文按当前简历排版规则显示</span>
      </div>
      <EditorContent
        editor={editor}
      />
      {linkOpen ? (
        <FloatingSurface
          anchor={linkAnchor.current}
          onClose={() => closeLinkDialog(false)}
        >
          <div className="link-dialog" role="dialog" aria-label="插入或编辑链接">
            <div className="link-dialog-title">插入/编辑链接</div>
            <label>
              链接地址
              <input
                autoFocus
                value={linkUrl}
                onChange={(event) => setLinkUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveLink();
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeLinkDialog(true);
                  }
                }}
                placeholder="https://"
              />
            </label>
            {linkError ? <div className="link-dialog-error" role="alert">{linkError}</div> : null}
            <div className="link-dialog-actions">
              <button type="button" onClick={() => closeLinkDialog(true)}>
                取消
              </button>
              <button type="button" className="primary" onClick={saveLink}>
                保存链接
              </button>
            </div>
          </div>
        </FloatingSurface>
      ) : null}
    </div>
  );
}
