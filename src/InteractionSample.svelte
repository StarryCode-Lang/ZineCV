<script lang="ts">
  import { onMount } from "svelte";
  import { slide } from "svelte/transition";

  type Entry = { id: string; title: string; html: string };
  type AgentMode = "bot" | "composer" | "chat";
  const agentModes: AgentMode[] = ["bot", "composer", "chat"];

  const initialEntries: Entry[] = [
    { id: "work-1", title: "前端工程师", html: "<p>桌面简历排版：验证 Svelte 状态边界、焦点恢复与拖拽取消。</p>" },
    { id: "project-1", title: "A4 预览基线", html: "<p>保持旧版右侧预览几何与导出画面。</p>" },
    { id: "skill-1", title: "本地 Agent", html: "<p>确认提议与受控写入形态。</p>" },
  ];

  let entries = $state<Entry[]>(initialEntries.map((entry) => ({ ...entry })));
  let openState = $state<Record<string, boolean>>({ "work-1": true, "project-1": true, "skill-1": true });
  let editorWidth = $state(560);
  let dragId: string | null = $state(null);
  let dragTarget: string | null = $state(null);
  let dragStartX = 0;
  let resizeStartX = 0;
  let resizeStartWidth = 560;
  let agentMode: AgentMode = $state("composer");
  let linkOpen = $state(false);
  let linkUrl = $state("");
  let linkRange: Range | null = null;
  let workspace: HTMLElement | null = $state(null);
  let activeEditor: HTMLElement | null = $state(null);

  let paneMin = $state(360);
  let paneMax = $state(1000);

  function refreshBounds() {
    paneMax = Math.max(360, (workspace?.clientWidth ?? 1000) - 420);
    editorWidth = clamp(editorWidth);
  }

  onMount(() => {
    refreshBounds();
    window.addEventListener("resize", refreshBounds);
    return () => window.removeEventListener("resize", refreshBounds);
  });
  const widthStyle = $derived(`width: ${editorWidth}px; min-width: ${editorWidth}px; flex: 0 0 ${editorWidth}px;`);

  function clamp(value: number) { return Math.min(paneMax, Math.max(paneMin, value)); }
  function resize(event: PointerEvent) { editorWidth = clamp(resizeStartWidth + event.clientX - resizeStartX); }
  function stopResize() { window.removeEventListener("pointermove", resize); window.removeEventListener("pointerup", stopResize); window.removeEventListener("pointercancel", cancelResize); }
  function cancelResize() { editorWidth = resizeStartWidth; stopResize(); }
  function beginResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeStartX = event.clientX;
    resizeStartWidth = editorWidth;
    window.addEventListener("pointermove", resize, { passive: true });
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", cancelResize);
  }
  function onSplitterKeydown(event: KeyboardEvent) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    editorWidth = clamp(event.key === "Home" ? paneMin : event.key === "End" ? paneMax : editorWidth + (event.key === "ArrowRight" ? 16 : -16));
  }
  function beginDrag(event: PointerEvent, id: string) {
    if (event.button !== 0) return;
    event.preventDefault();
    dragId = id; dragTarget = id; dragStartX = event.clientX;
    const target = event.currentTarget as Element;
    target.setPointerCapture(event.pointerId);
  }
  function moveDrag(event: PointerEvent) {
    if (!dragId || Math.abs(event.clientX - dragStartX) < 6) return;
    const item = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-module]");
    const id = item?.getAttribute("data-module");
    dragTarget = id && id !== dragId ? id : dragTarget;
  }
  function endDrag(event: PointerEvent) {
    if (dragId && dragTarget && dragId !== dragTarget) {
      const from = entries.findIndex((entry) => entry.id === dragId);
      const to = entries.findIndex((entry) => entry.id === dragTarget);
      if (from >= 0 && to >= 0) {
        const next = [...entries]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); entries = next;
      }
    }
    if (event.currentTarget instanceof Element && (event.currentTarget as Element).hasPointerCapture(event.pointerId)) (event.currentTarget as Element).releasePointerCapture(event.pointerId);
    dragId = null; dragTarget = null;
  }
  function cancelDrag(event: PointerEvent) {
    if (event.currentTarget instanceof Element && (event.currentTarget as Element).hasPointerCapture(event.pointerId)) (event.currentTarget as Element).releasePointerCapture(event.pointerId);
    dragId = null; dragTarget = null;
  }
  function move(id: string, delta: number) {
    const from = entries.findIndex((entry) => entry.id === id); const to = from + delta;
    if (from < 0 || to < 0 || to >= entries.length) return;
    const next = [...entries]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); entries = next;
  }
  function htmlInit(node: HTMLElement, initial: string) { node.innerHTML = initial; return { update() {} }; }
  function syncEditor(event?: Event) {
    const editor = event?.currentTarget instanceof HTMLElement ? event.currentTarget : activeEditor;
    if (!editor?.dataset.entryId) return;
    activeEditor = editor;
    const id = editor.dataset.entryId;
    entries = entries.map((entry) => entry.id === id ? { ...entry, html: editor.innerHTML } : entry);
  }
  function command(name: string, value?: string) { document.execCommand(name, false, value); syncEditor(); }

  function commandFromButton(event: MouseEvent, name: string, value?: string) {
    const button = event.currentTarget as HTMLElement;
    const editor = button.closest(".module")?.querySelector<HTMLElement>(".rich");
    if (editor) activeEditor = editor;
    command(name, value);
  }
  function beginLinkFromButton(event: MouseEvent) {
    const button = event.currentTarget as HTMLElement;
    const editor = button.closest(".module")?.querySelector<HTMLElement>(".rich");
    if (editor) activeEditor = editor;
    beginLink();
  }

  function beginLink() {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    linkRange = range && activeEditor?.contains(range.commonAncestorContainer) && range.toString() ? range.cloneRange() : null;
    linkOpen = true;
  }
  function saveLink() {
    const raw = linkUrl.trim(); if (!raw) return closeLink();
    const url = /^(https?:\/\/|mailto:)/i.test(raw) ? raw : `https://${raw.replace(/^\/+/, "")}`;
    if (activeEditor) {
      activeEditor.focus();
      if (linkRange) { const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(linkRange); command("createLink", url); }
      else command("insertHTML", `<a href="${url}">${url}</a>`);
    }
    closeLink();
  }
  function closeLink() { linkOpen = false; linkUrl = ""; linkRange = null; }
