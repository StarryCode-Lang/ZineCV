//! M2 岗位材料契约（设计稿 docs/drafts/m2-contract-design.md §2.3；M2 建契约与表，M4 消费）。
//!
//! 修订保留：每次 upsert 向 job_material_revisions 插入新行，不覆盖；
//! 链接记录 job_material_revision，M4 的"材料过期提示"以修订号比较实现。
//! 不向岗位材料复制简历内容（计划 §8）。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::commands::AuthorityCursor;
use crate::document::Id;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobMaterial {
    pub id: Id,
    pub document_id: Id,
    pub title: String,
    pub company: String,
    pub job_description: String,
    pub source_note: String,
    pub revision: u32,
    pub created_at: String,
    pub updated_at: String,
}

/// None = 新建（id 由宿主派生，document_id 归属）；Some = 更新（id + revision 必须匹配最新，
/// 且 document_id 必须与既有材料一致）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpsertJobMaterialRequest {
    pub command_id: Id,
    pub document_id: Id,
    pub expected_epoch: u64,
    pub job_material: Option<JobMaterial>,
    pub title: String,
    pub company: String,
    pub job_description: String,
    pub source_note: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentJobLink {
    pub id: Id,
    pub document_id: Id,
    pub job_material_id: Id,
    pub job_material_revision: u32,
    pub branch_id: Id,
    pub created_at: String,
}

/// 绑定目标文档当前状态；宿主校验 active。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkJobMaterialRequest {
    pub command_id: Id,
    pub cursor: AuthorityCursor,
    pub job_material_id: Id,
    pub job_material_revision: u32,
    pub branch_id: Id,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteJobMaterialRequest {
    pub command_id: Id,
    pub document_id: Id,
    pub expected_epoch: u64,
    pub job_material_id: Id,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnlinkJobMaterialRequest {
    pub command_id: Id,
    pub document_id: Id,
    pub expected_epoch: u64,
    pub link_id: Id,
}

/// `revisions` contains only historical material versions referenced by links;
/// current versions are in `materials`. Every item belongs to this document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobMaterialListResult {
    pub materials: Vec<JobMaterial>,
    pub links: Vec<DocumentJobLink>,
    pub revisions: Vec<JobMaterial>,
}
