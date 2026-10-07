//! ZineCV 领域逻辑（C+ Phase 1a，自 `src-tauri/src/domain.rs` 原样抽取）：
//! 命令应用（`DocumentContext`，含幂等重放、游标推进与 CAS 快照哈希）、
//! 文档校验规则与默认文档构造。schema 类型来自 `zinecv-contracts`；
//! 类型体、行为与测试与抽取前逐字节一致。

use std::collections::{BTreeMap, BTreeSet};

use zinecv_contracts::{
    canonical_hash, AppError, AuthorityCursor, BasicField, CommandEnvelope, CommandResult,
    DomainCommand, Entry, ErrorCode, Id, Inline, ResumeDocument, RichBlock, Section, Sha256,
};

#[derive(Debug, Clone)]
pub struct DocumentContext {
    document: ResumeDocument,
    revision: u64,
    branch_id: Id,
    head_id: Option<Id>,
    processed: BTreeMap<Id, (Sha256, CommandResult, String)>,
}

impl DocumentContext {
    pub fn new(document: ResumeDocument) -> Result<Self, AppError> {
        validate_document(&document)?;
        Ok(Self {
            revision: document_revision(&document)?,
            document,
            branch_id: "main".into(),
            head_id: None,
            processed: BTreeMap::new(),
        })
    }

    pub fn with_authority(
        document: ResumeDocument,
        revision: u64,
        branch_id: Id,
        head_id: Option<Id>,
    ) -> Result<Self, AppError> {
        validate_document(&document)?;
        document_revision(&document)?;
        Ok(Self {
            document,
            revision,
            branch_id,
            head_id,
            processed: BTreeMap::new(),
        })
    }

    pub fn document(&self) -> &ResumeDocument {
        &self.document
    }

    pub fn cursor(&self, context_id: &str) -> AuthorityCursor {
        AuthorityCursor {
            document_id: self.document.document_id.clone(),
            context_id: context_id.into(),
            revision: self.revision.to_string(),
            branch_id: self.branch_id.clone(),
            head_id: self.head_id.clone(),
        }
    }

    pub fn apply_command(
        &mut self,
        actor: &str,
        context_id: &str,
        envelope: CommandEnvelope,
    ) -> Result<CommandResult, AppError> {
        let mut staged = self.clone();
        let result = staged.apply_command_inner(actor, context_id, envelope)?;
        *self = staged;
        Ok(result)
    }