</script>

<section class="sample" aria-label="Svelte 等价交互样片">
  <header>
    <h1>B03 等价交互样片</h1>
    <div class="mode" role="group" aria-label="Agent 形态">
      {#each agentModes as mode}
        <button type="button" class:active={agentMode === mode} aria-pressed={agentMode === mode} onclick={() => agentMode = mode}>{mode === "bot" ? "浮标" : mode === "composer" ? "提议" : "会话"}</button>
      {/each}
    </div>
  </header>
  <div class="workspace" bind:this={workspace}>
    <div class="editor" style={widthStyle}>
      {#each entries as entry (entry.id)}
        <article class="module" class:dragging={dragId === entry.id} class:target={dragTarget === entry.id && dragId !== entry.id} data-module={entry.id}>
          <div class="head">
            <button type="button" class="grip" aria-label={`拖拽 ${entry.title}`}
              onpointerdown={(event) => beginDrag(event, entry.id)} onpointermove={moveDrag} onpointerup={endDrag} onpointercancel={cancelDrag}>⋮⋮</button>
            <strong>{entry.title}</strong>
            <div class="head-actions">
              <button type="button" onclick={() => move(entry.id, -1)} aria-label={`上移 ${entry.title}`}>↑</button>
              <button type="button" onclick={() => move(entry.id, 1)} aria-label={`下移 ${entry.title}`}>↓</button>
              <button type="button" aria-expanded={openState[entry.id]} onclick={() => openState[entry.id] = !openState[entry.id]}>{openState[entry.id] ? "折叠" : "展开"}</button>
            </div>
          </div>
          {#if openState[entry.id]}
            <div class="body" transition:slide={{ duration: 160 }}>
              <div class="toolbar" role="toolbar" tabindex="-1" aria-label="样片富文本工具栏" onpointerdown={(event) => event.preventDefault()} onmousedown={(event) => event.preventDefault()}>
                <button type="button" aria-label="粗体" onclick={(event) => commandFromButton(event, "bold")}>B</button>
                <button type="button" aria-label="斜体" onclick={(event) => commandFromButton(event, "italic")}>I</button>
                <button type="button" aria-label="项目符号" onclick={(event) => commandFromButton(event, "insertUnorderedList")}>•</button>
                <button type="button" aria-label="插入链接" onclick={beginLinkFromButton}>链接</button>
                <button type="button" aria-label="清除格式" onclick={(event) => commandFromButton(event, "removeFormat")}>清除</button>
              </div>
              <div class="rich" contenteditable="true" role="textbox" aria-multiline="true" aria-label={`${entry.title} 内容`} data-entry-id={entry.id}
                use:htmlInit={entry.html} oninput={syncEditor}></div>
            </div>
          {/if}
        </article>
      {/each}
    </div>
    <div class="splitter" role="slider" aria-label="分栏宽度" aria-orientation="vertical" aria-valuenow={Math.round(editorWidth)}
      aria-valuemin={paneMin} aria-valuemax={paneMax} tabindex="0" onpointerdown={beginResize} onkeydown={onSplitterKeydown}></div>
    <div class="preview" aria-label="样片预览区">预览占位</div>
  </div>
  {#if linkOpen}
    <div class="dialog" role="dialog" aria-label="插入链接">
      <label>链接地址 <input bind:value={linkUrl} placeholder="https://" /></label>
      <div class="actions"><button type="button" onclick={closeLink}>取消</button><button type="button" class="primary" onclick={saveLink}>保存链接</button></div>
    </div>
  {/if}
</section>

<style>
  :global(html) { color-scheme: light; }
  :global(body) { margin: 0; background: #f8f5f2; color: #2d2630; font-family: system-ui, sans-serif; }
  .sample { min-height: 100vh; padding: 20px; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  h1 { margin: 0; font-size: 20px; }
  .mode { display: flex; gap: 8px; }
  .mode button { padding: 6px 12px; border: 1px solid #d7cec8; background: white; border-radius: 8px; }
  .mode button.active { border-color: #ca3832; color: #ca3832; font-weight: 700; }
  .workspace { display: flex; min-height: 70vh; }
  .editor { display: grid; align-content: start; gap: 12px; }
  .module { background: white; border: 1px solid #e9e2dc; border-radius: 12px; padding: 10px; touch-action: none; }
  .module.dragging { opacity: .65; box-shadow: 0 8px 24px rgb(0 0 0 / 10%); }
  .module.target { border-color: #ca3832; }
  .head { display: flex; align-items: center; gap: 10px; }
  .head strong { flex: 1; }
  .grip { cursor: grab; border: 0; background: transparent; letter-spacing: -2px; }
  .head-actions { display: flex; gap: 6px; }
  button { border: 1px solid #d7cec8; background: white; border-radius: 6px; }
  .toolbar { display: flex; gap: 6px; margin-bottom: 6px; }
  .rich { min-height: 72px; padding: 8px; border: 1px solid #e9e2dc; border-radius: 8px; outline: none; }
  .rich:focus { border-color: #ca3832; }
  .splitter { width: 12px; margin: 0 6px; border-radius: 6px; background: #ddd3cc; cursor: col-resize; }
  .splitter:focus-visible { outline: 2px solid #ca3832; }
  .preview { flex: 1; border: 1px dashed #c9bdb5; border-radius: 12px; display: grid; place-items: center; background: white; }
  .dialog { position: fixed; inset: auto 20px 20px auto; width: 280px; padding: 12px; background: white; border: 1px solid #e9e2dc; border-radius: 12px; box-shadow: 0 10px 30px rgb(0 0 0 / 12%); }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
  .primary { border-color: #ca3832; color: #ca3832; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
</style>
