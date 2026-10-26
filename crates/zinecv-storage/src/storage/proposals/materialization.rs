use super::*;

pub(super) fn change_target_value(
    document: &ResumeDocument,
    change: &ProposalChange,
) -> StorageResult<Value> {
    let value = serde_json::to_value(document)?;
    match change {
        ProposalChange::SetDocumentTitle { .. } => Ok(value["title"].clone()),
        ProposalChange::RenameSection { section_id, .. }
        | ProposalChange::SetSectionVisibility { section_id, .. }
        | ProposalChange::SetSummaryBody { section_id, .. } => {
            let section = section_value(&value, section_id)?;
            match change {
                ProposalChange::RenameSection { .. } => Ok(section["title"].clone()),
                ProposalChange::SetSectionVisibility { .. } => Ok(section["visible"].clone()),
                ProposalChange::SetSummaryBody { .. } => {
                    if section["kind"] != "summary" {
                        return Err(StorageError::Validation(
                            "Summary proposal target is not a summary section".into(),
                        ));
                    }
                    Ok(section["body"].clone())
                }
                _ => unreachable!(),
            }
        }
        ProposalChange::MoveSection { .. } => Ok(Value::Array(
            document
                .sections
                .iter()
                .map(|section| match section {
                    Section::Entry(section) => json!(section.id),
                    Section::Summary(section) => json!(section.id),
                })
                .collect(),
        )),
        ProposalChange::SetEntryBody { entry_id, .. } => {
            Ok(entry_value(&value, entry_id)?["body"].clone())
        }
        ProposalChange::UpdateEntryFields {
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
            let entry = entry_value(&value, entry_id)?;
            let names = [
                ("title", title.is_some()),
                ("role", role.is_some()),
                ("department", department.is_some()),
                ("city", city.is_some()),
                ("start", start.is_some()),
                ("end", end.is_some()),
                ("college", college.is_some()),
                ("mode", mode.is_some()),
            ];
            Ok(project_fields(entry, &names))
        }
        ProposalChange::AddEntry { entry, .. } => match entry_location(document, &entry.id) {
            Some((section_id, index, current)) => Ok(json!({
                "present": true, "sectionId": section_id, "index": index, "entry": current
            })),
            None => Ok(json!({"present": false})),
        },
        ProposalChange::DeleteEntry { entry_id } => match entry_location(document, entry_id) {
            Some((section_id, index, entry)) => Ok(json!({
                "present": true, "sectionId": section_id, "index": index, "entry": entry
            })),
            None => Ok(json!({"present": false})),
        },
        ProposalChange::MoveEntry { entry_id, .. } => {
            let (section_id, index, entry) = entry_location(document, entry_id)
                .ok_or_else(|| StorageError::NotFound("Proposal entry was not found".into()))?;
            let orders = document
                .sections
                .iter()
                .filter_map(|section| match section {
                    Section::Entry(section) => Some(json!({
                        "sectionId": section.id,
                        "entryIds": section.entries.iter().map(|entry| entry.id.clone()).collect::<Vec<_>>()
                    })),
                    Section::Summary(_) => None,
                })
                .collect::<Vec<_>>();
            Ok(json!({"sectionId": section_id, "index": index, "entry": entry, "orders": orders}))
        }
        ProposalChange::UpdateBasic { patch } => {
            let basic = &value["basic"];
            let names = [
                ("name", patch.name.is_some()),
                ("phone", patch.phone.is_some()),
                ("email", patch.email.is_some()),
                ("city", patch.city.is_some()),
                ("wechat", patch.wechat.is_some()),
                ("birth", patch.birth.is_some()),
                ("ageMode", patch.age_mode.is_some()),
                ("website", patch.website.is_some()),
                ("linkedin", patch.linkedin.is_some()),
                ("gender", patch.gender.is_some()),
                ("height", patch.height.is_some()),
                ("weight", patch.weight.is_some()),
                ("ethnicity", patch.ethnicity.is_some()),
                ("birthplace", patch.birthplace.is_some()),
                ("politicalStatus", patch.political_status.is_some()),
                ("maritalStatus", patch.marital_status.is_some()),
                ("zodiac", patch.zodiac.is_some()),
                ("mbti", patch.mbti.is_some()),
                ("avatarAssetId", patch.avatar_asset_id.is_some()),
            ];
            Ok(project_fields(basic, &names))
        }
        ProposalChange::ApplyTemplate { .. } => {
            Ok(Value::String(document.presentation.template_id.clone()))
        }
        // 版本副作用的提议值只绑定提交消息，保证确认时消息未被篡改。
        ProposalChange::CommitVersion { message } => Ok(Value::String(message.clone())),
    }
}

