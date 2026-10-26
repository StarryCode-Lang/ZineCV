//! Read-only inspection and dry-run support for legacy JSON sources.
//!
//! Source strings are supplied by the UI after an explicit file selection. This
//! module never opens browser profiles, resolves source paths, or writes to the
//! active Store. Commit and receipt persistence are owned by the later R20 path.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use base64::Engine;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

const IMPORTER_VERSION: &str = "r19.1";
const MAX_SOURCE_BYTES: usize = 64 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES: usize = 128 * 1024 * 1024;
const MAX_SOURCE_COUNT: usize = 8;
const LEGACY_ORIGIN: &str = "http://127.0.0.1:5173";

const MODULE_KEYS: [&str; 10] = [
    "education",
    "skills",
    "work",
    "projects",
    "orgs",
    "research",
    "awards",
    "other",
    "portfolio",
    "custom",
];
const BASIC_KEYS: [&str; 19] = [
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
    "avatar",
];

// C+ P1b：全部 25 个导出契约类型已并入 crates/zinecv-contracts（serde 形状与
// ts-rs 绑定输出不变，`LegacyMigrationCounts::add_assign` 随迁并转 pub）；
// 此处再出口保持 `crate::migration::*` 既有引用路径不变。
pub use zinecv_contracts::{
    CommitLegacyMigrationRequest, DryRunLegacyMigrationRequest,
    InspectLegacyIdentityConflictsRequest, InspectLegacyMigrationRequest,
    LegacyMigrationCommitReceipt, LegacyMigrationConflict, LegacyMigrationConflictKind,
    LegacyMigrationConvertedDocument, LegacyMigrationCounts, LegacyMigrationDocumentKind,
    LegacyMigrationDryRun, LegacyMigrationExpectedHash, LegacyMigrationFieldEvidence,
    LegacyMigrationIdentityConflict, LegacyMigrationIssue, LegacyMigrationPreference,
    LegacyMigrationReport, LegacyMigrationSeverity, LegacyMigrationSourceInput,
    LegacyMigrationSourceKind, LegacyMigrationSourceReport, LegacyMigrationTemplates,
    LegacyMigrationVersionBranch, LegacyMigrationVersionCommit, LegacyMigrationVersionGraph,
};

#[derive(Debug, Clone)]
struct EntityFingerprint {
    source_id: String,
    kind: String,
    id: String,
    content_hash: String,
    name: Option<String>,
}

#[derive(Debug, Clone)]
struct InternalSourceResult {
    report: LegacyMigrationSourceReport,
    entities: Vec<EntityFingerprint>,
    version_store_hash: Option<String>,
}

#[cfg(test)]
#[path = "migration/tests.rs"]
mod tests;

#[path = "migration/common.rs"]
mod common;
use common::*;

#[path = "migration/identity.rs"]
mod identity;
use identity::*;
pub use identity::{
    expected_source_hashes_match, identity_conflict_key, required_review_item_keys,
    review_item_key, source_batch_key, stable_native_id,
};

#[path = "migration/resume.rs"]
mod resume;
use resume::*;

#[path = "migration/snapshots.rs"]
mod snapshots;
use snapshots::*;

#[path = "migration/versions.rs"]
mod versions;
use versions::*;

#[path = "migration/browser.rs"]
mod browser;
use browser::*;

#[path = "migration/accounts.rs"]
mod accounts;
pub use accounts::supported_image_bytes;
use accounts::*;

#[path = "migration/inspection.rs"]
mod inspection;
use inspection::*;
pub use inspection::{dry_run, inspect};
