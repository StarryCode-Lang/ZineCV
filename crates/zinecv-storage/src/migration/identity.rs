use super::*;

pub fn stable_native_id(namespace: &str, entity_kind: &str, legacy_id: &str) -> String {
    let material = format!("{namespace}\0{entity_kind}\0{legacy_id}");
    format!("legacy-{}", sha256(material.as_bytes()))
}

pub fn identity_conflict_key(namespace: &str, entity_kind: &str, legacy_id: &str) -> String {
    let material = format!("{namespace}\0{entity_kind}\0{legacy_id}");
    sha256(material.as_bytes())
}

pub fn source_batch_key(report: &LegacyMigrationReport) -> Option<String> {
    let namespace = report.source_namespace.as_deref()?;
    let mut sources: Vec<(&str, &str)> = report
        .sources
        .iter()
        .map(|source| (source.source_id.as_str(), source.source_sha256.as_str()))
        .collect();
    sources.sort_unstable();
    let material = format!(
        "{IMPORTER_VERSION}\0{namespace}\0{}",
        sources
            .into_iter()
            .map(|(source_id, hash)| format!("{source_id}\0{hash}"))
            .collect::<Vec<_>>()
            .join("\0")
    );
    Some(sha256(material.as_bytes()))
}

pub fn expected_source_hashes_match(
    report: &LegacyMigrationReport,
    expected_source_hashes: &[LegacyMigrationExpectedHash],
) -> bool {
    let expected: HashMap<&str, &str> = expected_source_hashes
        .iter()
        .map(|item| (item.source_id.as_str(), item.source_sha256.as_str()))
        .collect();
    let actual: HashMap<&str, &str> = report
        .sources
        .iter()
        .map(|source| (source.source_id.as_str(), source.source_sha256.as_str()))
        .collect();
    expected.len() == expected_source_hashes.len()
        && expected == actual
        && report.sources.iter().all(|source| {
            expected.get(source.source_id.as_str()) == Some(&source.source_sha256.as_str())
        })
}

pub fn review_item_key(issue: &LegacyMigrationIssue) -> String {
    let material = format!("{}\0{}\0{}", issue.source_id, issue.code, issue.path);
    sha256(material.as_bytes())
}

pub fn required_review_item_keys(report: &LegacyMigrationReport) -> Vec<String> {
    let mut keys = report
        .issues
        .iter()
        .chain(
            report
                .sources
                .iter()
                .flat_map(|source| source.issues.iter()),
        )
        .filter(|issue| issue.severity == LegacyMigrationSeverity::Review)
        .map(review_item_key)
        .collect::<Vec<_>>();
    keys.sort_unstable();
    keys.dedup();
    keys
}

pub(super) fn stage_identity_mapping(
    namespace: &str,
    batch_key: &str,
    sources: &[LegacyMigrationSourceInput],
    documents: &[LegacyMigrationConvertedDocument],
) -> rusqlite::Result<(u32, u32)> {
    let connection = Connection::open_in_memory()?;
    connection.execute_batch(
        "CREATE TABLE legacy_entity_identity (
            namespace TEXT NOT NULL,
            entity_kind TEXT NOT NULL,
            legacy_id TEXT NOT NULL,
            batch_key TEXT NOT NULL,
            importer_version TEXT NOT NULL,
         PRIMARY KEY (namespace, entity_kind, legacy_id)
        );
        CREATE TABLE converted_document (
            namespace TEXT NOT NULL,
            entity_kind TEXT NOT NULL,
            legacy_id TEXT NOT NULL,
            source_sha256 TEXT NOT NULL,
            content_sha256 TEXT NOT NULL,
            document_json TEXT NOT NULL,
            PRIMARY KEY (namespace, entity_kind, legacy_id)
        );",
    )?;
    for source in sources {
        for entity in inspect_one(source).entities {
            connection.execute(
                "INSERT OR IGNORE INTO legacy_entity_identity
                    (namespace, entity_kind, legacy_id, batch_key, importer_version)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    namespace,
                    entity.kind,
                    entity.id,
                    batch_key,
                    IMPORTER_VERSION
                ],
            )?;
        }
    }
    for candidate in documents {
        let document_json = serde_json::to_string(&candidate.document)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        connection.execute(
            "INSERT INTO converted_document
                (namespace, entity_kind, legacy_id, source_sha256, content_sha256, document_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                namespace,
                match candidate.document_kind {
                    LegacyMigrationDocumentKind::CurrentDraft => "current_draft",
                    LegacyMigrationDocumentKind::VersionCommit => "version_commit",
                    LegacyMigrationDocumentKind::ImportedTemplate => "imported_template",
                },
                candidate.legacy_id,
                candidate.source_sha256,
                sha256(document_json.as_bytes()),
                document_json,
            ],
        )?;
    }
    let count = connection.query_row("SELECT COUNT(*) FROM legacy_entity_identity", [], |row| {
        row.get::<_, i64>(0)
    })?;
    let document_count =
        connection.query_row("SELECT COUNT(*) FROM converted_document", [], |row| {
            row.get::<_, i64>(0)
        })?;
    Ok((
        u32::try_from(count).unwrap_or(u32::MAX),
        u32::try_from(document_count).unwrap_or(u32::MAX),
    ))
}