pub(super) fn project_fields(value: &Value, names: &[(&str, bool)]) -> Value {
    let mut result = Map::new();
    for (name, include) in names {
        if *include {
            result.insert((*name).into(), value[*name].clone());
        }
    }
    Value::Object(result)
}

pub(super) fn section_value<'a>(document: &'a Value, section_id: &str) -> StorageResult<&'a Value> {
    document["sections"]
        .as_array()
        .and_then(|sections| {
            sections
                .iter()
                .find(|section| section["id"].as_str() == Some(section_id))
        })
        .ok_or_else(|| StorageError::NotFound("Proposal section was not found".into()))
}

pub(super) fn entry_value<'a>(document: &'a Value, entry_id: &str) -> StorageResult<&'a Value> {
    document["sections"]
        .as_array()
        .and_then(|sections| {
            sections.iter().find_map(|section| {
                section["entries"].as_array().and_then(|entries| {
                    entries
                        .iter()
                        .find(|entry| entry["id"].as_str() == Some(entry_id))
                })
            })
        })
        .ok_or_else(|| StorageError::NotFound("Proposal entry was not found".into()))
}

pub(super) fn entry_location(
    document: &ResumeDocument,
    entry_id: &str,
) -> Option<(String, usize, zinecv_contracts::Entry)> {
    document.sections.iter().find_map(|section| {
        let Section::Entry(section) = section else {
            return None;
        };
        section
            .entries
            .iter()
            .enumerate()
            .find(|(_, entry)| entry.id == entry_id)
            .map(|(index, entry)| (section.id.clone(), index, entry.clone()))
    })
}

