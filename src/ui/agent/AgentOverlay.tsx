import {
  runBeginDrag, runBeginResize, runEndDrag, runEndResize, runMoveDrag, runMoveResize, runSyncDragRef4,
  runSyncPointerPosition2,
} from './overlay/interactions';
import { runHandleLocalSkill } from './overlay/localSkills';
import {
  runAcceptNativeProposal, runAcceptProposal, runBuildResumeProposal, runRejectNativeProposal,
  runUndoLastEdit, runUndoNativeProposal,
} from './overlay/proposals';
import {
  runAuthenticate, runCheckHarness, runClearProvider, runDiscoverProviderModels, runLogoutAccount,
  runOnModelIdKeyDown, runOpenSettings, runSaveProvider, runTestProvider,
} from './overlay/providerSettings';
import { runSendMessage } from './overlay/sendMessage';
import {
  runChangeAccount, runChooseReference, runCreateSession, runInsertComposerToken, runOnComposerKeyDown,
  runSwitchSession, runSyncSetProviderStatus9, runSyncSettingsOpen11,
} from './overlay/sessions';

import { useReducedMotion } from "motion/react";
import type {
  SetStateAction
} from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import type { AgentProposalInbox } from "../../../src-tauri/src/domain/bindings/AgentProposalInbox";
import { registerAgentShutdownGuard } from "../../platform/appUpdate";
import { captureDocumentHostTarget, nativeClient } from "../../platform/workspace";
import { jobMaterialReferenceId } from "../../platform/jobs";
import type { JobMaterial } from "../../../src-tauri/src/domain/bindings/JobMaterial";
import type { DocumentListResult } from "../../../src-tauri/src/domain/bindings/DocumentListResult";
import { hasDocumentRuntime as isTauriRuntime, nativeInvoke } from "../../platform/ipc";
import type {
  AgentSizeSetting
} from "../../platform/settings";
import "../styles/agent-overlay.css";
import {
  comparableProviderBaseUrl, findCompletionToken, isLocalModelUrl, measureOverlay, nodeId, type AgentAnchor,
  type FixedRect,
} from "./agentOverlayUtils";
import {
  buildReferenceCatalog,
  countApproxTokens,
  resolveReferencePayload
} from "./context";
import { renderAgentSettings } from './overlay/renderAgentSettings';
import { renderAgentShell } from './overlay/renderAgentShell';
import {
  AgentMode, AgentOverlayProps, CatalogAgentReference, CompletionMenu, DiscoveredModel, ProviderDraft,
  TailParameters,
} from './overlay/shared';
import {
  appendSessionMessage, flushAgentSessionWrites, flushScheduledAgentSessionWrite, readAgentSessions,
  scheduleAgentSessionWrite, writeAgentSessions,
} from "./sessions";
import { availableAgentSkills } from "./skills";
import type {
  AgentEditTarget,
  AgentMessage,
  AgentProposal,
  AgentProviderStatus,
  AgentView
} from "./types";

