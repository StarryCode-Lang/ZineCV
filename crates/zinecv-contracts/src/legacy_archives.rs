//! User-facing recovery view of unresolved legacy per-box edit archives.
//! These are raw byte restorations, not rebuilt layouts: the archive keeps the
//! original text content while the original template identity is unknown.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Recovery record: `key` is the original browser storage key, e.g.
/// `resume-diy-imported-text-v1:imported-…`; `raw` is the original JSON text,
/// retaining empty values, unknown fields and key order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct LegacyEditArchive {
    pub key: String,
    pub raw: String,
}
