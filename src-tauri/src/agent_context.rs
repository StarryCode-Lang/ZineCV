//! Build model-visible context from explicit stable IDs and the SQLite authority.
//! The renderer never supplies the contents of a selected resume field.

use std::collections::HashSet;

use serde_json::{json, Value};

use crate::domain::{AuthorityCursor, Entry, Inline, ResumeDocument, RichBlock, Section};
use crate::storage::{StorageError, StorageResult, Store, VersionGraphDetailed};

fn inline_text(value: &Inline, output: &mut String) {
    match value {
        Inline::Text { text, .. } => output.push_str(text),
        Inline::Link { children, .. } => {
            for child in children {
                inline_text(child, output);
            }
        }
        Inline::Break => output.push('\n'),
    }
}

fn block_text(block: &RichBlock, output: &mut String) {
    match block {
        RichBlock::Paragraph { children } => {
            for child in children {
                inline_text(child, output);
            }
            output.push('\n');
        }
        RichBlock::List { items, .. } => {
            for item in items {
                for child in item {
                    block_text(child, output);
                }
            }
        }
    }
}

fn text_of(blocks: &[RichBlock]) -> String {
    let mut output = String::new();
    for block in blocks {
        block_text(block, &mut output);
    }
    output.trim().to_owned()
}

fn entry_value(entry: &Entry) -> Value {
    json!({
        "id": entry.id, "title": entry.title, "role": entry.role,
        "department": entry.department, "city": entry.city,
        "start": entry.start, "end": entry.end,
        "college": entry.college, "mode": entry.mode,
        "content": text_of(&entry.body),
    })
}

const SELECTABLE_BASIC_FIELDS: &[&str] = &[
    "name",
    "phone",
    "email",
    "city",
    "wechat",
    "birth",
    "ageMode",
    "website",
    "linkedin",
    "gender",
    "height",
    "weight",
    "ethnicity",
    "birthplace",
    "politicalStatus",
    "maritalStatus",
    "zodiac",
    "mbti",
];

fn module_section<'a>(
    document: &'a ResumeDocument,
    kind: &str,
) -> Option<&'a crate::domain::EntrySection> {
    document.sections.iter().find_map(|section| match section {
        Section::Entry(value) if serde_json::to_value(value.kind).ok()?.as_str() == Some(kind) => {
            Some(value)
        }
        _ => None,
    })
}

fn document_summary(document: &ResumeDocument) -> Value {
    let modules = document
        .sections
        .iter()
        .filter_map(|section| match section {
            Section::Entry(value) => Some(json!({
                "id": value.id, "name": value.title,
                "entries": value.entries.iter().map(entry_value).collect::<Vec<_>>(),
            })),
            _ => None,
        })
        .collect::<Vec<_>>();
    let summary = document
        .sections
        .iter()
        .find_map(|section| match section {
            Section::Summary(value) => Some(text_of(&value.body)),
            _ => None,
        })
        .unwrap_or_default();
    json!({ "resumeTitle": document.title, "summary": summary, "modules": modules })
}

fn graph_for<'a>(
    cache: &'a mut Option<VersionGraphDetailed>,
    store: &Store,
    document_id: &str,
) -> StorageResult<&'a VersionGraphDetailed> {
    if cache.is_none() {
        *cache = Some(store.load_version_graph_detailed(document_id)?);
    }
    Ok(cache.as_ref().expect("graph was initialized"))
}