    fn apply_command_inner(
        &mut self,
        actor: &str,
        context_id: &str,
        envelope: CommandEnvelope,
    ) -> Result<CommandResult, AppError> {
        if actor.trim().is_empty() || context_id.trim().is_empty() {
            return Err(permission_error("Trusted actor and context are required"));
        }
        if envelope.protocol_version != 1 {
            return Err(validation_error("Unsupported command protocol"));
        }
        let request_hash = canonical_hash(&envelope)?;
        if let Some((stored_hash, receipt, stored_actor)) = self.processed.get(&envelope.command_id)
        {
            if *stored_hash == request_hash && stored_actor == actor {
                return Ok(receipt.clone());
            }
            return Err(conflict_error(
                "Command ID was reused with a different request",
            ));
        }

        if envelope.document_id != self.document.document_id
            || envelope.expected_branch_id != self.branch_id
            || envelope.expected_head_id != self.head_id
            || envelope.expected_revision != self.revision.to_string()
        {
            return Err(conflict_error("Stale authority cursor"));
        }

        let mut changed_ids = Vec::new();
        match envelope.payload.clone() {
            DomainCommand::SetDocumentTitle { title } => {
                if title.trim().is_empty() {
                    return Err(validation_error("Document title cannot be empty"));
                }
                self.document.title = title;
                changed_ids.push(self.document.document_id.clone());
            }
            DomainCommand::RenameSection { section_id, title } => {
                let section = section_mut(&mut self.document, &section_id)?;
                section_title_mut(section).clone_from(&title);
                changed_ids.push(section_id);
            }
            DomainCommand::SetSectionVisibility {
                section_id,
                visible,
            } => {
                let section = section_mut(&mut self.document, &section_id)?;
                section_visible_mut(section).clone_from(&visible);
                changed_ids.push(section_id);
            }
            DomainCommand::MoveSection { section_id, index } => {
                let from = self
                    .document
                    .sections
                    .iter()
                    .position(|section| section_id_of(section) == &section_id)
                    .ok_or_else(|| not_found_error("Section not found"))?;
                if index >= self.document.sections.len() {
                    return Err(validation_error("Section index out of range"));
                }
                let section = self.document.sections.remove(from);
                self.document.sections.insert(index, section);
                changed_ids.push(section_id);
            }
            DomainCommand::SetEntryBody { entry_id, body } => {
                let entry = entry_mut(&mut self.document, &entry_id)?;
                entry.body = body;
                changed_ids.push(entry_id);
            }
            DomainCommand::SetSummaryBody { section_id, body } => {
                let section = section_mut(&mut self.document, &section_id)?;
                let Section::Summary(summary) = section else {
                    return Err(validation_error(
                        "Only summary sections have a summary body",
                    ));
                };
                summary.body = body;
                changed_ids.push(section_id);
            }
            DomainCommand::UpdateEntryFields {
                entry_id,
                title,
                role,
                department,
                city,
                start,
                end,
                college,
                mode,
            } => {
                let entry = entry_mut(&mut self.document, &entry_id)?;
                if let Some(value) = title {
                    entry.title = value;
                }
                if let Some(value) = role {
                    entry.role = value;
                }
                if let Some(value) = department {
                    entry.department = value;
                }
                if let Some(value) = city {
                    entry.city = value;
                }
                if let Some(value) = start {
                    entry.start = value;
                }
                if let Some(value) = end {
                    entry.end = value;
                }
                if let Some(value) = college {
                    entry.college = if value.is_empty() { None } else { Some(value) };
                }
                if let Some(value) = mode {
                    entry.mode = if value.is_empty() { None } else { Some(value) };
                }
                changed_ids.push(entry_id);
            }
            DomainCommand::AddEntry { section_id, entry } => {
                let section = section_mut(&mut self.document, &section_id)?;
                let entries = section_entries_mut(section)
                    .ok_or_else(|| validation_error("Summary section cannot contain entries"))?;
                entries.push(entry.clone());
                changed_ids.push(entry.id);
            }
            DomainCommand::DeleteEntry { entry_id } => {
                let mut removed = false;
                for section in &mut self.document.sections {
                    if let Some(entries) = section_entries_mut(section) {
                        let before = entries.len();
                        entries.retain(|entry| entry.id != entry_id);
                        removed |= entries.len() != before;
                    }
                }
                if !removed {
                    return Err(not_found_error("Entry not found"));
                }
                changed_ids.push(entry_id);
            }
            DomainCommand::MoveEntry {
                entry_id,
                section_id,
                index,
            } => {
                let mut entry = None;
                for section in &mut self.document.sections {
                    if let Some(entries) = section_entries_mut(section) {
                        if let Some(position) = entries
                            .iter()
                            .position(|candidate| candidate.id == entry_id)
                        {
                            entry = Some(entries.remove(position));
                            break;
                        }
                    }
                }
                let mut entry = entry.ok_or_else(|| not_found_error("Entry not found"))?;
                let section = section_mut(&mut self.document, &section_id)?;
                let entries = section_entries_mut(section)
                    .ok_or_else(|| validation_error("Summary section cannot contain entries"))?;
                if index > entries.len() {
                    return Err(validation_error("Entry index out of range"));
                }
                entry.id = entry_id.clone();
                entries.insert(index, entry);
                changed_ids.push(entry_id);
            }
            DomainCommand::UpdateBasic { patch } => {
                if let Some(value) = patch.name {
                    self.document.basic.name = value;
                }
                if let Some(value) = patch.phone {
                    self.document.basic.phone = value;
                }
                if let Some(value) = patch.email {
                    self.document.basic.email = value;
                }
                if let Some(value) = patch.city {
                    self.document.basic.city = value;
                }
                if let Some(value) = patch.wechat {
                    self.document.basic.wechat = value;
                }
                if let Some(value) = patch.birth {
                    self.document.basic.birth = value;
                }
                if let Some(value) = patch.age_mode {
                    self.document.basic.age_mode = value;
                }
                if let Some(value) = patch.website {
                    self.document.basic.website = Some(value);
                }
                if let Some(value) = patch.linkedin {
                    self.document.basic.linkedin = Some(value);
                }
                if let Some(value) = patch.gender {
                    self.document.basic.gender = Some(value);
                }
                if let Some(value) = patch.height {
                    self.document.basic.height = Some(value);
                }
                if let Some(value) = patch.weight {
                    self.document.basic.weight = Some(value);
                }
                if let Some(value) = patch.ethnicity {
                    self.document.basic.ethnicity = Some(value);
                }
                if let Some(value) = patch.birthplace {
                    self.document.basic.birthplace = Some(value);
                }
                if let Some(value) = patch.political_status {
                    self.document.basic.political_status = Some(value);
                }
                if let Some(value) = patch.marital_status {
                    self.document.basic.marital_status = Some(value);
                }
                if let Some(value) = patch.zodiac {
                    self.document.basic.zodiac = Some(value);
                }
                if let Some(value) = patch.mbti {
                    self.document.basic.mbti = Some(value);
                }
                if let Some(value) = patch.avatar_asset_id {
                    // 空字符串是前端约定的“清除头像”哨兵；其余值按资产 hash 设置。
                    self.document.basic.avatar_asset_id =
                        if value.is_empty() { None } else { Some(value) };
                }
                changed_ids.push(self.document.basic.name.clone());
            }
            DomainCommand::RestoreBasicFields { fields, values } => {
                if fields.is_empty() {
                    return Err(validation_error("Basic field restore needs a target"));
                }
                for field in fields.iter().copied() {
                    match field {
                        BasicField::Name => self.document.basic.name.clone_from(&values.name),
                        BasicField::Phone => self.document.basic.phone.clone_from(&values.phone),
                        BasicField::Email => self.document.basic.email.clone_from(&values.email),
                        BasicField::City => self.document.basic.city.clone_from(&values.city),
                        BasicField::Wechat => self.document.basic.wechat.clone_from(&values.wechat),
                        BasicField::Birth => self.document.basic.birth.clone_from(&values.birth),
                        BasicField::AgeMode => self.document.basic.age_mode = values.age_mode,
                        BasicField::Website => {
                            self.document.basic.website.clone_from(&values.website)
                        }
                        BasicField::Linkedin => {
                            self.document.basic.linkedin.clone_from(&values.linkedin)
                        }
                        BasicField::Gender => self.document.basic.gender.clone_from(&values.gender),
                        BasicField::Height => self.document.basic.height.clone_from(&values.height),
                        BasicField::Weight => self.document.basic.weight.clone_from(&values.weight),
                        BasicField::Ethnicity => {
                            self.document.basic.ethnicity.clone_from(&values.ethnicity)
                        }
                        BasicField::Birthplace => self
                            .document
                            .basic
                            .birthplace
                            .clone_from(&values.birthplace),
                        BasicField::PoliticalStatus => self
                            .document
                            .basic
                            .political_status
                            .clone_from(&values.political_status),
                        BasicField::MaritalStatus => self
                            .document
                            .basic
                            .marital_status
                            .clone_from(&values.marital_status),
                        BasicField::Zodiac => self.document.basic.zodiac.clone_from(&values.zodiac),
                        BasicField::Mbti => self.document.basic.mbti.clone_from(&values.mbti),
                        BasicField::AvatarAssetId => self
                            .document
                            .basic
                            .avatar_asset_id
                            .clone_from(&values.avatar_asset_id),
                    }
                }
                changed_ids.extend(fields.iter().map(|field| format!("basic:{field:?}")));
            }
            DomainCommand::SetLayout { presentation } => {
                self.document.presentation = presentation;
                changed_ids.push(self.document.document_id.clone());
            }
            DomainCommand::SetLegacyExtensions { extensions } => {
                self.document.legacy_extensions = extensions;
                changed_ids.push(self.document.document_id.clone());
            }
        }

        validate_document(&self.document)?;
        self.revision += 1;
        let result = CommandResult {
            command_id: envelope.command_id.clone(),
            cursor: self.cursor(context_id),
            durable: true,
            snapshot_hash: canonical_hash(&self.document)?,
            document: self.document.clone(),
            changed_ids,
        };
        self.processed.insert(
            envelope.command_id,
            (request_hash, result.clone(), actor.to_string()),
        );
        Ok(result)
    }
}

