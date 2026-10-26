use super::*;

pub type Id = String;
pub type Revision = String;
pub type Sha256 = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum ModuleKind {
    Education,
    Skills,
    Work,
    Projects,
    Orgs,
    Research,
    Awards,
    Other,
    Portfolio,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum AgeMode {
    Age,
    Birthday,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum InlineMark {
    Bold,
    Italic,
    Underline,
    Strike,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Inline {
    Text {
        text: String,
        marks: Vec<InlineMark>,
    },
    Link {
        href: String,
        children: Vec<Inline>,
    },
    Break,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RichBlock {
    Paragraph {
        children: Vec<Inline>,
    },
    List {
        ordered: bool,
        start: Option<u32>,
        items: Vec<Vec<RichBlock>>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: Id,
    pub title: String,
    pub role: String,
    pub department: String,
    pub city: String,
    pub start: String,
    pub end: String,
    pub college: Option<String>,
    pub mode: Option<String>,
    pub body: Vec<RichBlock>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct EntrySection {
    pub id: Id,
    pub kind: ModuleKind,
    pub title: String,
    pub visible: bool,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct SummarySection {
    pub id: Id,
    pub kind: String,
    pub title: String,
    pub visible: bool,
    pub body: Vec<RichBlock>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(untagged)]
pub enum Section {
    Entry(EntrySection),
    Summary(SummarySection),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct BasicInfo {
    pub name: String,
    pub phone: String,
    pub email: String,
    pub city: String,
    pub wechat: String,
    pub birth: String,
    pub age_mode: AgeMode,
    pub website: Option<String>,
    pub linkedin: Option<String>,
    pub gender: Option<String>,
    pub height: Option<String>,
    pub weight: Option<String>,
    pub ethnicity: Option<String>,
    pub birthplace: Option<String>,
    pub political_status: Option<String>,
    pub marital_status: Option<String>,
    pub zodiac: Option<String>,
    pub mbti: Option<String>,
    pub avatar_asset_id: Option<Id>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum Density {
    Comfortable,
    Standard,
    Compact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
pub enum DateFormat {
    #[serde(rename = "2021年1月")]
    Chinese,
    #[serde(rename = "2021.01")]
    Dotted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
pub enum TitleFormat {
    #[serde(rename = "双行标题")]
    DoubleLine,
    #[serde(rename = "单行标题")]
    SingleLine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
pub enum Separator {
    #[serde(rename = "使用分隔符号")]
    Enabled,
    #[serde(rename = "不使用分隔符号")]
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
pub enum TextAlign {
    #[serde(rename = "系统默认")]
    Default,
    #[serde(rename = "两端对齐")]
    Justify,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct Presentation {
    pub template_id: Id,
    pub template_revision: Id,
    pub density: Density,
    pub font_set_id: Id,
    pub font_size_pt: f32,
    pub line_height_pt: f32,
    pub module_gap_pt: f32,
    pub page_margin_pt: f32,
    pub heading_size_pt: f32,
    pub paragraph_gap_pt: f32,
    pub list_gap_pt: f32,
    pub theme: String,
    pub date_format: DateFormat,
    pub title_format: TitleFormat,
    pub separator: Separator,
    pub text_align: TextAlign,
    #[ts(type = "Record<string, string | number>")]
    pub legacy_overrides: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ResumeDocument {
    #[ts(type = "2")]
    pub schema_version: u8,
    pub document_id: Id,
    pub title: String,
    pub basic: BasicInfo,
    pub sections: Vec<Section>,
    pub presentation: Presentation,
    pub source_ref: Option<SourceRef>,
    #[ts(type = "Record<string, unknown>")]
    pub legacy_extensions: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    pub import_id: Id,
    pub preview_asset_id: Option<Id>,
}

/// 规范化 JSON 序列化后的 SHA-256：命令幂等键、快照哈希与 CAS 的统一基础。
pub fn canonical_hash<T: Serialize>(value: &T) -> Result<Sha256, AppError> {
    let bytes = serde_json::to_vec(value).map_err(|_| {
        AppError::new(
            ErrorCode::Validation,
            "Value cannot be canonicalized",
            false,
        )
    })?;
    Ok(format!("{:x}", Sha256Hasher::digest(bytes)))
}