pub(super) fn scope_keys(
    document: &ResumeDocument,
    change: &ProposalChange,
) -> StorageResult<Vec<String>> {
    let keys = match change {
        ProposalChange::SetDocumentTitle { .. } => vec!["document:title".into()],
        ProposalChange::RenameSection { section_id, .. } => {
            vec![format!("section:{section_id}:title")]
        }
        ProposalChange::SetSectionVisibility { section_id, .. } => {
            vec![format!("section:{section_id}:visible")]
        }
        ProposalChange::MoveSection { section_id, .. } => {
            section_value(&serde_json::to_value(document)?, section_id)?;
            vec!["section:order".into()]
        }
        ProposalChange::SetEntryBody { entry_id, .. } => {
            vec![format!("entry:{entry_id}:body")]
        }
        ProposalChange::SetSummaryBody { section_id, .. } => {
            let value = serde_json::to_value(document)?;
            if section_value(&value, section_id)?["kind"] != "summary" {
                return Err(StorageError::Validation(
                    "Summary proposal target is not a summary section".into(),
                ));
            }
            vec![format!("summary:{section_id}:body")]
        }
        ProposalChange::UpdateEntryFields {
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
            entry_location(document, entry_id)
                .ok_or_else(|| StorageError::NotFound("Proposal entry was not found".into()))?;
            let names = [
                ("title", title.is_some()),
                ("role", role.is_some()),
                ("department", department.is_some()),
                ("city", city.is_some()),
                ("start", start.is_some()),
                ("end", end.is_some()),
                ("college", college.is_some()),
                ("mode", mode.is_some()),
            ];
            names
                .into_iter()
                .filter(|(_, include)| *include)
                .map(|(name, _)| format!("entry:{entry_id}:{name}"))
                .collect()
        }
        ProposalChange::AddEntry { section_id, entry } => {
            let value = serde_json::to_value(document)?;
            let section = section_value(&value, section_id)?;
            if section["kind"] == "summary" || entry_location(document, &entry.id).is_some() {
                return Err(StorageError::Validation(
                    "Proposal entry cannot be added to this target".into(),
                ));
            }
            vec![format!("entry-collection:{section_id}")]
        }
        ProposalChange::DeleteEntry { entry_id } => {
            entry_location(document, entry_id)
                .ok_or_else(|| StorageError::NotFound("Proposal entry was not found".into()))?;
            vec![format!("entry-identity:{entry_id}")]
        }
        ProposalChange::MoveEntry {
            entry_id,
            section_id,
            ..
        } => {
            entry_location(document, entry_id)
                .ok_or_else(|| StorageError::NotFound("Proposal entry was not found".into()))?;
            let value = serde_json::to_value(document)?;
            if section_value(&value, section_id)?["kind"] == "summary" {
                return Err(StorageError::Validation(
                    "Proposal entry cannot be moved to a summary".into(),
                ));
            }
            vec!["entry:order".into(), format!("entry-identity:{entry_id}")]
        }
        ProposalChange::UpdateBasic { patch } => {
            let names = [
                ("name", patch.name.is_some()),
                ("phone", patch.phone.is_some()),
                ("email", patch.email.is_some()),
                ("city", patch.city.is_some()),
                ("wechat", patch.wechat.is_some()),
                ("birth", patch.birth.is_some()),
                ("ageMode", patch.age_mode.is_some()),
                ("website", patch.website.is_some()),
                ("linkedin", patch.linkedin.is_some()),
                ("gender", patch.gender.is_some()),
                ("height", patch.height.is_some()),
                ("weight", patch.weight.is_some()),
                ("ethnicity", patch.ethnicity.is_some()),
                ("birthplace", patch.birthplace.is_some()),
                ("politicalStatus", patch.political_status.is_some()),
                ("maritalStatus", patch.marital_status.is_some()),
                ("zodiac", patch.zodiac.is_some()),
                ("mbti", patch.mbti.is_some()),
                ("avatarAssetId", patch.avatar_asset_id.is_some()),
            ];
            names
                .into_iter()
                .filter(|(_, include)| *include)
                .map(|(name, _)| format!("basic:{name}"))
                .collect()
        }
        ProposalChange::ApplyTemplate { template_id } => {
            if !matches!(
                template_id.as_str(),
                "legacy-v1" | "clear-single-v1" | "compact-single-v1"
            ) {
                return Err(StorageError::Permission(
                    "Template proposals are limited to the three built-in templates".into(),
                ));
            }
            vec!["presentation:template".into()]
        }
        ProposalChange::CommitVersion { message } => {
            let trimmed = message.trim();
            if trimmed.is_empty() || trimmed.chars().count() > 200 {
                return Err(StorageError::Validation(
                    "Version commit message is invalid".into(),
                ));
            }
            vec!["version:head".into()]
        }
    };
    if keys.is_empty() {
        return Err(StorageError::Validation(
            "Proposal change has no document fields".into(),
        ));
    }
    Ok(keys)
}

