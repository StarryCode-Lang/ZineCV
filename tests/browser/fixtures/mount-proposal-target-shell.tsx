import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderAgentShell } from "../../../src/ui/agent/overlay/renderAgentShell";
import type { AuthorityCursor } from "../../../src-tauri/src/domain/bindings/AuthorityCursor";
import "../../../src/ui/styles/index.css";

const original: AuthorityCursor = {
  documentId: "doc:original", contextId: "context:original", branchId: "branch:original", headId: null, revision: "4",
};
const proposal = {
  id: "proposal:original", cursor: original, explanation: "隔离目标的合成提议",
  items: [
    { id: "item:name", referenceId: "basic:name", summary: "姓名修改", beforeValue: "原姓名", afterValue: "新姓名",
      change: { type: "updateBasic", patch: { name: "新姓名" } } },
    { id: "item:city", referenceId: "basic:city", summary: "城市修改", beforeValue: "原城市", afterValue: "新城市",
      change: { type: "updateBasic", patch: { city: "新城市" } } },
  ],
};
const receipt = { receiptId: "receipt:original", cursor: original, acceptedItemIds: ["item:name", "item:city"] };
const trace = {
  returned: [] as string[], accepted: [] as { id: string; items: string[] }[], rejected: [] as string[], undone: [] as string[],
  setCursor: (_patch: Partial<AuthorityCursor>) => {},
};
Object.assign(window, { proposalCardFixture: trace });

function Fixture() {
  const [activeCursor, setCursor] = useState<AuthorityCursor>({ ...original, documentId: "doc:other" });
  trace.setCursor = patch => setCursor({ ...original, ...patch });
  const nullRef = useRef(null);
  const numberRef = useRef(0);
  const boolRef = useRef(false);
  const noop = () => {};
  // Only the UI callbacks are spies. Target guards and item selection are the
  // production shell mapping and the production durable/undo card components.
  const shell = {
    activeCursor, activeDocumentTitle: "同名简历",
    documentTitles: { "doc:original": "同名简历", "doc:other": "同名简历" },
    returnToProposalTarget: (id: string) => { trace.returned.push(id); },
    modeValue: "chat", activeView: "editor", position: { left: 10, top: 10, width: 680, height: 900 },
    dragRef: nullRef, resizeRef: nullRef, reduceMotion: true, beginDrag: noop, freezeDockUntil: numberRef,
    moveDrag: noop, endDrag: noop, runState: "idle", suppressBotClick: boolRef, setMode: noop,
    expandedMode: { current: "chat" }, providerStatus: { configured: false }, sessionPickerOpen: false,
    setSessionPickerOpen: noop, acceptingProposalId: null, createSession: noop, openSettings: noop,
    sessionStore: { sessions: [] }, activeSessionId: "session:synthetic", switchSession: noop, messagesRef: nullRef,
    messages: [], proposals: [], referenceCatalog: [], locateReference: noop, acceptProposal: async () => {}, rejectProposal: noop,
    nativeProposals: [proposal],
    acceptNativeProposal: async (record: typeof proposal, items: string[]) => { trace.accepted.push({ id: record.id, items }); },
    rejectNativeProposal: async (record: typeof proposal) => { trace.rejected.push(record.id); },
    nativeUndoable: [receipt], undoNativeProposal: async (record: typeof receipt) => { trace.undone.push(record.receiptId); },
    undoEdit: null, undoLastEdit: noop, runStatus: "", interruptedSessionRun: false, composerAreaRef: nullRef,
    references: [], setReferences: noop, selectedSkill: null, setSkillId: noop, textareaRef: nullRef, draft: "",
    completionMenu: null, updateDraft: noop, onComposerKeyDown: noop, composingUntil: numberRef,
    filteredReferences: [], filteredSkills: [], menuIndex: 0, chooseReference: noop, chooseSkill: noop,
    insertComposerToken: noop, approximateContextTokens: 0, contextPreview: "", localError: "", cancelRun: noop,
    sendMessage: async () => {}, hasHistory: false, providerStatusText: "", beginResize: noop, moveResize: noop, endResize: noop,
  } as unknown as Parameters<typeof renderAgentShell>[0];
  return renderAgentShell(shell);
}

createRoot(document.getElementById("root")!).render(<Fixture />);
