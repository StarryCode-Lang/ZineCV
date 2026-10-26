use super::*;

impl Store {
    /// Append a reviewed legacy version graph and optionally apply its draft in one
    /// IMMEDIATE transaction. Existing native history is retained; migration receipts
    /// make retries safe after a lost IPC response.
    pub fn commit_legacy_migration(
        &mut self,
        actor: &str,
        request: &CommitLegacyMigrationRequest,
    ) -> StorageResult<LegacyMigrationCommitReceipt> {
        if actor.trim().is_empty()
            || request.command_id.trim().is_empty()
            || request.command_id.len() > 160
            || (!request
                .version_graph
                .as_ref()
                .is_some_and(|graph| !graph.branches.is_empty() || !graph.commits.is_empty())
                && request.current_draft.is_none())
        {
            return Err(StorageError::Validation(
                "Invalid legacy migration commit request".into(),
            ));
        }
        if !request.confirmed {
            return Err(StorageError::Permission(
                "Legacy migration requires explicit user confirmation".into(),
            ));
        }

        let report = migration::inspect(&request.inspection);
        if !report.ready_for_dry_run
            || !migration::expected_source_hashes_match(&report, &request.expected_source_hashes)
        {
            return Err(StorageError::Conflict(
                "Legacy migration sources changed or contain blocking errors".into(),
            ));
        }
        let batch_key = migration::source_batch_key(&report)
            .ok_or_else(|| StorageError::Validation("A source namespace is required".into()))?;
        let required_reviews = migration::required_review_item_keys(&report);
        let acknowledged: HashSet<&str> = request
            .acknowledged_review_items
            .iter()
            .map(String::as_str)
            .collect();
        if required_reviews
            .iter()
            .any(|key| !acknowledged.contains(key.as_str()))
        {
            return Err(StorageError::Permission(
                "Migration review items have not all been acknowledged".into(),
            ));
        }
        let mut seen_preference_keys = HashSet::new();
        for preference in &request.preferences {
            let key = preference.key.as_str();
            let valid_key = !key.is_empty()
                && key.len() <= 160
                && key.chars().next().is_some_and(|character| {
                    character.is_ascii_lowercase() || character.is_ascii_digit()
                })
                && key.chars().all(|character| {
                    character.is_ascii_lowercase()
                        || character.is_ascii_digit()
                        || matches!(character, '.' | '_' | '-')
                });
            if !valid_key
                || preference.value.len() > 16_384
                || !seen_preference_keys.insert(key.to_string())
            {
                return Err(StorageError::Validation(
                    "Migrated preferences contain an invalid, oversized, or duplicate key".into(),
                ));
            }
        }
        if let Some(templates) = request.templates.as_ref() {
            let catalog_count =
                serde_json::from_str::<Vec<serde_json::Value>>(&templates.catalog_json)
                    .map(|catalog| catalog.len())
                    .unwrap_or(usize::MAX);
            let parsed_revision = templates.expected_revision.parse::<i64>();
            if templates.catalog_json.len() > 4 * 1024 * 1024
                || catalog_count > 64
                || parsed_revision.is_err()
                || parsed_revision.as_ref().is_ok_and(|revision| *revision < 0)
            {
                return Err(StorageError::Validation(
                    "Migrated template catalog is invalid or oversized".into(),
                ));
            }
        }

        let namespace = report
            .source_namespace
            .as_deref()
            .ok_or_else(|| StorageError::Validation("A source namespace is required".into()))?;
        if request
            .accepted_identity_updates
            .iter()
            .collect::<HashSet<_>>()
            .len()
            != request.accepted_identity_updates.len()
        {
            return Err(StorageError::Validation(
                "Accepted migration identity updates contain duplicates".into(),
            ));
        }
        let accepted_updates: HashSet<String> =
            request.accepted_identity_updates.iter().cloned().collect();
        let mut request_fingerprint = request.clone();
        request_fingerprint.command_id.clear();
        if let Some(templates) = request_fingerprint.templates.as_mut() {
            // CAS is checked against the real revision before publication. A
            // replay after successful publication necessarily sees a new one.
            templates.expected_revision = "0".into();
            templates.catalog_json =
                resources::migration_catalog_fingerprint(&templates.catalog_json)?;
        }
        let mut request_value = serde_json::to_value(&request_fingerprint)?;
        if let Some(object) = request_value.as_object_mut() {
            object.remove("cursor");
        }
        let request_hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&request_value)?));

        if let Some(graph) = request.version_graph.as_ref() {
            let source = report
                .sources
                .iter()
                .find(|source| source.source_id == graph.source_id)
                .ok_or_else(|| {
                    StorageError::Validation("Version source was not inspected".into())
                })?;
            if source.counts.version_branches as usize != graph.branches.len()
                || source.counts.version_commits as usize != graph.commits.len()
                || graph.branches.len() > 10_000
                || graph.commits.len() > 100_000
            {
                return Err(StorageError::Validation(
                    "Converted version graph does not match its inspected inventory".into(),
                ));
            }
            validate_legacy_version_graph(graph)?;
        }
        if let Some(draft) = request.current_draft.as_ref() {
            if draft.document_id != request.cursor.document_id {
                return Err(StorageError::Validation(
                    "Imported draft must target the selected document".into(),
                ));
            }
            zinecv_domain::DocumentContext::new(draft.clone()).map_err(StorageError::Domain)?;
        }

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        let prior_command: Option<(String, String, String)> = transaction
            .query_row(
                "SELECT batch_key, actor, request_hash FROM legacy_migration_commands
                 WHERE command_id = ?1",
                params![request.command_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((prior_key, prior_actor, prior_hash)) = prior_command.as_ref() {
            if prior_key != &batch_key || prior_actor != actor || prior_hash != &request_hash {
                return Err(StorageError::Conflict(
                    "Migration command ID has already been used".into(),
                ));
            }
        }
        let prior_batch: Option<(String, String, String, String)> = transaction
            .query_row(
                "SELECT command_id, actor, request_hash, receipt_json
                 FROM legacy_migration_batches WHERE batch_key = ?1",
                params![batch_key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if let Some((_command_id, prior_actor, prior_hash, receipt_json)) = prior_batch {
            if let Some(templates) = request.templates.as_ref() {
                let current_revision: i64 = transaction.query_row(
                      "SELECT COALESCE((SELECT revision FROM imported_template_catalog WHERE id = 1), 0)",
                      [],
                      |row| row.get(0),
                  )?;
                if templates
                    .expected_revision
                    .parse::<i64>()
                    .unwrap_or(i64::MAX)
                    > current_revision
                {
                    return Err(StorageError::Conflict(
                        "Migration template catalog revision is not available".into(),
                    ));
                }
            }
            if prior_actor != actor || prior_hash != request_hash {
                return Err(StorageError::Conflict(
                    "This migration batch was already committed with different reviewed data"
                        .into(),
                ));
            }
            let mut receipt: LegacyMigrationCommitReceipt = serde_json::from_str(&receipt_json)?;
            if prior_command.is_none() {
                transaction.execute(
                    "INSERT INTO legacy_migration_commands(command_id, batch_key, actor, request_hash)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![request.command_id, batch_key, actor, request_hash],
                )?;
            }
            receipt.idempotent_replay = true;
            transaction.commit()?;
            return Ok(receipt);
        }

        let (document_id, context_id, current_branch_id, revision): (String, String, String, i64) =
            transaction
                .query_row(
                    "SELECT id, active_context_id, current_branch_id, revision
                     FROM documents WHERE id = ?1",
                    params![request.cursor.document_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?
                .ok_or_else(|| {
                    StorageError::NotFound("Migration target document is missing".into())
                })?;
        let current_head: Option<String> = transaction
            .query_row(
                "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
                params![current_branch_id, document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Migration target branch is missing".into()))?;
        if context_id != request.cursor.context_id
            || current_branch_id != request.cursor.branch_id
            || revision.to_string() != request.cursor.revision
            || current_head != request.cursor.head_id
        {
            return Err(StorageError::Conflict(
                "Migration target cursor is stale".into(),
            ));
        }
        let (draft_revision, durable_draft_json, durable_draft_hash): (i64, String, String) =
            transaction
                .query_row(
                    "SELECT revision, document_json, hash FROM drafts
                     WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                    params![document_id, context_id, current_branch_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
                .ok_or_else(|| StorageError::Corrupt("Migration target draft is missing".into()))?;
        let durable_draft: ResumeDocument = serde_json::from_str(&durable_draft_json)?;
        zinecv_domain::DocumentContext::new(durable_draft.clone()).map_err(StorageError::Domain)?;
        if draft_revision != revision
            || durable_draft.document_id != document_id
            || canonical_hash(&durable_draft)? != durable_draft_hash
        {
            return Err(StorageError::Conflict(
                "Migration target draft does not match durable authority".into(),
            ));
        }

        let mut created_mapping_count = 0_u32;
        let mut created_branch_count = 0_u32;
        let mut created_commit_count = 0_u32;
        let mut migrated_avatar_count = 0_u32;
        let mut identity_context = LegacyIdentityContext {
            namespace,
            document_id: &document_id,
            accepted_updates: &accepted_updates,
            used_updates: HashSet::new(),
        };
        if let Some(graph) = request.version_graph.as_ref() {
            let mut branch_ids = HashMap::new();
            let mut branch_records = HashMap::new();
            let mut new_branch_ids = HashSet::new();
            let mut existing_names = {
                let mut statement =
                    transaction.prepare("SELECT name FROM branches WHERE document_id = ?1")?;
                let names = statement
                    .query_map(params![document_id], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .map(|name| name.to_lowercase())
                    .collect::<HashSet<_>>();
                names
            };
            let mut missing_origins = graph
                .commits
                .iter()
                .filter(|commit| {
                    !graph
                        .branches
                        .iter()
                        .any(|branch| branch.id == commit.branch_id)
                })
                .map(|commit| commit.branch_id.clone())
                .collect::<Vec<_>>();
            missing_origins.sort_unstable();
            missing_origins.dedup();

            for branch in &graph.branches {
                let head_content_hash = branch
                    .head_commit_id
                    .as_deref()
                    .and_then(|head| graph.commits.iter().find(|commit| commit.id == head))
                    .map(migration_content_hash)
                    .transpose()?;
                let content_hash = migration_content_hash(&(branch, head_content_hash))?;
                let (native_id, is_new_mapping) = Self::resolve_legacy_identity(
                    &transaction,
                    &mut identity_context,
                    "branch",
                    &branch.id,
                    &content_hash,
                )?;
                if is_new_mapping {
                    created_mapping_count = created_mapping_count.saturating_add(1);
                }
                branch_ids.insert(branch.id.clone(), native_id.clone());
                branch_records.insert(branch.id.clone(), (branch.clone(), content_hash, native_id));
            }
            for legacy_id in missing_origins {
                let content_hash = migration_deleted_branch_hash(&legacy_id);
                let (native_id, is_new_mapping) = Self::resolve_legacy_identity(
                    &transaction,
                    &mut identity_context,
                    "branch",
                    &legacy_id,
                    &content_hash,
                )?;
                if is_new_mapping {
                    created_mapping_count = created_mapping_count.saturating_add(1);
                    let name = format!("__deleted__:{native_id}");
                    transaction.execute(
                        "INSERT INTO branches(id, document_id, name, head_commit_id, created_at)
                         VALUES (?1, ?2, ?3, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                        params![native_id, document_id, name],
                    )?;
                    transaction.execute(
                        "INSERT INTO branch_tombstones(branch_id) VALUES (?1)",
                        params![native_id],
                    )?;
                    created_branch_count = created_branch_count.saturating_add(1);
                    new_branch_ids.insert(native_id.clone());
                }
                branch_ids.insert(legacy_id, native_id);
            }

            let mut commit_ids = HashMap::new();
            let mut commit_is_new = HashMap::new();
            for commit in &graph.commits {
                let content_hash = migration_content_hash(commit)?;
                let (native_id, is_new_mapping) = Self::resolve_legacy_identity(
                    &transaction,
                    &mut identity_context,
                    "commit",
                    &commit.id,
                    &content_hash,
                )?;
                if is_new_mapping {
                    created_mapping_count = created_mapping_count.saturating_add(1);
                }
                commit_ids.insert(commit.id.clone(), native_id.clone());
                commit_is_new.insert(commit.id.clone(), is_new_mapping);
            }
            for (legacy_id, (branch, _content_hash, native_id)) in &branch_records {
                let exists: Option<(String, Option<String>)> = transaction
                    .query_row(
                        "SELECT document_id, head_commit_id FROM branches WHERE id = ?1",
                        params![native_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                if let Some((existing_document, _)) = exists {
                    if existing_document != document_id {
                        return Err(StorageError::Conflict(
                            "Mapped legacy branch belongs to another document".into(),
                        ));
                    }
                } else {
                    let requested_name = branch.name.trim();
                    if requested_name.is_empty()
                        || requested_name.len() > 512
                        || requested_name.chars().any(char::is_control)
                    {
                        return Err(StorageError::Validation(
                            "Imported branch has an invalid name".into(),
                        ));
                    }
                    let name =
                        unique_legacy_branch_name(requested_name, native_id, &existing_names);
                    existing_names.insert(name.to_lowercase());
                    transaction.execute(
                        "INSERT INTO branches(id, document_id, name, head_commit_id, created_at)
                         VALUES (?1, ?2, ?3, NULL, ?4)",
                        params![native_id, document_id, name, branch.created_at],
                    )?;
                    created_branch_count = created_branch_count.saturating_add(1);
                    new_branch_ids.insert(native_id.clone());
                }
                if !branch_ids.contains_key(legacy_id) {
                    return Err(StorageError::Corrupt(
                        "Legacy branch identity is missing".into(),
                    ));
                }
            }

            for commit in &graph.commits {
                let native_id = commit_ids.get(&commit.id).ok_or_else(|| {
                    StorageError::Corrupt("Legacy commit identity is missing".into())
                })?;
                let exists: Option<String> = transaction
                    .query_row(
                        "SELECT document_id FROM commits WHERE id = ?1",
                        params![native_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(existing_document) = exists {
                    if existing_document != document_id {
                        return Err(StorageError::Conflict(
                            "Mapped legacy commit belongs to another document".into(),
                        ));
                    }
                    commit_is_new.insert(commit.id.clone(), false);
                    continue;
                }
                let origin_branch = branch_ids.get(&commit.branch_id).ok_or_else(|| {
                    StorageError::Validation("Commit branch is unresolved".into())
                })?;
                let mut snapshot = commit.snapshot.clone();
                snapshot.document_id = document_id.clone();
                if resources::normalize_legacy_avatar(&transaction, &mut snapshot)? {
                    migrated_avatar_count = migrated_avatar_count.saturating_add(1);
                }
                zinecv_domain::DocumentContext::new(snapshot.clone())
                    .map_err(StorageError::Domain)?;
                let snapshot_json = serde_json::to_string(&snapshot)?;
                let snapshot_hash = canonical_hash(&snapshot)?;
                let snapshot_id = format!("snap-{snapshot_hash}");
                transaction.execute(
                    "INSERT OR IGNORE INTO snapshots(id, schema_version, canonical_version, document_json, hash)
                     VALUES (?1, 2, 1, ?2, ?3)",
                    params![snapshot_id, snapshot_json, snapshot_hash],
                )?;
                Self::sync_snapshot_resource_owner(&transaction, &snapshot_id, &snapshot_json)?;
                transaction.execute(
                    "INSERT INTO commits(id, document_id, origin_branch_id, snapshot_id, message, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![native_id, document_id, origin_branch, snapshot_id, commit.message, commit.created_at],
                )?;
                created_commit_count = created_commit_count.saturating_add(1);
                commit_is_new.insert(commit.id.clone(), true);
            }

            for commit in &graph.commits {
                let native_id = commit_ids.get(&commit.id).ok_or_else(|| {
                    StorageError::Corrupt("Legacy commit identity is missing".into())
                })?;
                if !commit_is_new.get(&commit.id).copied().unwrap_or(false) {
                    continue;
                }
                let parent_id = match commit.parent_id.as_deref() {
                    Some(parent) => Some(
                        commit_ids
                            .get(parent)
                            .cloned()
                            .or(Self::lookup_legacy_identity(
                                &transaction,
                                namespace,
                                &document_id,
                                "commit",
                                parent,
                            )?)
                            .ok_or_else(|| {
                                StorageError::Validation(
                                    "A version parent is missing and has no prior identity mapping"
                                        .into(),
                                )
                            })?,
                    ),
                    None => None,
                };
                transaction.execute(
                    "INSERT INTO commit_links(commit_id, visible_parent_id) VALUES (?1, ?2)",
                    params![native_id, parent_id],
                )?;
            }

            for (branch, _content_hash, native_id) in branch_records.values() {
                let head_id = match branch.head_commit_id.as_deref() {
                    Some(head) => Some(
                        commit_ids
                            .get(head)
                            .cloned()
                            .or(Self::lookup_legacy_identity(
                                &transaction,
                                namespace,
                                &document_id,
                                "commit",
                                head,
                            )?)
                            .ok_or_else(|| {
                                StorageError::Validation("A version branch head is missing".into())
                            })?,
                    ),
                    None => None,
                };
                let existing_head: Option<Option<String>> = transaction
                    .query_row(
                        "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
                        params![native_id, document_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                match existing_head {
                    Some(Some(actual)) if actual == head_id.clone().unwrap_or_default() => {}
                    Some(None) if head_id.is_none() => {}
                    Some(_) => {
                        if !new_branch_ids.contains(native_id) {
                            return Err(StorageError::Conflict(
                                "Mapped legacy branch head differs from its recorded identity"
                                    .into(),
                            ));
                        }
                        transaction.execute(
                            "UPDATE branches SET head_commit_id = ?1 WHERE id = ?2 AND document_id = ?3",
                            params![head_id, native_id, document_id],
                        )?;
                    }
                    None => {
                        return Err(StorageError::Corrupt("Imported branch disappeared".into()))
                    }
                }
            }
            let unknown_accepted = accepted_updates
                .difference(&identity_context.used_updates)
                .next()
                .is_some();
            if unknown_accepted {
                return Err(StorageError::Validation(
                    "An accepted identity update does not match a detected conflict".into(),
                ));
            }
        } else if !accepted_updates.is_empty() {
            return Err(StorageError::Validation(
                "Identity updates were accepted without a version graph".into(),
            ));
        }

        let next_revision = revision
            .checked_add(1)
            .ok_or_else(|| StorageError::Validation("Document revision overflow".into()))?;
        let mut next_draft = request
            .current_draft
            .as_ref()
            .unwrap_or(&durable_draft)
            .clone();
        if request.current_draft.is_some()
            && resources::normalize_legacy_avatar(&transaction, &mut next_draft)?
        {
            migrated_avatar_count = migrated_avatar_count.saturating_add(1);
        }
        let next_draft_json = serde_json::to_string(&next_draft)?;
        let next_draft_hash = canonical_hash(&next_draft)?;
        transaction.execute(
            "UPDATE documents SET revision = ?1 WHERE id = ?2 AND revision = ?3",
            params![next_revision, document_id, revision],
        )?;
        transaction.execute(
            "UPDATE drafts SET revision = ?1, document_json = ?2, hash = ?3,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE document_id = ?4 AND context_id = ?5 AND branch_id = ?6",
            params![
                next_revision,
                next_draft_json,
                next_draft_hash,
                document_id,
                context_id,
                current_branch_id
            ],
        )?;
        Self::sync_draft_resource_owner(
            &transaction,
            &document_id,
            &context_id,
            &current_branch_id,
            &next_draft_json,
        )?;

        for preference in &request.preferences {
            transaction.execute(
                "INSERT INTO settings(key, value, updated_at) VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![preference.key, preference.value],
            )?;
        }
        let mut template_count = 0u32;
        let mut migrated_template_preview_count = 0u32;
        if let Some(templates) = request.templates.as_ref() {
            let expected_revision = templates.expected_revision.parse::<i64>().map_err(|_| {
                StorageError::Validation("Migrated template catalog revision is invalid".into())
            })?;
            let current_revision: i64 = transaction
                .query_row(
                    "SELECT revision FROM imported_template_catalog WHERE id = 1",
                    [],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(0);
            if current_revision != expected_revision {
                return Err(StorageError::Conflict(
                    "Template catalog changed in another window".into(),
                ));
            }
            let normalized =
                resources::normalize_catalog_for_storage(&transaction, &templates.catalog_json)?;
            migrated_template_preview_count = resources::transferred_legacy_template_previews(
                &transaction,
                &request.inspection.sources,
                &normalized,
            )?;
            let next_revision = expected_revision.checked_add(1).ok_or_else(|| {
                StorageError::Validation("Template catalog revision overflow".into())
            })?;
            transaction.execute(
                "INSERT INTO imported_template_catalog(id, payload_json, revision, updated_at)
                 VALUES (1, ?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 ON CONFLICT(id) DO UPDATE SET
                   payload_json = excluded.payload_json,
                   revision = excluded.revision,
                   updated_at = excluded.updated_at",
                params![normalized, next_revision],
            )?;
            template_count =
                serde_json::from_str::<Vec<serde_json::Value>>(&templates.catalog_json)
                    .map(|catalog| catalog.len() as u32)
                    .unwrap_or(0);
        }

        let identity_counts = legacy_identity::commit(
            &transaction,
            namespace,
            &request.inspection.sources,
            &request.cursor,
        )?;
        let mut remaining_categories = vec![
            "templates".to_string(),
            "preferences".to_string(),
            "accounts".to_string(),
            "provider-secrets".to_string(),
            "agent-sessions".to_string(),
            "assets".to_string(),
        ];
        if !request.preferences.is_empty() {
            remaining_categories.retain(|category| category != "preferences");
        }
        if request.templates.is_some() {
            remaining_categories.retain(|category| category != "templates");
        }
        // Close only after every inventoried image has its exact bytes and
        // retained owner in this transaction; missing/conflicting assets remain.
        if report.totals.avatar_assets_missing == 0
            && report.totals.template_assets_missing == 0
            && migrated_template_preview_count >= report.totals.template_assets_present
            && migrated_avatar_count >= report.totals.avatar_assets_present
        {
            remaining_categories.retain(|category| category != "assets");
        }
        if identity_counts.accounts > 0 && report.totals.damaged_account_records == 0 {
            remaining_categories.retain(|category| category != "accounts");
        }
        if identity_counts.sessions > 0 {
            remaining_categories.retain(|category| category != "agent-sessions");
        }
        if report.totals.unknown_items > 0 {
            remaining_categories.push("unknown-items".to_string());
        }
        let receipt_cursor = AuthorityCursor {
            document_id: document_id.clone(),
            context_id: context_id.clone(),
            revision: next_revision.to_string(),
            branch_id: current_branch_id.clone(),
            head_id: current_head,
        };
        let receipt = LegacyMigrationCommitReceipt {
            batch_key: batch_key.clone(),
            namespace: namespace.into(),
            cursor: receipt_cursor,
            current_draft_applied: request.current_draft.is_some(),
            version_branch_count: created_branch_count,
            version_commit_count: created_commit_count,
            identity_mapping_count: created_mapping_count,
            preference_count: request.preferences.len() as u32,
            template_count,
            account_count: identity_counts.accounts,
            provider_count: identity_counts.providers,
            session_count: identity_counts.sessions,
            secret_reentry_count: identity_counts.secret_reentry,
            completion_status: "partial".into(),
            remaining_categories,
            idempotent_replay: false,
        };
        transaction.execute(
            "INSERT INTO legacy_migration_batches(batch_key, command_id, actor, request_hash, receipt_json)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![batch_key, request.command_id, actor, request_hash, serde_json::to_string(&receipt)?],
        )?;
        transaction.execute(
            "INSERT INTO legacy_migration_commands(command_id, batch_key, actor, request_hash)
             VALUES (?1, ?2, ?3, ?4)",
            params![request.command_id, batch_key, actor, request_hash],
        )?;
        #[cfg(feature = "test-hooks")]
        publication_test_hook("MIGRATION", "before-commit")?;
        transaction.commit()?;
        #[cfg(feature = "test-hooks")]
        publication_test_hook("MIGRATION", "after-commit")?;
        Ok(receipt)
    }
}
