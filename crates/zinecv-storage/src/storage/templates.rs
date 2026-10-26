use super::*;

impl Store {
    /// 工作区偏好读取（B08）；值缺失返回 None。
    pub fn read_setting(&self, key: &str) -> StorageResult<Option<String>> {
        Ok(self
            .connection
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()?)
    }

    /// Imported templates can contain an image preview larger than the generic setting limit.
    /// A missing row means this profile has not yet imported its old browser catalog.
    pub fn read_imported_template_catalog(&self) -> StorageResult<Option<ImportedTemplateCatalog>> {
        let stored: Option<(i64, String)> = self
            .connection
            .query_row(
                "SELECT revision, payload_json FROM imported_template_catalog WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        stored
            .map(|(revision, payload_json)| {
                Ok(ImportedTemplateCatalog {
                    revision,
                    payload_json: resources::catalog_with_revision_metadata(
                        &self.connection,
                        &payload_json,
                    )?,
                })
            })
            .transpose()
    }

    pub fn contains_imported_template(&self, source_id: &str) -> StorageResult<bool> {
        let Some(catalog) = self.read_imported_template_catalog()? else {
            return Ok(false);
        };
        let value: serde_json::Value = serde_json::from_str(&catalog.payload_json)?;
        let Some(items) = value.as_array() else {
            return Err(StorageError::Corrupt(
                "Imported template catalog is not an array".into(),
            ));
        };
        Ok(items
            .iter()
            .any(|item| item.get("id").and_then(serde_json::Value::as_str) == Some(source_id)))
    }

    pub fn write_imported_template_catalog(
        &mut self,
        payload_json: &str,
        expected_revision: i64,
    ) -> StorageResult<i64> {
        let value: serde_json::Value = serde_json::from_str(payload_json)?;
        if !value.is_array() {
            return Err(StorageError::Validation(
                "Template catalog must be an array".into(),
            ));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let actual: Option<i64> = transaction
            .query_row(
                "SELECT revision FROM imported_template_catalog WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if actual.unwrap_or(0) != expected_revision {
            return Err(StorageError::Conflict(
                "Template catalog changed in another window".into(),
            ));
        }
        let revision = expected_revision
            .checked_add(1)
            .ok_or_else(|| StorageError::Validation("Template catalog revision overflow".into()))?;
        let normalized_payload =
            resources::normalize_catalog_for_storage(&transaction, payload_json)?;
        transaction.execute(
            "INSERT INTO imported_template_catalog(id, payload_json, revision, updated_at)
             VALUES (1, ?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             ON CONFLICT(id) DO UPDATE SET
               payload_json = excluded.payload_json,
               revision = excluded.revision,
               updated_at = excluded.updated_at",
            params![normalized_payload, revision],
        )?;
        transaction.commit()?;
        Ok(revision)
    }

    pub fn list_template_activity(&self) -> StorageResult<Vec<TemplateActivity>> {
        let mut statement = self.connection.prepare(
            "SELECT template_id, favorite, last_used_at FROM template_activity ORDER BY template_id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(TemplateActivity {
                    template_id: row.get(0)?,
                    favorite: row.get::<_, i64>(1)? == 1,
                    last_used_at: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Import old WebView activity once. The marker and rows commit together.
    pub fn bootstrap_template_activity(
        &mut self,
        legacy_json: &str,
    ) -> StorageResult<Vec<TemplateActivity>> {
        let legacy: serde_json::Value = serde_json::from_str(legacy_json)?;
        let entries = legacy.as_object().ok_or_else(|| {
            StorageError::Validation("Legacy template activity must be an object".into())
        })?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let migrated: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE key = 'template-activity-migrated-v1')",
            [],
            |row| row.get(0),
        )?;
        if !migrated {
            for (id, activity) in entries {
                if id.trim().is_empty() || id.len() > 256 {
                    return Err(StorageError::Validation(
                        "Invalid template activity ID".into(),
                    ));
                }
                let favorite = activity
                    .get("favorite")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let last_used_at = activity
                    .get("lastUsedAt")
                    .and_then(serde_json::Value::as_i64)
                    .filter(|value| *value > 0);
                transaction.execute(
                    "INSERT INTO template_activity(template_id, favorite, last_used_at) VALUES (?1, ?2, ?3)
                     ON CONFLICT(template_id) DO NOTHING",
                    params![id, favorite, last_used_at],
                )?;
            }
            transaction.execute(
                "INSERT INTO settings(key, value) VALUES ('template-activity-migrated-v1', '1')",
                [],
            )?;
        }
        transaction.commit()?;
        self.list_template_activity()
    }

    pub fn update_template_activity(
        &mut self,
        id: &str,
        action: &str,
    ) -> StorageResult<Option<TemplateActivity>> {
        if id.trim().is_empty() || id.len() > 256 {
            return Err(StorageError::Validation(
                "Invalid template activity ID".into(),
            ));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        match action {
            "favorite" => {
                transaction.execute(
                    "INSERT INTO template_activity(template_id, favorite) VALUES (?1, 1)
                     ON CONFLICT(template_id) DO UPDATE SET favorite = 1 - template_activity.favorite",
                    [id],
                )?;
            }
            "use" => {
                let now = crate::clock::SystemTime::now()
                    .duration_since(crate::clock::UNIX_EPOCH)
                    .map_err(|error| StorageError::Validation(error.to_string()))?
                    .as_millis();
                let now = i64::try_from(now)
                    .map_err(|_| StorageError::Validation("Clock overflow".into()))?;
                transaction.execute(
                    "INSERT INTO template_activity(template_id, favorite, last_used_at) VALUES (?1, 0, ?2)
                     ON CONFLICT(template_id) DO UPDATE SET last_used_at = excluded.last_used_at",
                    params![id, now],
                )?;
            }
            "remove" => {
                transaction
                    .execute("DELETE FROM template_activity WHERE template_id = ?1", [id])?;
            }
            _ => {
                return Err(StorageError::Validation(
                    "Unknown template activity action".into(),
                ))
            }
        }
        let result = transaction.query_row(
            "SELECT template_id, favorite, last_used_at FROM template_activity WHERE template_id = ?1",
            [id],
            |row| Ok(TemplateActivity {
                template_id: row.get(0)?,
                favorite: row.get::<_, i64>(1)? == 1,
                last_used_at: row.get(2)?,
            }),
        ).optional()?;
        transaction.commit()?;
        Ok(result)
    }
}