fn document_revision(document: &ResumeDocument) -> Result<u64, AppError> {
    if document.schema_version != 2 {
        return Err(unsupported_error(
            "Only ResumeDocument schema version 2 is accepted",
        ));
    }
    Ok(0)
}

fn section_id_of(section: &Section) -> &Id {
    match section {
        Section::Entry(section) => &section.id,
        Section::Summary(section) => &section.id,
    }
}

fn section_title_mut(section: &mut Section) -> &mut String {
    match section {
        Section::Entry(section) => &mut section.title,
        Section::Summary(section) => &mut section.title,
    }
}

fn section_visible_mut(section: &mut Section) -> &mut bool {
    match section {
        Section::Entry(section) => &mut section.visible,
        Section::Summary(section) => &mut section.visible,
    }
}

fn section_entries_mut(section: &mut Section) -> Option<&mut Vec<Entry>> {
    match section {
        Section::Entry(section) => Some(&mut section.entries),
        Section::Summary(_) => None,
    }
}

fn section_mut<'a>(
    document: &'a mut ResumeDocument,
    id: &str,
) -> Result<&'a mut Section, AppError> {
    document
        .sections
        .iter_mut()
        .find(|section| section_id_of(section) == id)
        .ok_or_else(|| not_found_error("Section not found"))
}

