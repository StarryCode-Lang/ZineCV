<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { onMount } from "svelte";
  import type { AuthorityCursor } from "../src-tauri/src/domain/bindings/AuthorityCursor";
  import type { VersionGraph } from "../src-tauri/src/domain/bindings/VersionGraph";
  import { NativeDocumentClient } from "./bridge/NativeDocumentClient";
  const batches = ["基线", "领域核心", "文档引擎", "功能迁移", "原生验收"];
  import InteractionSample from "./InteractionSample.svelte";
  const showInteractionSample = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("sample") === "interaction";
  let nativeState = $state("检查本机文档状态…");
  let versionState = $state("");
  let cursor = $state<AuthorityCursor | null>(null);
  let draftTitle = $state("");
  let savedTitle = $state("");
  let saveState = $state("");
  let saving = $state(false);
  const documentClient = new NativeDocumentClient((command, args) => invoke(command, args));

  onMount(async () => {
    if (showInteractionSample) return;
    try {
      const state = await documentClient.load();
      cursor = state.cursor;
      draftTitle = state.document.title;
      savedTitle = state.document.title;
      nativeState = `本机文档已连接：${state.document.title}（修订 ${state.cursor.revision}）`;
      try {
        const graph = await invoke<VersionGraph>("version_graph");
        versionState = `版本图已连接：${graph.branches.length} 个分支、${graph.commits.length} 个提交`;
      } catch {
        versionState = "版本图读取失败";
      }
    } catch {
      nativeState = "原生文档服务不可用";
    }
  });

  async function saveTitle() {
    const retrying = documentClient.saveStatus === "failed";
    if (!cursor || saving || (!retrying && (!draftTitle.trim() || draftTitle === savedTitle))) return;
    saving = true;
    saveState = "正在保存…";
    const requestedTitle = draftTitle;
    try {
      const result = retrying
        ? await documentClient.retryFailed()
        : await documentClient.submit({ type: "setDocumentTitle", title: requestedTitle });
      cursor = result.cursor;
      savedTitle = result.document.title;
      if (draftTitle === requestedTitle) draftTitle = result.document.title;
      nativeState = `本机文档已连接：${result.document.title}（修订 ${result.cursor.revision}）`;
      saveState = draftTitle === savedTitle ? "已保存到本机文档" : "有未保存修改";
    } catch (error) {
      saveState = `保存失败：${String(error)}`;
    } finally {
      saving = false;
    }
  }
</script>

<svelte:head>
  <meta name="color-scheme" content="light" />
</svelte:head>

{#if showInteractionSample}
  <InteractionSample />
{:else}
<main aria-label="ZineCV 桌面开发状态">
  <header>
    <strong>ZineCV</strong>
    <span>2.0 开发样片</span>
  </header>
  <section>
    <h1>桌面版正在开发</h1>
    <p>这只是隔离的原生容器验收入口。正式简历编辑、预览和持久化接入后才能用于用户数据。</p>
    <p data-testid="native-document-state" aria-live="polite">{nativeState}</p>
    {#if versionState}<p data-testid="native-version-state" aria-live="polite">{versionState}</p>{/if}
    {#if cursor}
      <label for="document-title">文档标题</label>
      <input id="document-title" data-testid="document-title" value={draftTitle} oninput={(event) => {
        draftTitle = event.currentTarget.value;
        saveState = draftTitle === savedTitle ? "" : "有未保存修改";
      }} />
      <button type="button" onclick={saveTitle} disabled={saving || (documentClient.saveStatus !== "failed" && (!draftTitle.trim() || draftTitle === savedTitle))}>保存标题</button>
      <p data-testid="document-save-state" aria-live="polite">{saveState}</p>
    {/if}
    <ol>
      {#each batches as batch}
        <li>{batch}</li>
      {/each}
    </ol>
  </section>
</main>
{/if}

<style>
  :global(body) { margin: 0; font-family: system-ui, sans-serif; color: #2d2630; background: #f8f5f2; }
  main { min-height: 100vh; }
  header { display: flex; gap: 1rem; align-items: center; padding: 1rem 1.5rem; background: #fff; border-bottom: 1px solid #e9e2dc; }
  header strong { font-size: 1.35rem; }
  header span { color: #786e77; }
  section { max-width: 44rem; margin: 4rem auto; padding: 2rem; background: white; border: 1px solid #e9e2dc; border-radius: 1rem; }
  h1 { margin-top: 0; }
  li { margin: .5rem 0; }
  input { margin: 0 .75rem; padding: .4rem .6rem; border: 1px solid #b8aeb8; border-radius: .35rem; }
  button { padding: .4rem .75rem; border: 1px solid #8b7789; border-radius: .35rem; background: white; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
</style>