pub(super) fn inverse_commands(
    document: &ResumeDocument,
    change: &ProposalChange,
    before: &Value,
) -> StorageResult<Vec<DomainCommand>> {
    let one = |command| Ok(vec![command]);
    match change {
        ProposalChange::SetDocumentTitle { .. } => one(DomainCommand::SetDocumentTitle {
            title: before
                .as_str()
                .ok_or_else(|| StorageError::Corrupt("Bad title before-value".into()))?
                .to_string(),
        }),
        ProposalChange::RenameSection { section_id, .. } => one(DomainCommand::RenameSection {
            section_id: section_id.clone(),
            title: before
                .as_str()
                .ok_or_else(|| StorageError::Corrupt("Bad section title before-value".into()))?
                .to_string(),
        }),
        ProposalChange::SetSectionVisibility { section_id, .. } => {
            one(DomainCommand::SetSectionVisibility {
                section_id: section_id.clone(),
                visible: before
                    .as_bool()
                    .ok_or_else(|| StorageError::Corrupt("Bad visibility before-value".into()))?,
            })
        }
        ProposalChange::MoveSection { .. } => {
            let order = before
                .as_array()
                .ok_or_else(|| StorageError::Corrupt("Bad section order before-value".into()))?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .ok_or_else(|| StorageError::Corrupt("Bad section ID".into()))
                })
                .collect::<StorageResult<Vec<_>>>()?;
            reorder_sections(document, &order)
        }
        ProposalChange::SetEntryBody { entry_id, .. } => one(DomainCommand::SetEntryBody {
            entry_id: entry_id.clone(),
            body: serde_json::from_value(before.clone())?,
        }),
        ProposalChange::SetSummaryBody { section_id, .. } => one(DomainCommand::SetSummaryBody {
            section_id: section_id.clone(),
            body: serde_json::from_value(before.clone())?,
        }),
        ProposalChange::UpdateEntryFields { entry_id, .. } => {
            let get_text = |name: &str| -> StorageResult<Option<String>> {
                before
                    .get(name)
                    .and_then(Value::as_str)
                    .map(|value| Some(value.to_string()))
                    .ok_or_else(|| StorageError::Corrupt(format!("Bad {name} before-value")))
            };
            let get_optional = |name: &str| -> StorageResult<Option<String>> {
                let value = before
                    .get(name)
                    .ok_or_else(|| StorageError::Corrupt(format!("Missing {name} before-value")))?;
                if value.is_null() {
                    Ok(Some(String::new()))
                } else {
                    value
                        .as_str()
                        .map(|value| Some(value.to_string()))
                        .ok_or_else(|| StorageError::Corrupt(format!("Bad {name} before-value")))
                }
            };
            one(DomainCommand::UpdateEntryFields {
                entry_id: entry_id.clone(),
                title: if before.get("title").is_some() {
                    get_text("title")?
                } else {
                    None
                },
                role: if before.get("role").is_some() {
                    get_text("role")?
                } else {
                    None
                },
                department: if before.get("department").is_some() {
                    get_text("department")?
                } else {
                    None
                },
                city: if before.get("city").is_some() {
                    get_text("city")?
                } else {
                    None
                },
                start: if before.get("start").is_some() {
                    get_text("start")?
                } else {
                    None
                },
                end: if before.get("end").is_some() {
                    get_text("end")?
                } else {
                    None
                },
                college: if before.get("college").is_some() {
                    get_optional("college")?
                } else {
                    None
                },
                mode: if before.get("mode").is_some() {
                    get_optional("mode")?
                } else {
                    None
                },
            })
        }
        ProposalChange::AddEntry { entry, .. } => one(DomainCommand::DeleteEntry {
            entry_id: entry.id.clone(),
        }),
        ProposalChange::DeleteEntry { entry_id } => {
            let section_id = before["sectionId"]
                .as_str()
                .ok_or_else(|| StorageError::Corrupt("Missing deleted entry section".into()))?
                .to_string();
            let index = before["index"]
                .as_u64()
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| StorageError::Corrupt("Missing deleted entry index".into()))?;
            let entry = serde_json::from_value(before["entry"].clone())?;
            Ok(vec![
                DomainCommand::AddEntry {
                    section_id: section_id.clone(),
                    entry,
                },
                DomainCommand::MoveEntry {
                    entry_id: entry_id.clone(),
                    section_id,
                    index,
                },
            ])
        }
        ProposalChange::MoveEntry { entry_id, .. } => one(DomainCommand::MoveEntry {
            entry_id: entry_id.clone(),
            section_id: before["sectionId"]
                .as_str()
                .ok_or_else(|| StorageError::Corrupt("Missing old entry section".into()))?
                .to_string(),
            index: before["index"]
                .as_u64()
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| StorageError::Corrupt("Missing old entry index".into()))?,
        }),
        ProposalChange::UpdateBasic { patch } => {
            let mut basic: BasicInfo =
                serde_json::from_value(serde_json::to_value(&document.basic)?)?;
            let mut fields = Vec::new();
            macro_rules! restore_field {
                ($json:literal, $field:ident, $enum:ident) => {
                    if patch.$field.is_some() {
                        basic.$field =
                            serde_json::from_value(before.get($json).cloned().ok_or_else(
                                || StorageError::Corrupt(format!("Missing {} before-value", $json)),
                            )?)?;
                        fields.push(BasicField::$enum);
                    }
                };
            }
            restore_field!("name", name, Name);
            restore_field!("phone", phone, Phone);
            restore_field!("email", email, Email);
            restore_field!("city", city, City);
            restore_field!("wechat", wechat, Wechat);
            restore_field!("birth", birth, Birth);
            restore_field!("ageMode", age_mode, AgeMode);
            restore_field!("website", website, Website);
            restore_field!("linkedin", linkedin, Linkedin);
            restore_field!("gender", gender, Gender);
            restore_field!("height", height, Height);
            restore_field!("weight", weight, Weight);
            restore_field!("ethnicity", ethnicity, Ethnicity);
            restore_field!("birthplace", birthplace, Birthplace);
            restore_field!("politicalStatus", political_status, PoliticalStatus);
            restore_field!("maritalStatus", marital_status, MaritalStatus);
            restore_field!("zodiac", zodiac, Zodiac);
            restore_field!("mbti", mbti, Mbti);
            restore_field!("avatarAssetId", avatar_asset_id, AvatarAssetId);
            one(DomainCommand::RestoreBasicFields {
                fields,
                values: basic,
            })
        }
        ProposalChange::ApplyTemplate { .. } => {
            let template_id = before
                .as_str()
                .ok_or_else(|| StorageError::Corrupt("Bad template before-value".into()))?
                .to_string();
            let mut presentation = document.presentation.clone();
            presentation.template_id = template_id;
            one(DomainCommand::SetLayout { presentation })
        }
        // 版本提交是持久历史，撤回只还原正文，不产生版本逆操作。
        ProposalChange::CommitVersion { .. } => Ok(Vec::new()),
    }
}