pub fn selected_context(
    store: &Store,
    expected_cursor: &AuthorityCursor,
    ids: &[String],
) -> StorageResult<Vec<Value>> {
    if ids.len() > 8 || ids.iter().any(|id| id.is_empty() || id.len() > 256) {
        return Err(StorageError::Validation(
            "Select at most eight valid references".into(),
        ));
    }
    let unique: HashSet<&str> = ids.iter().map(String::as_str).collect();
    if unique.len() != ids.len() {
        return Err(StorageError::Validation("Duplicate agent reference".into()));
    }
    let actual = store
        .load_cursor(&expected_cursor.document_id, &expected_cursor.context_id)?
        .ok_or_else(|| StorageError::NotFound("Current document is missing".into()))?;
    if &actual != expected_cursor {
        return Err(StorageError::Conflict(
            "Document changed before context selection".into(),
        ));
    }
    let (_, document) = store
        .load_current(&actual.document_id, &actual.context_id)?
        .ok_or_else(|| StorageError::NotFound("Current draft is missing".into()))?;
    let mut graph = None;
    let mut templates: Option<Vec<Value>> = None;
    let mut payloads = Vec::with_capacity(ids.len());
    for id in ids {
        let payload = if let Some(key) = id.strip_prefix("basic:") {
            if !SELECTABLE_BASIC_FIELDS.contains(&key) {
                return Err(StorageError::Validation(
                    "Basic field is not selectable".into(),
                ));
            }
            let basic = serde_json::to_value(&document.basic)?;
            let value = basic
                .get(key)
                .ok_or_else(|| StorageError::NotFound("Basic field is unavailable".into()))?;
            json!({"kind":"basic-field", "id":id, "field":key, "value":value})
        } else if id == "summary" {
            let section = document
                .sections
                .iter()
                .find_map(|section| match section {
                    Section::Summary(value) => Some(value),
                    _ => None,
                })
                .ok_or_else(|| StorageError::NotFound("Summary is unavailable".into()))?;
            json!({"kind":"summary", "id":id, "title":section.title, "content":text_of(&section.body)})
        } else if let Some(kind) = id.strip_prefix("module:") {
            let section = module_section(&document, kind)
                .ok_or_else(|| StorageError::NotFound("Module is unavailable".into()))?;
            json!({"kind":"module", "id":id, "module":section.title,
                "entries":section.entries.iter().map(entry_value).collect::<Vec<_>>()})
        } else if let Some(rest) = id.strip_prefix("entry:") {
            let (kind, entry_id) = rest
                .split_once(':')
                .ok_or_else(|| StorageError::Validation("Invalid entry reference".into()))?;
            let section = module_section(&document, kind)
                .ok_or_else(|| StorageError::NotFound("Module is unavailable".into()))?;
            let entry = section
                .entries
                .iter()
                .find(|entry| entry.id == entry_id)
                .ok_or_else(|| StorageError::NotFound("Entry is unavailable".into()))?;
            let mut value = entry_value(entry);
            value["kind"] = json!("entry");
            value["module"] = json!(section.title);
            value["referenceId"] = json!(id);
            value
        } else if let Some(template_id) = id.strip_prefix("template:") {
            if templates.is_none() {
                let record = store.read_imported_template_catalog()?.ok_or_else(|| {
                    StorageError::NotFound("Template catalog is unavailable".into())
                })?;
                let parsed: Value = serde_json::from_str(&record.payload_json)?;
                templates = Some(
                    parsed
                        .as_array()
                        .ok_or_else(|| StorageError::Corrupt("Template catalog is invalid".into()))?
                        .clone(),
                );
            }
            let template = templates
                .as_ref()
                .unwrap()
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(template_id))
                .ok_or_else(|| StorageError::NotFound("Template is unavailable".into()))?;
            json!({"kind":"template", "id":template_id,
                "name":template.get("name"), "sourceType":template.get("sourceType"),
                "analysis":template.get("analysis"), "recognitionConfidence":template.get("recognitionConfidence"),
                "recognitionWarnings":template.get("recognitionWarnings"), "moduleOrder":template.get("moduleOrder"),
                "moduleNames":template.get("moduleNames"), "summaryTitle":template.get("summaryTitle"),
                "extractedTextLength":template.get("extractedText").and_then(Value::as_str).map(str::len).unwrap_or(0)})
        } else if let Some(commit_id) = id.strip_prefix("version:") {
            let graph = graph_for(&mut graph, store, &actual.document_id)?;
            let commit = graph
                .commits
                .iter()
                .find(|commit| commit.commit.id == commit_id)
                .ok_or_else(|| StorageError::NotFound("Version is unavailable".into()))?;
            let snapshot: ResumeDocument = serde_json::from_str(&commit.snapshot_document_json)?;
            json!({"kind":"version", "id":commit_id, "message":commit.commit.message,
                "createdAt":commit.commit.created_at, "snapshot":document_summary(&snapshot)})
        } else if let Some(branch_id) = id.strip_prefix("branch:") {
            let graph = graph_for(&mut graph, store, &actual.document_id)?;
            let branch = graph
                .branches
                .iter()
                .find(|branch| branch.id == branch_id)
                .ok_or_else(|| StorageError::NotFound("Branch is unavailable".into()))?;
            json!({"kind":"branch", "id":branch.id, "name":branch.name, "headCommitId":branch.head_commit_id})
        } else if id == "draft:current" {
            let graph = graph_for(&mut graph, store, &actual.document_id)?;
            let head = graph
                .commits
                .iter()
                .find(|commit| Some(commit.commit.id.as_str()) == actual.head_id.as_deref());
            let changes = if let Some(head) = head {
                let before: ResumeDocument = serde_json::from_str(&head.snapshot_document_json)?;
                let mut changed = Vec::new();
                if before.title != document.title {
                    changed.push("简历名称");
                }
                if before.basic != document.basic {
                    changed.push("基本信息字段（值已省略）");
                }
                if before.sections != document.sections {
                    changed.push("简历模块或正文");
                }
                if before.presentation != document.presentation {
                    changed.push("模板与排版");
                }
                changed
            } else {
                vec!["首次提交"]
            };
            json!({"kind":"draft", "id":id, "branchId":actual.branch_id,
                "baseline":head.map(|commit| commit.commit.message.as_str()), "changedAreas":changes})
        } else if id.starts_with("feature:") {
            let mut parts = id.split(':');
            let _ = parts.next();
            let view = parts.next().unwrap_or("");
            let feature = parts.next().unwrap_or("");
            if parts.next().is_some()
                || !["editor", "templates", "versions"].contains(&view)
                || feature.is_empty()
            {
                return Err(StorageError::Validation("Invalid feature reference".into()));
            }
            json!({"kind":"feature", "id":id, "note":"Selected interface feature; no resume content is included"})
        } else {
            return Err(StorageError::Validation("Unknown agent reference".into()));
        };
        payloads.push(payload);
    }
    if serde_json::to_vec(&payloads)?.len() > 36_000 {
        return Err(StorageError::Validation(
            "Selected context exceeds the 36 KiB budget".into(),
        ));
    }
    let final_cursor = store
        .load_cursor(&actual.document_id, &actual.context_id)?
        .ok_or_else(|| StorageError::NotFound("Current document is missing".into()))?;
    if final_cursor != actual {
        return Err(StorageError::Conflict(
            "Document changed during context selection".into(),
        ));
    }
    Ok(payloads)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_basic_reference_never_includes_unselected_contact_or_avatar() {
        let mut store = Store::open_in_memory().expect("store");
        let mut document = crate::domain::default_resume_document("doc-agent").expect("document");
        document.basic.name = "Selected Name".into();
        document.basic.phone = "private-phone-123".into();
        document.basic.avatar_asset_id = Some("private-avatar-hash".into());
        store
            .initialize_document(&document, "context-a")
            .expect("initialize");
        let cursor = store
            .load_cursor("doc-agent", "context-a")
            .expect("cursor")
            .unwrap();
        let selected = selected_context(&store, &cursor, &["basic:name".into()]).expect("selected");
        let serialized = serde_json::to_string(&selected).expect("json");
        assert!(serialized.contains("Selected Name"));
        assert!(!serialized.contains("private-phone-123"));
        assert!(!serialized.contains("private-avatar-hash"));
        assert!(matches!(
            selected_context(&store, &cursor, &["basic:avatar".into()]),
            Err(StorageError::Validation(_))
        ));
        assert!(matches!(
            selected_context(&store, &cursor, &["basic:avatarAssetId".into()]),
            Err(StorageError::Validation(_))
        ));
        assert!(matches!(
            selected_context(&store, &cursor, &["basic:name".into(), "basic:name".into()]),
            Err(StorageError::Validation(_))
        ));
    }
}