fn entry_mut<'a>(document: &'a mut ResumeDocument, id: &str) -> Result<&'a mut Entry, AppError> {
    for section in &mut document.sections {
        if let Section::Entry(entry_section) = section {
            if let Some(entry) = entry_section
                .entries
                .iter_mut()
                .find(|entry| entry.id == id)
            {
                return Ok(entry);
            }
        }
    }
    Err(not_found_error("Entry not found"))
}

fn validate_document(document: &ResumeDocument) -> Result<(), AppError> {
    if document.document_id.trim().is_empty() || document.title.trim().is_empty() {
        return Err(validation_error("Document ID and title are required"));
    }
    let mut section_ids = BTreeSet::new();
    let mut entry_ids = BTreeSet::new();
    for section in &document.sections {
        let id = section_id_of(section);
        if id.trim().is_empty() || !section_ids.insert(id.clone()) {
            return Err(validation_error("Section IDs must be present and unique"));
        }
        if let Section::Entry(entry_section) = section {
            for entry in &entry_section.entries {
                if entry.id.trim().is_empty() || !entry_ids.insert(entry.id.clone()) {
                    return Err(validation_error("Entry IDs must be present and unique"));
                }
                for block in &entry.body {
                    validate_block(block, 0)?;
                }
            }
        }
        if let Section::Summary(summary) = section {
            for block in &summary.body {
                validate_block(block, 0)?;
            }
        }
    }
    Ok(())
}

fn validate_block(block: &RichBlock, depth: usize) -> Result<(), AppError> {
    if depth > 8 {
        return Err(resource_limit_error(
            "Rich text nesting exceeds the safety limit",
        ));
    }
    match block {
        RichBlock::Paragraph { children } => {
            for inline in children {
                validate_inline(inline)?;
            }
        }
        RichBlock::List { items, .. } => {
            for item in items {
                for child in item {
                    validate_block(child, depth + 1)?;
                }
            }
        }
    }
    Ok(())
}

fn validate_inline(inline: &Inline) -> Result<(), AppError> {
    if let Inline::Link { href, children } = inline {
        let allowed = href.starts_with("https://")
            || href.starts_with("http://")
            || href.starts_with("mailto:");
        if !allowed {
            return Err(validation_error("Link protocol is not allowed"));
        }
        for child in children {
            validate_inline(child)?;
        }
    }
    Ok(())
}

fn app_error(code: ErrorCode, message: &str, retryable: bool) -> AppError {
    AppError::new(code, message, retryable)
}
fn validation_error(message: &str) -> AppError {
    app_error(ErrorCode::Validation, message, false)
}
fn conflict_error(message: &str) -> AppError {
    app_error(ErrorCode::Conflict, message, false)
}
fn not_found_error(message: &str) -> AppError {
    app_error(ErrorCode::NotFound, message, false)
}
fn permission_error(message: &str) -> AppError {
    app_error(ErrorCode::Permission, message, false)
}
fn unsupported_error(message: &str) -> AppError {
    app_error(ErrorCode::UnsupportedSchema, message, false)
}
fn resource_limit_error(message: &str) -> AppError {
    app_error(ErrorCode::ResourceLimit, message, false)
}

