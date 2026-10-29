//! Host-verified export provenance; no export bytes or filesystem paths persist.
use crate::{AuthorityCursor, ExportResult};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrozenExportSource {
    pub document_title: String,
    pub branch_name: String,
    pub template_id: String,
    pub template_revision: String,
    pub template_source_sha256: String,
    pub frozen_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum ExportFileFormat {
    Pdf,
    Png,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportArtifact {
    pub artifact_id: String,
    pub format: ExportFileFormat,
    /// None = PDF, 0 = long PNG, positive = original document page.
    pub page: Option<u32>,
    pub bytes: usize,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct NativeExportResult {
    #[serde(flatten)]
    #[ts(flatten)]
    pub export: ExportResult,
    pub export_id: String,
    pub source: FrozenExportSource,
    pub artifacts: Vec<ExportArtifact>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportReceipt {
    pub id: String,
    pub export_id: String,
    pub cursor: AuthorityCursor,
    pub render_key: String,
    pub source: FrozenExportSource,
    pub artifact: ExportArtifact,
    pub written_at: String,
    pub filename: String,
    /// Original frozen document page count; PDF page subsets are explicit below.
    pub source_page_count: u32,
    pub selected_pages: Option<Vec<u32>>,
    pub dpi: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportWriteOutcome {
    pub bytes: usize,
    pub sha256: String,
    pub receipt: Option<ExportReceipt>,
    /// A file can be verified on disk while its database receipt fails to commit.
    pub recording_error: Option<String>,
}