export function AgentOverlay({
  onDocumentTransition,
  jobTailoringRequest,
  interactionDisabled = false,
  activeView,
  resume,
  moduleOrder,
  moduleNames,
  summaryTitle,
  resumeTitle,
  activeTemplateId,
  templates,
  versionStore,
  workingSnapshot,
  hasUncommittedChanges,
  layoutPreferences,
  onLayoutPreferenceChange,
  onApplyEdit,
  onUndoEdit,
  onDeleteEntry,
  onApplyTemplate,
  onCommitVersion,
  onNavigateToReference,
  onNativeWorkspaceReload,
}: AgentOverlayProps) {
  const reduceMotion = useReducedMotion();
  const [modeValue, setModeValue] = useState<AgentMode>(layoutPreferences.mode);
  const [panelSizes, setPanelSizes] = useState<AgentSizeSetting>(layoutPreferences.sizes);
  const [sessionStore, setSessionStore] = useState(readAgentSessions);
  const sessionStoreRef = useRef(sessionStore);
  sessionStoreRef.current = sessionStore;
  const sendPreparationRef = useRef<object | null>(null);
  const pendingSendRef = useRef<Promise<void> | null>(null);
  const sendScopeGeneration = useRef(0);
  const accountTransitionRef = useRef(false);
  const [loadedSessionAccountId, setLoadedSessionAccountId] = useState<string | null>(null);
  const accountLoadGeneration = useRef(0);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [sessionProposals, setSessionProposals] = useState<
    Record<string, AgentProposal[]>
  >({});
  const [nativeProposalInbox, setNativeProposalInbox] =
    useState<AgentProposalInbox>({ pending: [], undoable: [] });
  const [documentTitles, setDocumentTitles] = useState<Record<string, string>>({});
  const proposalCommandIds = useRef(new Map<string, string>());
  const messages = useMemo(
    () =>
      sessionStore.sessions.find((item) => item.id === sessionStore.activeId)
        ?.messages ?? [],
    [sessionStore],
  );
  const activeSessionId = sessionStore.activeId;
  const [draft, setDraft] = useState("");
  const [references, setReferences] = useState<string[]>([]);
  const [tailoringMaterial, setTailoringMaterial] = useState<JobMaterial | null>(null);
  const [skillId, setSkillId] = useState<string | null>(null);
  const [completionMenu, setCompletionMenu] = useState<CompletionMenu>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const proposals = useMemo(
    () => sessionProposals[activeSessionId] ?? [],
    [sessionProposals, activeSessionId],
  );
  const nativeProposals = nativeProposalInbox.pending.filter(
    (proposal) => proposal.sessionId === activeSessionId,
  );
  const nativeUndoable = nativeProposalInbox.undoable.filter(
    (receipt) => receipt.sessionId === activeSessionId,
  );
  const setProposals = (update: SetStateAction<AgentProposal[]>) =>
    setSessionProposals((current) => ({
      ...current,
      [activeSessionId]:
        typeof update === "function"
          ? update(current[activeSessionId] ?? [])
          : update,
    }));
  const [undoEdit, setUndoEdit] = useState<{
    target: AgentEditTarget;
    originalValue: unknown;
    expectedValue: unknown;
    branchId: string;
    headId: string | null;
  } | null>(null);
  const [acceptingProposalId, setAcceptingProposalId] = useState<string | null>(
    null,
  );
  const [providerStatus, setProviderStatus] = useState<AgentProviderStatus>({
    configured: false,
    provider: null,
    keyStorage: "memory-only",
    authRequired: true,
  });
  const [authAccount, setAuthAccount] = useState<{
    id: string;
    email: string;
  } | null>(null);
  const refreshNativeProposalInbox = useCallback(async () => {
    if (!isTauriRuntime() || !authAccount?.id) {
      setNativeProposalInbox({ pending: [], undoable: [] });
      return null;
    }
    const generation = accountLoadGeneration.current;
    const inbox = await nativeInvoke("list_agent_proposals") as AgentProposalInbox;
    if (generation !== accountLoadGeneration.current) return null;
    setNativeProposalInbox(inbox);
    if (inbox.pending.length || inbox.undoable.length) {
      try {
        const result = await nativeInvoke("document_list", { includeArchived: true }) as DocumentListResult;
        if (generation === accountLoadGeneration.current) {
          setDocumentTitles(Object.fromEntries(result.documents.map(item => [item.documentId, item.title])));
        }
      } catch {
        if (generation === accountLoadGeneration.current) setDocumentTitles({});
      }
    }
    return inbox;
  }, [authAccount?.id]);
  const [authDraft, setAuthDraft] = useState({ email: "", password: "" });
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>({
    name: "",
    baseUrl: "https://api.openai.com/v1",
    model: "",
    apiKey: "",
  });
  const [providerStatusText, setProviderStatusText] =
    useState("尚未配置模型连接");
  const [providerBusy, setProviderBusy] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>(
    [],
  );
  const [discoveryStatus, setDiscoveryStatus] = useState("");
  const [modelSuggestionsOpen, setModelSuggestionsOpen] = useState(false);
  const [modelSuggestionIndex, setModelSuggestionIndex] = useState(0);
  const [harnessStatusText, setHarnessStatusText] = useState("");
  const [runState, setRunState] = useState<
    "idle" | "running" | "failed" | "stopped"
  >("idle");
  const [runStatus, setRunStatus] = useState("");
  const [interruptedSessionRun, setInterruptedSessionRun] = useState(false);
  useEffect(() => {
    let active = true;
    setInterruptedSessionRun(false);
    if (!isTauriRuntime() || !authAccount?.id || loadedSessionAccountId !== authAccount.id || runState === "running") return;
    void nativeInvoke("list_agent_runs").then((value) => {
      if (!active) return;
      const runs = value as Array<{ sessionId: string; interruptedReason: string | null; startedAt: number }>;
      const latest = runs.filter((run) => run.sessionId === activeSessionId).sort((left, right) => right.startedAt - left.startedAt)[0];
      setInterruptedSessionRun(Boolean(latest?.interruptedReason));
    }).catch(() => { if (active) setInterruptedSessionRun(false); });
    return () => { active = false; };
  }, [authAccount?.id, loadedSessionAccountId, activeSessionId, runState]);
  const [localError, setLocalError] = useState("");
  const [position, setPosition] = useState<FixedRect>(() =>
    measureOverlay(
      layoutPreferences.mode,
      layoutPreferences.anchor,
      layoutPreferences.sizes,
    ),
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerAreaRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const freezeDockUntil = useRef(0);
  const positionRef = useRef<FixedRect | null>(position);
  const anchorRef = useRef<AgentAnchor | null>(layoutPreferences.anchor);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
    moved: boolean;
  } | null>(null);
  const resizeRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const suppressBotClick = useRef(false);
  const expandedMode = useRef<AgentMode>("composer");
  const runSequence = useRef(0);
  const acceptingProposalIds = useRef(new Set<string>());
  const undoConsumed = useRef(false);
  const discoverySequence = useRef(0);
  const composingUntil = useRef(0);
  const lastAltRelease = useRef(0);
  const pointerPosition = useRef({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  });
  const summonedAnchor = useRef<AgentAnchor | null>(null);

  const setMode = useCallback(
    (next: AgentMode) => {
      if (next !== "bot") expandedMode.current = next;
      else flushScheduledAgentSessionWrite();
      const nextRect = measureOverlay(next, anchorRef.current, panelSizes);
      positionRef.current = nextRect;
      setPosition(nextRect);
      setModeValue(next);
      onLayoutPreferenceChange("agentMode", next);
      if (next === "chat") {
        const mention = findCompletionToken(
          draft,
          textareaRef.current?.selectionStart ?? draft.length,
          "@",
        );
        setCompletionMenu(mention ? { kind: "reference", ...mention } : null);
      } else setCompletionMenu(null);
    },
    [draft, onLayoutPreferenceChange, panelSizes],
  );

  // setMode 依赖 draft（@ 补全解析），身份每击键变化；全局召唤监听经 ref
  // 吸收，避免助手输入框每次击键都重挂 window 的 pointermove/keyup。
  const setModeRef = useRef(setMode);
  setModeRef.current = setMode;

  useEffect(() => {
    if (!jobTailoringRequest) return;
    setModeRef.current("chat");
    if (pendingSendRef.current || runState === "running") {
      setLocalError("请先停止当前助手运行，再从岗位定制重新选择事实"); return;
    }
    const { material, referenceIds } = jobTailoringRequest;
    if (material.documentId !== nativeClient.snapshot?.cursor.documentId || referenceIds.length < 1 || referenceIds.length > 7) {
      setLocalError("岗位定制目标或事实范围已变化，请重新选择"); return;
    }
    setTailoringMaterial(material);
    setReferences([...referenceIds, jobMaterialReferenceId(material)]);
    setSkillId("job-tailor");
    setDraft(current => [current.trim(), `请针对“${material.title}”（岗位材料修订 ${material.revision}）列出要求、已选事实、缺口与建议。只基于明确选择的事实优化表达；缺失项保留为待补充，不补造经历、技能、日期或指标。`].filter(Boolean).join("\n\n"));
    setLocalError("");
  }, [jobTailoringRequest]);

  const changeAccount = (...args: TailParameters<typeof runChangeAccount>) => runChangeAccount({
    sendScopeGeneration, accountLoadGeneration, setLoadedSessionAccountId, setAuthAccount, setSessionStore,
    setSessionProposals, setNativeProposalInbox, setDraft, setReferences, setCompletionMenu, setProviderDraft,
  }, ...args);

  useEffect((...args: TailParameters<typeof runSyncPointerPosition2>) => runSyncPointerPosition2({
    pointerPosition, lastAltRelease, summonedAnchor, anchorRef, panelSizes, positionRef, setPosition,
    setModeRef,
  }, ...args), [panelSizes]);

  const modelSuggestions = useMemo(() => {
    const query = providerDraft.model.trim().toLocaleLowerCase();
    if (!query || !discoveredModels.length) return [];
    return discoveredModels
      .filter((model) => {
        const id = model.id.toLocaleLowerCase();
        return (
          id.startsWith(query) ||
          id.slice(id.lastIndexOf("/") + 1).startsWith(query) ||
          model.name.toLocaleLowerCase().startsWith(query)
        );
      })
      .slice(0, 8);
  }, [discoveredModels, providerDraft.model]);
  const canDiscoverModels = Boolean(
    providerDraft.baseUrl &&
    (providerDraft.apiKey.trim() ||
      isLocalModelUrl(providerDraft.baseUrl) ||
      (providerStatus.provider?.hasApiKey &&
        !providerStatus.provider.apiKeyNeedsReentry &&
        comparableProviderBaseUrl(providerDraft.baseUrl) ===
        comparableProviderBaseUrl(providerStatus.provider.baseUrl))),
  );
  const savedKeyMatchesDraft = Boolean(
    providerStatus.provider?.hasApiKey &&
    !providerStatus.provider.apiKeyNeedsReentry &&
    providerDraft.baseUrl.trim() === providerStatus.provider.baseUrl,
  );
  const canSaveProviderDraft = Boolean(
    providerDraft.apiKey.trim() ||
    savedKeyMatchesDraft ||
    (!providerStatus.provider?.hasApiKey &&
      isLocalModelUrl(providerDraft.baseUrl)),
  );

  useEffect(
    () => () => document.body.classList.remove("agent-is-dragging"),
    [],
  );

  // editor 目录随简历内容变化；templates/versions 目录只依赖模板与版本库，
  // 单独缓存避免每次击键重建全部三份目录。
  const editorReferenceCatalog = useMemo(
    () =>
      buildReferenceCatalog({
        view: "editor",
        resume,
        moduleOrder,
        moduleNames,
        summaryTitle,
        templates,
        activeTemplateId,
        versions: versionStore,
      }).map((reference) => ({ ...reference, view: "editor" as const })),
    [moduleNames, moduleOrder, resume, summaryTitle],
  );
  const stableReferenceCatalog = useMemo(
    () => [
      ...buildReferenceCatalog({
        view: "templates",
        resume,
        moduleOrder,
        moduleNames,
        summaryTitle,
        templates,
        activeTemplateId,
        versions: versionStore,
      }).map((reference) => ({ ...reference, view: "templates" as const })),
      ...buildReferenceCatalog({
        view: "versions",
        resume,
        moduleOrder,
        moduleNames,
        summaryTitle,
        templates,
        activeTemplateId,
        versions: versionStore,
      }).map((reference) => ({ ...reference, view: "versions" as const })),
    ],
    [activeTemplateId, templates, versionStore],
  );
  const referenceCatalog = useMemo(
    () => [...editorReferenceCatalog, ...stableReferenceCatalog, ...(tailoringMaterial ? [{
      id: jobMaterialReferenceId(tailoringMaterial), kind: "job-material" as const,
      label: `${tailoringMaterial.title} · 材料修订 ${tailoringMaterial.revision}`, detail: "岗位依据 · 不授予正文编辑范围",
      view: "editor" as const, jobMaterial: tailoringMaterial,
    }] : [])],
    [editorReferenceCatalog, stableReferenceCatalog, tailoringMaterial],
  );
  const visibleReferenceCatalog = useMemo(
    () => referenceCatalog.filter((reference) => reference.view === activeView),
    [activeView, referenceCatalog],
  );
  const resolvedReferences = useMemo(
    () =>
      references.map(
        (id) => referenceCatalog.find((item) => item.id === id) ?? null,
      ),
    [referenceCatalog, references],
  );
  const contextObjects = useMemo(() => {
    const records = resolvedReferences.flatMap((reference) => {
      if (!reference) return [];
      const payload = resolveReferencePayload(reference, {
        resume,
        moduleNames,
        summaryTitle,
        templates,
        versions: versionStore,
        workingSnapshot,
      });
      return payload ? [{ ...payload, sourceView: reference.view }] : [];
    });
    return records.filter(Boolean);
  }, [
    moduleNames,
    resolvedReferences,
    resume,
    summaryTitle,
    templates,
    versionStore,
    workingSnapshot,
  ]);
  // contextPreview 序列化缓存：缓存键为 contextObjects 的引用（其自身 useMemo
  // 依赖 moduleNames/resolvedReferences/resume/summaryTitle/templates/
  // versionStore/workingSnapshot）；这些输入不变时不再每次渲染重复 stringify。
  // countApproxTokens 仍随 draft 每渲染计算（轻量字符统计，非全量序列化）。
  const contextPreview = useMemo(
    () => JSON.stringify(contextObjects, null, 2),
    [contextObjects],
  );
  const approximateContextTokens = countApproxTokens(contextPreview + draft);
  const availableSkills = useMemo(
    () => availableAgentSkills(activeView),
    [activeView],
  );
  const selectedSkill =
    availableSkills.find((skill) => skill.id === skillId) ?? null;
  const filteredReferences = useMemo(() => {
    if (completionMenu?.kind !== "reference") return [];
    const query = completionMenu.query.trim().toLocaleLowerCase();
    if (!query && activeView === "editor") {
      const byId = new Map(
        visibleReferenceCatalog.map((reference) => [reference.id, reference]),
      );
      return [
        byId.get("feature:editor:basic-info"),
        ...moduleOrder.map((key) =>
          byId.get(key === "summary" ? "summary" : `module:${key}`),
        ),
      ].filter((reference): reference is CatalogAgentReference =>
        Boolean(reference),
      );
    }
    if (!query) return visibleReferenceCatalog;
    const titleMatches = visibleReferenceCatalog.filter((reference) =>
      reference.label.toLocaleLowerCase().includes(query),
    );
    return titleMatches.length
      ? titleMatches
      : visibleReferenceCatalog.filter((reference) =>
        reference.detail.toLocaleLowerCase().includes(query),
      );
  }, [activeView, completionMenu, moduleOrder, visibleReferenceCatalog]);
  const filteredSkills = useMemo(() => {
    if (completionMenu?.kind !== "skill") return [];
    const query = completionMenu.query.trim().toLocaleLowerCase();
    return availableSkills
      .filter((skill) =>
        `${skill.id} ${skill.title} ${skill.description}`
          .toLocaleLowerCase()
          .includes(query),
      )
      .slice(0, 12);
  }, [availableSkills, completionMenu]);
  const menuCount =
    completionMenu?.kind === "reference"
      ? filteredReferences.length
      : filteredSkills.length;

  useLayoutEffect((...args: TailParameters<typeof runSyncDragRef4>) => runSyncDragRef4({ dragRef, freezeDockUntil, modeValue, anchorRef, panelSizes, positionRef, setPosition, activeView }, ...args), [activeView, modeValue, panelSizes]);

  useLayoutEffect(() => {
    const area = composerAreaRef.current;
    const shell = area?.closest<HTMLElement>(".agent-shell");
    if (!area || !shell) return;
    const update = () =>
      shell.style.setProperty(
        "--agent-composer-height",
        `${area.offsetHeight}px`,
      );
    const observer = new ResizeObserver(update);
    observer.observe(area);
    update();
    return () => observer.disconnect();
  }, [modeValue]);

  useEffect(() => {
    if (!messagesRef.current) return;
    messagesRef.current.scrollTo({
      top: messagesRef.current.scrollHeight,
      // 流式输出期间高频滚动用 instant：smooth 动画会相互叠加抢帧。
      behavior: runState === "running" || reduceMotion ? "instant" : "smooth",
    });
  }, [messages, proposals, runStatus, runState, reduceMotion]);

  useEffect(() => {
    if (!authAccount?.id || loadedSessionAccountId !== authAccount.id) return;
    scheduleAgentSessionWrite(sessionStore, authAccount.id, (saved) => {
      if (!saved) setLocalError("对话保存失败；请检查本地数据库并重试。");
    });
    if (runState !== "running") flushScheduledAgentSessionWrite();
  }, [authAccount?.id, loadedSessionAccountId, runState, sessionStore]);

  useEffect(() => () => flushScheduledAgentSessionWrite(), []);

  useEffect((...args: TailParameters<typeof runSyncSetProviderStatus9>) => runSyncSetProviderStatus9({ setProviderStatus, changeAccount, setLocalError, setProviderStatusText, setProviderDraft }, ...args), []);

  useEffect(() => {
    if (
      !isTauriRuntime() ||
      !authAccount?.id ||
      loadedSessionAccountId !== authAccount.id
    ) return;
    let active = true;
    void refreshNativeProposalInbox().catch((error) => {
      if (active)
        setLocalError(error instanceof Error ? error.message : "提议收件箱载入失败");
    });
    return () => { active = false; };
  }, [authAccount?.id, loadedSessionAccountId, refreshNativeProposalInbox]);

  useEffect((...args: TailParameters<typeof runSyncSettingsOpen11>) => runSyncSettingsOpen11({ settingsOpen, setSettingsOpen }, ...args), [settingsOpen]);

  const appendMessage = (message: Omit<AgentMessage, "id">) => {
    const sessionId = activeSessionId;
    setSessionStore((current) =>
      appendSessionMessage(current, sessionId, {
        ...message,
        id: nodeId(message.role),
      }),
    );
  };

  const dismissProposal = (id: string) => {
    setProposals((current) => current.filter((item) => item.id !== id));
  };

  // 过期提议：提示后从收件箱移除，避免用户应用已失效的补丁。
  const expireProposal = (
    proposal: Pick<AgentProposal, "id" | "sourceView" | "sourceRefs">,
    text: string,
  ) => {
    appendMessage({
      role: "assistant",
      text,
      sourceView: proposal.sourceView,
      sourceRefs: proposal.sourceRefs,
    });
    dismissProposal(proposal.id);
  };

  const switchSession = (...args: TailParameters<typeof runSwitchSession>) => runSwitchSession({
    sendPreparationRef, runState, acceptingProposalId, sessionStore, sendScopeGeneration, setSessionStore,
    setSessionPickerOpen, setDraft, setReferences, setSkillId, setCompletionMenu, setUndoEdit, setRunStatus,
    setRunState, setMode,
  }, ...args);

  const createSession = (...args: TailParameters<typeof runCreateSession>) => runCreateSession({
    sendPreparationRef, runState, acceptingProposalId, sendScopeGeneration, setSessionStore,
    setSessionPickerOpen, setDraft, setReferences, setSkillId, setCompletionMenu, setUndoEdit, setRunStatus,
    setRunState, setMode,
  }, ...args);

  const chooseReference = (...args: TailParameters<typeof runChooseReference>) => runChooseReference({
    references, setCompletionMenu, completionMenu, draft, setDraft, setReferences, setMenuIndex, textareaRef,
  }, ...args);

  const chooseSkill = (skill: (typeof availableSkills)[number]) => {
    const token = completionMenu;
    if (token?.kind === "skill")
      setDraft(`${draft.slice(0, token.start)}${draft.slice(token.end)}`);
    setSkillId(skill.id);
    setCompletionMenu(null);
    setMenuIndex(0);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const updateDraft = (value: string, caret: number) => {
    setDraft(value);
    const mention = findCompletionToken(value, caret, "@");
    const command = findCompletionToken(value, caret, "/");
    if (modeValue !== "chat") setCompletionMenu(null);
    else if (mention) setCompletionMenu({ kind: "reference", ...mention });
    else if (command) setCompletionMenu({ kind: "skill", ...command });
    else setCompletionMenu(null);
    setMenuIndex(0);
  };

  useEffect(() => {
    if (!completionMenu) return;
    document
      .querySelector(".agent-completion [role='option'].active")
      ?.scrollIntoView({ block: "nearest" });
  }, [completionMenu, menuIndex]);

  const insertComposerToken = (...args: TailParameters<typeof runInsertComposerToken>) => runInsertComposerToken({ textareaRef, draft, updateDraft }, ...args);

  const onComposerKeyDown = (...args: TailParameters<typeof runOnComposerKeyDown>) => runOnComposerKeyDown({
    composingUntil, draft, sendMessage, completionMenu, menuCount, setMenuIndex, filteredReferences, menuIndex,
    chooseReference, filteredSkills, chooseSkill, setCompletionMenu,
  }, ...args);

  const selectedTemplate = (refIds: string[]) => {
    const selected = refIds
      .map((id) => referenceCatalog.find((reference) => reference.id === id))
      .filter(
        (reference): reference is CatalogAgentReference =>
          reference?.kind === "template",
      );
    return selected.length === 1
      ? (templates.find((template) => template.id === selected[0].templateId) ??
        null)
      : null;
  };

  const buildResumeProposal = (...args: TailParameters<typeof runBuildResumeProposal>) => runBuildResumeProposal({
    resume, moduleNames, workingSnapshot, versionStore, referenceCatalog, templates, activeTemplateId,
  }, ...args);

  const showLocalResult = (
    text: string,
    sourceView: AgentView,
    sourceRefs: string[],
  ) => {
    appendMessage({ role: "assistant", text, sourceView, sourceRefs });
  };

  const handleLocalSkill = (...args: TailParameters<typeof runHandleLocalSkill>) => runHandleLocalSkill({
    contextObjects, setSettingsOpen, referenceCatalog, showLocalResult, templates, selectedTemplate,
    workingSnapshot, activeTemplateId, setProposals, versionStore, setMode, hasUncommittedChanges, resumeTitle,
    resolvedReferences,
  }, ...args);

  function sendMessage(...args: TailParameters<typeof runSendMessage>) {
    return runSendMessage({
      interactionDisabled, pendingSendRef, sendPreparationRef, accountTransitionRef, runState, authAccount,
      loadedSessionAccountId, setLocalError, draft, selectedSkill, setDraft, setSkillId, setCompletionMenu,
      setSettingsOpen, setSessionPickerOpen, setMode, createSession, appendMessage, activeSessionId,
      sendScopeGeneration, accountLoadGeneration, sessionStoreRef, activeView, references, referenceCatalog,
      approximateContextTokens, versionStore, resume, moduleNames, summaryTitle, templates, workingSnapshot,
      providerStatus, messages, setSessionStore, setReferences, skillId, handleLocalSkill, buildResumeProposal,
      onNavigateToReference, abortRef, runSequence, nativeProposalInbox, setRunState, setRunStatus,
      refreshNativeProposalInbox, setProposals,
    }, ...args);
  }

  const cancelRun = () => {
    if (!abortRef.current) return;
    // 不递增 runSequence：用户主动停止不是"被新运行取代"，让本轮 catch
    // 补刷流式尾部并落"未完成输出"标记；迟到结果由 aborted 守卫拒绝。
    abortRef.current.abort();
    abortRef.current = null;
    setRunState("stopped");
    setRunStatus(
      "正在停止；供应商可能仍在处理已发送的数据。迟到结果不会应用。",
    );
  };

  // 应用更新安装前的收束守卫：安装流程经全局注册表触发取消活跃运行。
  const shutdownGuardRef = useRef({ settle: async () => { } });
  shutdownGuardRef.current = {
    settle: async () => {
      if (acceptingProposalIds.current.size || accountTransitionRef.current) {
        throw new Error("助手仍有确认写入或账户切换操作，请完成后再安装更新。");
      }
      // 取消尚在读取引用的发送准备，以及已发出的真实请求；等待其 finally，
      // 不能用固定延时假定流式输出与本地保存已经完成。
      sendScopeGeneration.current += 1;
      cancelRun();
      await pendingSendRef.current;
      flushSync(() => { });
      flushScheduledAgentSessionWrite();
      await flushAgentSessionWrites();
      if (authAccount && loadedSessionAccountId === authAccount.id) {
        if (!await writeAgentSessions(sessionStoreRef.current, authAccount.id)) {
          throw new Error("助手对话尚未保存成功，已阻止安装更新。");
        }
      }
    },
  };
  useEffect(() => {
    registerAgentShutdownGuard({
      settle: () => shutdownGuardRef.current.settle(),
    });
    return () => registerAgentShutdownGuard(null);
  }, []);

  const openSettings = (...args: TailParameters<typeof runOpenSettings>) => runOpenSettings({ setProviderStatusText, providerStatus, setSettingsOpen }, ...args);

  const authenticate = (...args: TailParameters<typeof runAuthenticate>) => runAuthenticate({
    accountTransitionRef, sendScopeGeneration, setAuthBusy, setAuthError, cancelRun, authDraft, changeAccount,
    setProviderStatus, setProviderStatusText, setProviderDraft, setAuthDraft,
  }, ...args);

  const logoutAccount = (...args: TailParameters<typeof runLogoutAccount>) => runLogoutAccount({
    accountTransitionRef, sendScopeGeneration, cancelRun, setAuthError, changeAccount, setAuthDraft,
    setProviderStatus, setProviderStatusText,
  }, ...args);

  const invalidateModelDiscovery = () => {
    discoverySequence.current += 1;
    setDiscoveredModels([]);
    setDiscoveryStatus("");
    setModelSuggestionsOpen(false);
  };

  const discoverProviderModels = (...args: TailParameters<typeof runDiscoverProviderModels>) => runDiscoverProviderModels({
    discoverySequence, setProviderBusy, setDiscoveryStatus, setModelSuggestionsOpen, providerDraft,
    setDiscoveredModels, setProviderDraft,
  }, ...args);

  const chooseDiscoveredModel = (model: DiscoveredModel) => {
    setProviderDraft((current) => ({ ...current, model: model.id }));
    setModelSuggestionsOpen(false);
    setModelSuggestionIndex(0);
  };

  const onModelIdKeyDown = (...args: TailParameters<typeof runOnModelIdKeyDown>) => runOnModelIdKeyDown({
    modelSuggestionsOpen, modelSuggestions, setModelSuggestionIndex, chooseDiscoveredModel,
    modelSuggestionIndex, setModelSuggestionsOpen,
  }, ...args);

  const saveProvider = (...args: TailParameters<typeof runSaveProvider>) => runSaveProvider({ setProviderBusy, setProviderStatusText, providerDraft, setProviderStatus, setProviderDraft }, ...args);

  const testProvider = (...args: TailParameters<typeof runTestProvider>) => runTestProvider({ setProviderBusy, setProviderStatusText, providerDraft, setProviderStatus }, ...args);

  const checkHarness = (...args: TailParameters<typeof runCheckHarness>) => runCheckHarness({ setHarnessStatusText, providerStatus }, ...args);

  const clearProvider = (...args: TailParameters<typeof runClearProvider>) => runClearProvider({
    setProviderBusy, setProviderStatus, authAccount, setProviderStatusText, setProviderDraft,
    invalidateModelDiscovery,
  }, ...args);

  const proposalCommandId = (key: string) => {
    const existing = proposalCommandIds.current.get(key);
    if (existing) return existing;
    const commandId = crypto.randomUUID();
    proposalCommandIds.current.set(key, commandId);
    return commandId;
  };

  const acceptNativeProposal = (...args: TailParameters<typeof runAcceptNativeProposal>) => runAcceptNativeProposal({
    acceptingProposalIds, setAcceptingProposalId, proposalCommandId, onNativeWorkspaceReload,
    refreshNativeProposalInbox, appendMessage, setLocalError,
  }, ...args);

  const rejectNativeProposal = (...args: TailParameters<typeof runRejectNativeProposal>) => runRejectNativeProposal({
    acceptingProposalIds, setAcceptingProposalId, proposalCommandId, refreshNativeProposalInbox, appendMessage,
    setLocalError,
  }, ...args);

  const undoNativeProposal = (...args: TailParameters<typeof runUndoNativeProposal>) => runUndoNativeProposal({
    acceptingProposalIds, setAcceptingProposalId, proposalCommandId, onNativeWorkspaceReload,
    refreshNativeProposalInbox, appendMessage, setLocalError,
  }, ...args);

  const acceptProposal = (...args: TailParameters<typeof runAcceptProposal>) => runAcceptProposal({
    acceptingProposalIds, setAcceptingProposalId, versionStore, expireProposal, workingSnapshot, onApplyEdit,
    setUndoEdit, undoConsumed, onDeleteEntry, templates, onApplyTemplate, appendMessage, onCommitVersion,
    dismissProposal,
  }, ...args);

  const undoLastEdit = (...args: TailParameters<typeof runUndoLastEdit>) => runUndoLastEdit({ undoEdit, undoConsumed, versionStore, onUndoEdit, appendMessage, setUndoEdit }, ...args);

  const rejectProposal = (proposal: AgentProposal) => {
    dismissProposal(proposal.id);
    appendMessage({
      role: "assistant",
      text: "已拒绝这条提议，未改动数据。",
      sourceView: proposal.sourceView,
      sourceRefs: proposal.sourceRefs,
    });
  };

  const locateReference = (id: string) => {
    const reference = referenceCatalog.find((item) => item.id === id);
    if (reference) onNavigateToReference(reference);
  };

  const beginDrag = (...args: TailParameters<typeof runBeginDrag>) => runBeginDrag({ positionRef, modeValue, dragRef }, ...args);
  const moveDrag = (...args: TailParameters<typeof runMoveDrag>) => runMoveDrag({ dragRef, positionRef, setPosition }, ...args);
  const endDrag = (...args: TailParameters<typeof runEndDrag>) => runEndDrag({ dragRef, positionRef, modeValue, suppressBotClick, anchorRef, onLayoutPreferenceChange }, ...args);
  const beginResize = (...args: TailParameters<typeof runBeginResize>) => runBeginResize({ positionRef, modeValue, resizeRef }, ...args);
  const moveResize = (...args: TailParameters<typeof runMoveResize>) => runMoveResize({ resizeRef, positionRef, modeValue, setPosition }, ...args);
  const endResize = (...args: TailParameters<typeof runEndResize>) => runEndResize({
    resizeRef, positionRef, panelSizes, modeValue, setPanelSizes, anchorRef, onLayoutPreferenceChange,
  }, ...args);
  const hasHistory =
    messages.length > 0 || proposals.length > 0 || runState === "running";

  return createPortal(
    <div className="agent-portal" data-agent-portal inert={interactionDisabled || undefined}>
      {renderAgentShell({
        documentTitles,
        activeCursor: nativeClient.snapshot?.cursor,
        activeDocumentTitle: nativeClient.snapshot?.document.title,
        returnToProposalTarget: documentId => {
          if (!onDocumentTransition) { setLocalError("请从简历列表返回原目标后再核对提议"); return; }
          void onDocumentTransition(async () => {
            const target = captureDocumentHostTarget();
            await nativeClient.switchDocument({ targetDocumentId: documentId, expectedCurrentId: target.cursor.documentId, expectedEpoch: BigInt(target.hostEpoch) });
          }).catch(reason => setLocalError(reason instanceof Error ? reason.message : String(reason)));
        },
        modeValue, activeView, position, dragRef, resizeRef, reduceMotion, beginDrag, freezeDockUntil, moveDrag,
        endDrag, runState, suppressBotClick, setMode, expandedMode, providerStatus, sessionPickerOpen,
        setSessionPickerOpen, acceptingProposalId, createSession, openSettings, sessionStore, activeSessionId,
        switchSession, messagesRef, messages, proposals, referenceCatalog, locateReference, acceptProposal,
        rejectProposal, nativeProposals, acceptNativeProposal, rejectNativeProposal, nativeUndoable,
        undoNativeProposal, undoEdit, undoLastEdit, runStatus, interruptedSessionRun, composerAreaRef, references,
        setReferences, selectedSkill, setSkillId, textareaRef, draft, completionMenu, updateDraft,
        onComposerKeyDown, composingUntil, filteredReferences, filteredSkills, menuIndex, chooseReference,
        chooseSkill, insertComposerToken, approximateContextTokens, contextPreview, localError, cancelRun,
        sendMessage, hasHistory, providerStatusText, beginResize, moveResize, endResize,
      })}

      {renderAgentSettings({
        settingsOpen, setSettingsOpen, reduceMotion, setProviderDraft, providerStatus, authAccount, authenticate,
        authDraft, setAuthDraft, authError, authBusy, logoutAccount, saveProvider, providerDraft,
        invalidateModelDiscovery, providerBusy, canDiscoverModels, discoverProviderModels, discoveryStatus,
        modelSuggestionsOpen, modelSuggestions, setModelSuggestionIndex, setModelSuggestionsOpen, onModelIdKeyDown,
        discoveredModels, modelSuggestionIndex, chooseDiscoveredModel, providerStatusText, checkHarness,
        harnessStatusText, canSaveProviderDraft, testProvider, clearProvider,
      })}
      <span className="agent-sr-status" role="status" aria-live="polite">
        {runStatus}
      </span>
    </div>,
    document.body,
  );
}