pub fn default_resume_document(document_id: &str) -> Result<ResumeDocument, AppError> {
    // 与旧版空白初始状态逐字段一致：标题、模块名、默认顺序、排版默认值。
    // section id 采用与 legacySnapshot 转换器相同的稳定前缀，保证首屏即可 diff。
    let module = |kind: &str, title: &str, visible: bool| {
        serde_json::json!({
            "id": format!("legacy-section:{kind}"), "kind": kind, "title": title,
            "visible": visible, "entries": []
        })
    };
    let json = serde_json::json!({
      "schemaVersion":2,
      "documentId":document_id,
      "title":"resume DIY",
      "basic":{"name":"","phone":"","email":"","city":"","wechat":"","birth":"","ageMode":"age"},
      "sections":[
        module("education", "教育经历", true),
        module("skills", "专业技能", true),
        module("work", "实习经历", true),
        module("projects", "项目经历", true),
        module("orgs", "社团和组织经历", true),
        {"id":"legacy-section:summary","kind":"summary","title":"自我评价","visible":true,"body":[]},
        module("research", "研究经历", false),
        module("awards", "荣誉奖项", false),
        module("other", "其他经历", false),
        module("portfolio", "作品集", false),
        module("custom", "自定义模块", false)
      ],
      "presentation":{"templateId":"legacy-v1","templateRevision":"1","density":"standard","fontSetId":"legacy-font:宋体","fontSizePt":9.75,"lineHeightPt":9.75,"moduleGapPt":0,"pageMarginPt":22.5,"headingSizePt":9.75,"paragraphGapPt":0,"listGapPt":0,"theme":"#000000","dateFormat":"2021年1月","titleFormat":"单行标题","separator":"使用分隔符号","textAlign":"两端对齐","legacyOverrides":{}},
      "legacyExtensions":{}
    });
    serde_json::from_value(json)
        .map_err(|error| validation_error(&format!("Invalid default document: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use zinecv_contracts::{BasicPatch, InlineMark};

    fn document() -> ResumeDocument {
        serde_json::from_str(r##"{
          "schemaVersion": 2,
          "documentId": "doc-1",
          "title": "测试简历",
          "basic": {"name":"样例","phone":"","email":"","city":"","wechat":"","birth":"","ageMode":"age"},
          "sections": [
            {"id":"summary-1","kind":"summary","title":"自我评价","visible":true,"body":[{"type":"paragraph","children":[{"type":"text","text":"本地","marks":[]}]}]},
            {"id":"work-1","kind":"work","title":"工作","visible":true,"entries":[{"id":"entry-1","title":"工程师","role":"","department":"","city":"","start":"2024","end":"2025","body":[{"type":"paragraph","children":[{"type":"text","text":"工作","marks":[]}]}]}]}
          ],
          "presentation": {"templateId":"legacy-v1","templateRevision":"1","density":"standard","fontSetId":"fixture","fontSizePt":9.75,"lineHeightPt":12,"moduleGapPt":8,"pageMarginPt":24,"headingSizePt":11,"paragraphGapPt":4,"listGapPt":4,"theme":"#000000","dateFormat":"2021.01","titleFormat":"双行标题","separator":"不使用分隔符号","textAlign":"系统默认","legacyOverrides":{}},
          "legacyExtensions": {"unknownField":{"safe":true}}
        }"##).expect("valid fixture")
    }

    fn envelope(payload: DomainCommand) -> CommandEnvelope {
        CommandEnvelope {
            protocol_version: 1,
            command_id: "cmd-1".into(),
            document_id: "doc-1".into(),
            context_id: "context-1".into(),
            expected_revision: "0".into(),
            expected_branch_id: "main".into(),
            expected_head_id: None,
            payload,
        }
    }

    #[test]
    fn builds_valid_default_resume_document() {
        let document = default_resume_document("doc-default").expect("default document");
        assert_eq!(document.document_id, "doc-default");
        // 默认文档与旧版空白初始状态一致：标题、11 个 section（含隐藏模块）与默认排版。
        assert_eq!(document.title, "resume DIY");
        assert_eq!(document.sections.len(), 11);
        let section_id = |index: usize| match &document.sections[index] {
            Section::Entry(entry) => entry.id.as_str(),
            Section::Summary(summary) => summary.id.as_str(),
        };
        assert_eq!(section_id(0), "legacy-section:education");
        assert_eq!(section_id(5), "legacy-section:summary");
        let hidden = document
            .sections
            .iter()
            .filter(|section| match section {
                Section::Entry(entry) => !entry.visible,
                Section::Summary(summary) => !summary.visible,
            })
            .count();
        assert_eq!(hidden, 5);
        assert!(canonical_hash(&document).is_ok());
        assert_eq!(
            default_resume_document("doc-\"quoted\"")
                .expect("escaped document ID")
                .document_id,
            "doc-\"quoted\""
        );
    }

    #[test]
    fn browser_rich_text_golden_deserializes_and_validates_in_rust() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../fixtures/legacy-richtext-golden.json"
        ))
        .expect("shared fixture");
        let blocks: Vec<RichBlock> =
            serde_json::from_value(fixture["blocks"].clone()).expect("Rust rich blocks");
        for block in &blocks {
            validate_block(block, 0).expect("domain rich text validation");
        }
        assert_eq!(
            serde_json::to_value(blocks).expect("serialize"),
            fixture["blocks"]
        );
    }

    #[test]
    fn applies_title_and_returns_monotonic_cursor() {
        let mut context = DocumentContext::new(document()).expect("context");
        let result = context
            .apply_command(
                "host-actor",
                "context-1",
                envelope(DomainCommand::SetDocumentTitle {
                    title: "新标题".into(),
                }),
            )
            .expect("apply");
        assert_eq!(result.cursor.revision, "1");
        assert_eq!(result.document.title, "新标题");
        assert!(result.durable);
    }

    #[test]
    fn retries_same_command_but_rejects_reuse() {
        let mut context = DocumentContext::new(document()).expect("context");
        let command = envelope(DomainCommand::SetDocumentTitle {
            title: "第一次".into(),
        });
        let first = context
            .apply_command("host-actor", "context-1", command.clone())
            .expect("first");
        let retry = context
            .apply_command("host-actor", "context-1", command)
            .expect("retry");
        assert_eq!(first, retry);
        let reused = envelope(DomainCommand::SetDocumentTitle {
            title: "第二次".into(),
        });
        assert_eq!(
            context
                .apply_command("host-actor", "context-1", reused)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
    }

    #[test]
    fn rejected_commands_leave_document_and_cursor_unchanged() {
        let mut context = DocumentContext::new(document()).expect("context");
        let original = context.document().clone();
        let original_cursor = context.cursor("context-1");
        let invalid_body = vec![RichBlock::Paragraph {
            children: vec![Inline::Link {
                href: "javascript:alert(1)".into(),
                children: vec![],
            }],
        }];
        assert_eq!(
            context
                .apply_command(
                    "host-actor",
                    "context-1",
                    envelope(DomainCommand::SetEntryBody {
                        entry_id: "entry-1".into(),
                        body: invalid_body,
                    }),
                )
                .unwrap_err()
                .code,
            ErrorCode::Validation
        );
        assert_eq!(context.document(), &original);
        assert_eq!(context.cursor("context-1"), original_cursor);

        assert_eq!(
            context
                .apply_command(
                    "host-actor",
                    "context-1",
                    envelope(DomainCommand::MoveEntry {
                        entry_id: "entry-1".into(),
                        section_id: "summary-1".into(),
                        index: 0,
                    }),
                )
                .unwrap_err()
                .code,
            ErrorCode::Validation
        );
        assert_eq!(context.document(), &original);
        assert_eq!(context.cursor("context-1"), original_cursor);

        let mut valid = envelope(DomainCommand::SetDocumentTitle {
            title: "仍可编辑".into(),
        });
        valid.command_id = "cmd-after-rejection".into();
        let result = context
            .apply_command("host-actor", "context-1", valid)
            .expect("valid command after rejection");
        assert_eq!(result.cursor.revision, "1");
        assert_eq!(result.document.title, "仍可编辑");
        assert_eq!(result.document.sections, original.sections);
    }

    #[test]
    fn summary_body_command_targets_only_summary_and_validates_rich_text() {
        let mut context = DocumentContext::new(document()).expect("context");
        let body = vec![RichBlock::Paragraph {
            children: vec![Inline::Text {
                text: "中文自我评价".into(),
                marks: vec![InlineMark::Bold],
            }],
        }];
        let result = context
            .apply_command(
                "host-actor",
                "context-1",
                envelope(DomainCommand::SetSummaryBody {
                    section_id: "summary-1".into(),
                    body: body.clone(),
                }),
            )
            .expect("edit summary");
        assert_eq!(result.changed_ids, vec!["summary-1"]);
        assert_eq!(result.cursor.revision, "1");
        let Section::Summary(summary) = &result.document.sections[0] else {
            panic!("summary section");
        };
        assert_eq!(summary.body, body);
        assert_eq!(result.document.sections[1], document().sections[1]);

        let mut wrong_target = envelope(DomainCommand::SetSummaryBody {
            section_id: "work-1".into(),
            body,
        });
        wrong_target.command_id = "cmd-wrong-target".into();
        wrong_target.expected_revision = "1".into();
        assert_eq!(
            context
                .apply_command("host-actor", "context-1", wrong_target)
                .unwrap_err()
                .code,
            ErrorCode::Validation
        );
        assert_eq!(context.document(), &result.document);
        assert_eq!(context.cursor("context-1"), result.cursor);
    }

    #[test]
    fn legacy_entry_fields_and_blank_basic_name_remain_editable() {
        let mut context = DocumentContext::new(document()).expect("context");
        let edited = context
            .apply_command(
                "host-actor",
                "context-1",
                envelope(DomainCommand::UpdateEntryFields {
                    entry_id: "entry-1".into(),
                    title: None,
                    role: None,
                    department: None,
                    city: None,
                    start: None,
                    end: None,
                    college: Some("示例大学".into()),
                    mode: Some("全日制".into()),
                }),
            )
            .expect("edit legacy fields");
        assert_eq!(edited.cursor.revision, "1");
        let Section::Entry(section) = &edited.document.sections[1] else {
            panic!("entry section");
        };
        assert_eq!(section.entries[0].college.as_deref(), Some("示例大学"));
        assert_eq!(section.entries[0].mode.as_deref(), Some("全日制"));

        let mut clear_fields = envelope(DomainCommand::UpdateEntryFields {
            entry_id: "entry-1".into(),
            title: None,
            role: None,
            department: None,
            city: None,
            start: None,
            end: None,
            college: Some(String::new()),
            mode: Some(String::new()),
        });
        clear_fields.command_id = "clear-fields".into();
        clear_fields.expected_revision = "1".into();
        let cleared = context
            .apply_command("host-actor", "context-1", clear_fields)
            .expect("clear optional fields");
        let Section::Entry(section) = &cleared.document.sections[1] else {
            panic!("entry section");
        };
        assert_eq!(section.entries[0].college, None);
        assert_eq!(section.entries[0].mode, None);

        let mut clear_name = envelope(DomainCommand::UpdateBasic {
            patch: BasicPatch {
                name: Some(String::new()),
                ..BasicPatch::default()
            },
        });
        clear_name.command_id = "clear-name".into();
        clear_name.expected_revision = "2".into();
        let result = context
            .apply_command("host-actor", "context-1", clear_name)
            .expect("blank name is valid in the legacy editor");
        assert_eq!(result.document.basic.name, "");
        assert_eq!(result.cursor.revision, "3");
    }

    #[test]
    fn rejects_duplicate_sections_and_bad_links() {
        let mut duplicate = document();
        duplicate.sections.push(
            serde_json::from_str(
                r##"{"id":"summary-1","kind":"summary","title":"重复","visible":true,"body":[]}"##,
            )
            .expect("section"),
        );
        assert_eq!(
            DocumentContext::new(duplicate).unwrap_err().code,
            ErrorCode::Validation
        );

        let mut bad_link = document();
        if let Section::Summary(summary) = &mut bad_link.sections[0] {
            summary.body.push(serde_json::from_str(r##"{"type":"paragraph","children":[{"type":"link","href":"javascript:alert(1)","children":[]}]}"##).expect("inline"));
        }
        assert_eq!(
            DocumentContext::new(bad_link).unwrap_err().code,
            ErrorCode::Validation
        );
    }

    #[test]
    fn unknown_document_ids_return_not_found_without_advancing_cursor() {
        let mut context = DocumentContext::new(document()).expect("context");
        let cursor = context.cursor("context-1");
        let error = context
            .apply_command(
                "host-actor",
                "context-1",
                envelope(DomainCommand::DeleteEntry {
                    entry_id: "entry-not-in-document".into(),
                }),
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
        assert_eq!(context.cursor("context-1"), cursor);
    }
}
