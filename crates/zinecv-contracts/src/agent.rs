use super::*;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ProposalChange {
    SetDocumentTitle {
        title: String,
    },
    RenameSection {
        section_id: Id,
        title: String,
    },
    SetSectionVisibility {
        section_id: Id,
        visible: bool,
    },
    MoveSection {
        section_id: Id,
        index: usize,
    },
    SetEntryBody {
        entry_id: Id,
        body: Vec<RichBlock>,
    },
    SetSummaryBody {
        section_id: Id,
        body: Vec<RichBlock>,
    },
    UpdateEntryFields {
        entry_id: Id,
        title: Option<String>,
        role: Option<String>,
        department: Option<String>,
        city: Option<String>,
        start: Option<String>,
        end: Option<String>,
        college: Option<String>,
        mode: Option<String>,
    },
    AddEntry {
        section_id: Id,
        entry: Entry,
    },
    DeleteEntry {
        entry_id: Id,
    },
    MoveEntry {
        entry_id: Id,
        section_id: Id,
        index: usize,
    },
    UpdateBasic {
        patch: BasicPatch,
    },
    /// 切换内置版式：只替换 presentation.templateId，其余演示参数保持不变。
    ApplyTemplate {
        template_id: Id,
    },
    /// 版本副作用：确认通过后在同一事务内按当前正文提交一个版本。
    /// 提议值仅绑定 message，撤回不产生逆操作（历史提交不可静默回退）。
    CommitVersion {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalItem {
    pub id: Id,
    pub summary: String,
    pub change: ProposalChange,
}

/// The owning account is attached by the host when loading this object. None
/// of the write requests below accepts an account ID from the webview.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proposal {
    pub id: Id,
    pub account_id: Id,
    pub cursor: AuthorityCursor,
    pub created_at: String,
    pub items: Vec<ProposalItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum AgentProposalStatus {
    Pending,
    Confirmed,
    Rejected,
    Undone,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProposalItem {
    pub id: Id,
    pub summary: String,
    pub reference_id: Id,
    pub change: ProposalChange,
    #[ts(type = "unknown")]
    pub before_value: serde_json::Value,
    #[ts(type = "unknown")]
    pub after_value: serde_json::Value,
}

/// Host-owned, durable review record. Account ownership and target scope are
/// attached by Rust; renderer inputs can only name a proposal and item IDs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProposalRecord {
    pub id: Id,
    pub run_id: Id,
    pub account_id: Id,
    pub session_id: Id,
    pub document_id: Id,
    pub cursor: AuthorityCursor,
    pub scope_hash: Sha256,
    pub explanation: String,
    pub created_at: String,
    pub expires_at: String,
    pub status: AgentProposalStatus,
    pub items: Vec<AgentProposalItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProposalUndoRecord {
    pub receipt_id: Id,
    pub proposal_id: Id,
    pub session_id: Id,
    pub cursor: AuthorityCursor,
    pub accepted_item_ids: Vec<Id>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProposalInbox {
    pub pending: Vec<AgentProposalRecord>,
    pub undoable: Vec<AgentProposalUndoRecord>,
}

/// In-memory host input produced from a structured model tool call. Ownership,
/// cursor, scope hash, before/after values, timestamps and status are all
/// derived by the storage authority before this is persisted.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentProposalDraft {
    pub id: Id,
    pub explanation: String,
    pub items: Vec<AgentProposalDraftItem>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentProposalDraftItem {
    pub id: Id,
    pub summary: String,
    pub reference_id: Id,
    pub change: ProposalChange,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProposalReceipt {
    pub id: Id,
    pub command_id: Id,
    pub proposal_id: Id,
    pub cursor: AuthorityCursor,
    pub status: AgentProposalStatus,
    pub accepted_item_ids: Vec<Id>,
    pub created_at: String,
    pub idempotent_replay: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "kebab-case")]
pub enum BuiltinTemplateId {
    LegacyV1,
    ClearSingleV1,
    CompactSingleV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyTemplateRequest {
    pub command_id: Id,
    pub cursor: AuthorityCursor,
    pub template_id: BuiltinTemplateId,
    pub template_revision: Id,
    pub density: Option<Density>,
    pub font_set_id: Option<Id>,
    pub theme: Option<String>,
    pub date_format: Option<DateFormat>,
    pub title_format: Option<TitleFormat>,
    pub separator: Option<Separator>,
    pub text_align: Option<TextAlign>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyImportRequest {
    pub command_id: Id,
    pub cursor: AuthorityCursor,
    pub draft_id: Id,
    pub accepted_candidate_ids: Vec<Id>,
    /// Optional edits to explicitly accepted source candidates. Empty/absent
    /// preserves the original import protocol and exact retry identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub corrections: Option<Vec<ImportCandidateCorrection>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmProposalRequest {
    pub command_id: Id,
    pub cursor: AuthorityCursor,
    pub proposal_id: Id,
    pub accepted_item_ids: Vec<Id>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UndoConfirmedProposalRequest {
    pub command_id: Id,
    pub cursor: AuthorityCursor,
    pub receipt_id: Id,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RejectAgentProposalRequest {
    pub command_id: Id,
    pub proposal_id: Id,
}

// ---------------------------------------------------------------------------
// Agent 传输契约（P3b，自 src-tauri/src/gateway.rs 原样迁入）：模型端点
// URL 校验是安全边界（拒绝用户信息/查询参数、强制 HTTPS 或带端口本机
// HTTP、拒绝内网直连目标），gateway 与迁移身份检查双侧单源消费。
// ---------------------------------------------------------------------------

pub fn chat_endpoint(base_url: &str) -> Result<Url, String> {
    let mut url = Url::parse(base_url).map_err(|_| "模型连接地址无效".to_string())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("模型连接地址不能包含用户信息、查询参数或片段".into());
    }
    let local = match url.host() {
        Some(Host::Domain("localhost")) => true,
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    };
    if url.scheme() != "https" && !(url.scheme() == "http" && local && url.port().is_some()) {
        return Err("模型连接地址必须是 HTTPS 或带端口的本机 HTTP".into());
    }
    let path = url.path().trim_end_matches('/');
    let endpoint = if path.ends_with("/chat/completions") {
        path.to_string()
    } else {
        format!("{path}/chat/completions")
    };
    url.set_path(&endpoint);
    Ok(url)
}