pub(super) fn reorder_sections(
    document: &ResumeDocument,
    desired: &[String],
) -> StorageResult<Vec<DomainCommand>> {
    if desired.len() != document.sections.len() {
        return Err(StorageError::Corrupt(
            "Bad section order before-value".into(),
        ));
    }
    let mut current = document
        .sections
        .iter()
        .map(|section| match section {
            Section::Entry(section) => section.id.clone(),
            Section::Summary(section) => section.id.clone(),
        })
        .collect::<Vec<_>>();
    let desired_set = desired.iter().cloned().collect::<BTreeSet<_>>();
    if desired_set.len() != desired.len() || desired.iter().any(|id| !current.contains(id)) {
        return Err(StorageError::Corrupt("Bad section order IDs".into()));
    }
    let mut commands = Vec::new();
    for (index, section_id) in desired.iter().enumerate() {
        let from = current
            .iter()
            .position(|id| id == section_id)
            .ok_or_else(|| StorageError::Corrupt("Missing section in undo target".into()))?;
        if from != index {
            let value = current.remove(from);
            current.insert(index, value);
            commands.push(DomainCommand::MoveSection {
                section_id: section_id.clone(),
                index,
            });
        }
    }
    if commands.is_empty() {
        return Err(StorageError::Conflict(
            "Section order no longer needs undo".into(),
        ));
    }
    Ok(commands)
}
