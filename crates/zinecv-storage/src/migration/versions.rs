use super::*;

pub(super) fn inspect_version_store(
    value: &serde_json::Value,
    source_id: &str,
    path: &str,
    counts: &mut LegacyMigrationCounts,
    evidence: &mut Vec<LegacyMigrationFieldEvidence>,
    issues: &mut Vec<LegacyMigrationIssue>,
    entities: &mut Vec<EntityFingerprint>,
) -> Option<String> {
    let store = if value.get("format").and_then(serde_json::Value::as_str)
        == Some("resume-diy-version-backup")
    {
        value.get("store")?
    } else {
        value
    };
    let Some(store) = as_record(store) else {
        add_issue(
            issues,
            source_id,
            "invalid_version_store",
            path,
            LegacyMigrationSeverity::Error,
            "Version data must be a JSON object.",
        );
        return None;
    };
    let Some(branches) = store.get("branches").and_then(serde_json::Value::as_array) else {
        add_issue(
            issues,
            source_id,
            "invalid_branches",
            &format!("{path}.branches"),
            LegacyMigrationSeverity::Error,
            "Version data is missing a branches array.",
        );
        return None;
    };
    let Some(commits) = store.get("commits").and_then(serde_json::Value::as_array) else {
        add_issue(
            issues,
            source_id,
            "invalid_commits",
            &format!("{path}.commits"),
            LegacyMigrationSeverity::Error,
            "Version data is missing a commits array.",
        );
        return None;
    };
    counts.version_branches = counts
        .version_branches
        .saturating_add(branches.len() as u32);
    counts.version_commits = counts.version_commits.saturating_add(commits.len() as u32);
    add_evidence(
        evidence,
        &format!("{path}.branches"),
        branches.len(),
        "present",
    );
    add_evidence(
        evidence,
        &format!("{path}.commits"),
        commits.len(),
        "present",
    );

    let mut branch_ids = HashMap::<String, (String, String)>::new();
    let mut branch_names = HashMap::<String, String>::new();
    for (index, branch) in branches.iter().enumerate() {
        let Some(branch) = as_record(branch) else {
            add_issue(
                issues,
                source_id,
                "invalid_branch",
                &format!("{path}.branches[{index}]"),
                LegacyMigrationSeverity::Error,
                "A branch must be a JSON object.",
            );
            continue;
        };
        let Some(id) = nonempty_string(branch.get("id")) else {
            add_issue(
                issues,
                source_id,
                "missing_branch_id",
                &format!("{path}.branches[{index}].id"),
                LegacyMigrationSeverity::Error,
                "A branch identifier is required.",
            );
            continue;
        };
        let Some(name) = nonempty_string(branch.get("name")) else {
            add_issue(
                issues,
                source_id,
                "invalid_branch_name",
                &format!("{path}.branches[{index}].name"),
                LegacyMigrationSeverity::Error,
                "A branch name must be a nonempty string.",
            );
            continue;
        };
        if nonempty_string(branch.get("createdAt")).is_none() {
            add_issue(
                issues,
                source_id,
                "missing_branch_timestamp",
                &format!("{path}.branches[{index}].createdAt"),
                LegacyMigrationSeverity::Error,
                "A branch creation timestamp must be a nonempty string.",
            );
        }
        if !branch.contains_key("headCommitId") {
            add_issue(
                issues,
                source_id,
                "missing_branch_head",
                &format!("{path}.branches[{index}].headCommitId"),
                LegacyMigrationSeverity::Error,
                "A branch head field is required; use null for an empty branch.",
            );
        }
        if branch_ids.contains_key(id) {
            add_issue(
                issues,
                source_id,
                "duplicate_branch_id",
                &format!("{path}.branches[{index}].id"),
                LegacyMigrationSeverity::Error,
                "A branch identifier occurs more than once.",
            );
        }
        if let Some(previous_id) = branch_names.get(name) {
            if previous_id != id {
                add_issue(
                    issues,
                    source_id,
                    "same_name_different_branch_id",
                    &format!("{path}.branches[{index}].name"),
                    LegacyMigrationSeverity::Review,
                    "Different branch identifiers share a name; neither is selected automatically.",
                );
            }
        } else {
            branch_names.insert(name.into(), id.into());
        }
        let hash = sha256(
            &serde_json::to_vec(&serde_json::Value::Object(branch.clone())).unwrap_or_default(),
        );
        branch_ids
            .entry(id.into())
            .or_insert((hash.clone(), name.into()));
        entities.push(fingerprint_entity(
            source_id,
            "version-branch",
            id,
            &serde_json::Value::Object(branch.clone()),
            Some(name),
        ));
    }
    if !branch_ids.contains_key("main") {
        add_issue(
            issues,
            source_id,
            "missing_main_branch",
            &format!("{path}.branches"),
            LegacyMigrationSeverity::Error,
            "The source version graph must contain a main branch.",
        );
    }
    let current_branch = nonempty_string(store.get("currentBranchId"));
    if current_branch.is_none_or(|id| !branch_ids.contains_key(id)) {
        add_issue(
            issues,
            source_id,
            "missing_current_branch",
            &format!("{path}.currentBranchId"),
            LegacyMigrationSeverity::Error,
            "The active branch does not reference a known branch.",
        );
    }

    let mut commit_ids = HashMap::<String, (String, String, Option<String>)>::new();
    let mut seen_commit_ids = HashSet::new();
    let mut snapshot_hashes = HashMap::<String, String>::new();
    for (index, commit) in commits.iter().enumerate() {
        let Some(commit) = as_record(commit) else {
            add_issue(
                issues,
                source_id,
                "invalid_commit",
                &format!("{path}.commits[{index}]"),
                LegacyMigrationSeverity::Error,
                "A commit must be a JSON object.",
            );
            continue;
        };
        let Some(id) = nonempty_string(commit.get("id")) else {
            add_issue(
                issues,
                source_id,
                "missing_commit_id",
                &format!("{path}.commits[{index}].id"),
                LegacyMigrationSeverity::Error,
                "A commit identifier is required.",
            );
            continue;
        };
        if !seen_commit_ids.insert(id.to_string()) {
            add_issue(
                issues,
                source_id,
                "duplicate_commit_id",
                &format!("{path}.commits[{index}].id"),
                LegacyMigrationSeverity::Error,
                "A commit identifier occurs more than once.",
            );
        }
        let Some(branch_id) = nonempty_string(commit.get("branchId")) else {
            add_issue(
                issues,
                source_id,
                "invalid_commit_branch",
                &format!("{path}.commits[{index}].branchId"),
                LegacyMigrationSeverity::Error,
                "A commit branch identifier must be a nonempty string.",
            );
            continue;
        };
        let parent_id = match commit.get("parentId") {
            Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(parent)) if !parent.trim().is_empty() => {
                Some(parent.clone())
            }
            Some(_) => {
                add_issue(
                    issues,
                    source_id,
                    "invalid_commit_parent",
                    &format!("{path}.commits[{index}].parentId"),
                    LegacyMigrationSeverity::Error,
                    "A commit parent must be a nonempty string or null.",
                );
                None
            }
            None => {
                add_issue(
                    issues,
                    source_id,
                    "legacy_missing_parent_field",
                    &format!("{path}.commits[{index}].parentId"),
                    LegacyMigrationSeverity::Info,
                    "This older commit has no parent field; its history is retained as a broken edge.",
                );
                None
            }
        };
        if let Some(snapshot) = commit.get("snapshot") {
            let _ = inspect_snapshot(
                snapshot,
                source_id,
                &format!("{path}.commits[{index}].snapshot"),
                counts,
                evidence,
                issues,
                entities,
            );
            let snapshot_hash = sha256(&serde_json::to_vec(snapshot).unwrap_or_default());
            if let Some(previous_id) = snapshot_hashes.get(&snapshot_hash) {
                if previous_id != id {
                    add_issue(issues, source_id, "same_content_different_commit", &format!("{path}.commits[{index}].snapshot"), LegacyMigrationSeverity::Info, "Identical snapshot content has distinct commit identities; both commits remain distinct.");
                }
            } else {
                snapshot_hashes.insert(snapshot_hash.clone(), id.into());
            }
            entities.push(fingerprint_entity(
                source_id,
                "version-commit",
                id,
                snapshot,
                nonempty_string(commit.get("message")),
            ));
            commit_ids
                .entry(id.into())
                .or_insert((branch_id.into(), snapshot_hash, parent_id));
        } else {
            add_issue(
                issues,
                source_id,
                "missing_commit_snapshot",
                &format!("{path}.commits[{index}].snapshot"),
                LegacyMigrationSeverity::Error,
                "A commit without a snapshot cannot be converted.",
            );
        }
        if !commit
            .get("message")
            .is_some_and(serde_json::Value::is_string)
        {
            add_issue(
                issues,
                source_id,
                "invalid_commit_message",
                &format!("{path}.commits[{index}].message"),
                LegacyMigrationSeverity::Error,
                "Commit messages must be strings and the field is required.",
            );
        }
        if nonempty_string(commit.get("createdAt")).is_none() {
            add_issue(
                issues,
                source_id,
                "missing_commit_timestamp",
                &format!("{path}.commits[{index}].createdAt"),
                LegacyMigrationSeverity::Error,
                "A commit creation timestamp must be a nonempty string.",
            );
        }
    }
    for (index, branch) in branches.iter().enumerate() {
        let Some(branch) = as_record(branch) else {
            continue;
        };
        if let Some(head) = nonempty_string(branch.get("headCommitId")) {
            if !commit_ids.contains_key(head) {
                add_issue(
                    issues,
                    source_id,
                    "unknown_branch_head",
                    &format!("{path}.branches[{index}].headCommitId"),
                    LegacyMigrationSeverity::Error,
                    "A branch head refers to an unknown commit.",
                );
            }
        } else if branch
            .get("headCommitId")
            .is_some_and(|head| !head.is_null())
        {
            add_issue(
                issues,
                source_id,
                "invalid_branch_head",
                &format!("{path}.branches[{index}].headCommitId"),
                LegacyMigrationSeverity::Error,
                "A branch head must be a string or null.",
            );
        }
    }
    let mut reachable_from_heads = HashSet::new();
    let mut pending_heads = branches
        .iter()
        .filter_map(as_record)
        .filter_map(|branch| nonempty_string(branch.get("headCommitId")))
        .map(str::to_string)
        .collect::<Vec<_>>();
    while let Some(id) = pending_heads.pop() {
        if !reachable_from_heads.insert(id.clone()) {
            continue;
        }
        if let Some((_, _, Some(parent))) = commit_ids.get(&id) {
            if commit_ids.contains_key(parent) {
                pending_heads.push(parent.clone());
            }
        }
    }
    for (index, commit) in commits.iter().enumerate() {
        let Some(commit) = as_record(commit) else {
            continue;
        };
        let (Some(commit_id), Some(branch_id)) = (
            nonempty_string(commit.get("id")),
            nonempty_string(commit.get("branchId")),
        ) else {
            continue;
        };
        if !branch_ids.contains_key(branch_id) {
            add_issue(
                issues,
                source_id,
                "unknown_commit_branch",
                &format!("{path}.commits[{index}].branchId"),
                if reachable_from_heads.contains(commit_id) {
                    LegacyMigrationSeverity::Info
                } else {
                    LegacyMigrationSeverity::Error
                },
                if reachable_from_heads.contains(commit_id) {
                    "A reachable ancestor references a deleted source branch and is retained as history."
                } else {
                    "A commit outside surviving branch history refers to a missing branch."
                },
            );
        }
    }
    for (index, commit) in commits.iter().enumerate() {
        let Some(commit) = as_record(commit) else {
            continue;
        };
        if let Some(parent) = nonempty_string(commit.get("parentId")) {
            if !commit_ids.contains_key(parent) {
                add_issue(
                    issues,
                    source_id,
                    "unknown_commit_parent",
                    &format!("{path}.commits[{index}].parentId"),
                    LegacyMigrationSeverity::Info,
                    "The legacy version schema retains missing parents as broken history edges.",
                );
            }
        }
    }
    let mut done = HashSet::new();
    for id in commit_ids.keys() {
        let mut visiting = HashSet::new();
        let mut current = Some(id.as_str());
        while let Some(current_id) = current {
            if done.contains(current_id) {
                break;
            }
            if !visiting.insert(current_id.to_string()) {
                add_issue(
                    issues,
                    source_id,
                    "commit_parent_cycle",
                    &format!("{path}.commits"),
                    LegacyMigrationSeverity::Error,
                    "The commit parent graph contains a cycle.",
                );
                break;
            }
            current = commit_ids
                .get(current_id)
                .and_then(|(_, _, parent)| parent.as_deref());
        }
        done.extend(visiting);
    }
    let canonical =
        sha256(&serde_json::to_vec(&serde_json::Value::Object(store.clone())).unwrap_or_default());
    Some(canonical)
}
