//! Browser facade. Business rules and engine rendering stay in the shared crates.
use wasm_bindgen::prelude::*;
use zinecv_contracts::{AppError, CommandEnvelope, ErrorCode, ResumeDocument};
use zinecv_domain::DocumentContext;

#[cfg(all(feature = "store", target_arch = "wasm32", target_os = "unknown"))]
mod dispatch;
#[cfg(all(feature = "store", target_arch = "wasm32", target_os = "unknown"))]
mod secrets;
#[cfg(all(feature = "store", target_arch = "wasm32", target_os = "unknown"))]
mod store;

#[cfg(all(feature = "agent", target_arch = "wasm32", target_os = "unknown"))]
mod agent;
#[cfg(all(
    feature = "agent",
    feature = "store",
    target_arch = "wasm32",
    target_os = "unknown"
))]
mod agent_host;

#[cfg(feature = "engine")]
#[wasm_bindgen]
pub fn fit(json: &str) -> Result<String, JsValue> {
    let document = document(json)?;
    DocumentContext::new(document.clone()).map_err(error)?;
    let plan = zinecv_engine::fit::solve_one_page(
        &document,
        None,
        &zinecv_engine::bundled_font_bytes(),
        zinecv_engine::DEFAULT_REFERENCE_DATE,
        || false,
    )
    .map_err(error)?;
    serde_json::to_string(&plan).map_err(|cause| {
        error(AppError::new(
            ErrorCode::Validation,
            cause.to_string(),
            false,
        ))
    })
}

#[cfg(feature = "engine")]
#[wasm_bindgen]
pub fn raster(json: &str, page: usize, scale: f32) -> Result<Vec<u8>, JsValue> {
    let document = document(json)?;
    DocumentContext::new(document.clone()).map_err(error)?;
    let paged = zinecv_engine::render_paged_with_resources(
        &document,
        None,
        &zinecv_engine::bundled_font_bytes(),
        zinecv_engine::DEFAULT_REFERENCE_DATE,
    )
    .map_err(error)?;
    zinecv_engine::render_paged_page_png(&paged, page, scale).map_err(error)
}

fn error(value: impl Into<AppError>) -> JsValue {
    JsValue::from_str(&serde_json::to_string(&value.into()).expect("serializable AppError"))
}

fn document(json: &str) -> Result<ResumeDocument, JsValue> {
    serde_json::from_str(json).map_err(|cause| {
        error(AppError::new(
            ErrorCode::Validation,
            cause.to_string(),
            false,
        ))
    })
}

#[wasm_bindgen]
pub fn default_document(document_id: &str) -> Result<String, JsValue> {
    let document = zinecv_domain::default_resume_document(document_id).map_err(error)?;
    Ok(serde_json::to_string(&document).expect("serializable document"))
}

#[wasm_bindgen]
pub struct DomainSession {
    context: DocumentContext,
}

#[wasm_bindgen]
impl DomainSession {
    #[wasm_bindgen(constructor)]
    pub fn new(json: &str) -> Result<DomainSession, JsValue> {
        Ok(Self {
            context: DocumentContext::new(document(json)?).map_err(error)?,
        })
    }

    pub fn snapshot(&self) -> String {
        serde_json::to_string(self.context.document()).expect("serializable document")
    }

    pub fn cursor(&self, context_id: &str) -> String {
        serde_json::to_string(&self.context.cursor(context_id)).expect("serializable cursor")
    }

    pub fn apply(&mut self, actor: &str, context_id: &str, json: &str) -> Result<String, JsValue> {
        let envelope: CommandEnvelope = serde_json::from_str(json).map_err(|cause| {
            error(AppError::new(
                ErrorCode::Validation,
                cause.to_string(),
                false,
            ))
        })?;
        let result = self
            .context
            .apply_command(actor, context_id, envelope)
            .map_err(error)?;
        Ok(serde_json::to_string(&result).expect("serializable command result"))
    }
}

/// POC: a Rust WASM call synchronously reaches the SQLite JS API and observes its
/// return value before continuing. A Promise is explicitly rejected.
#[wasm_bindgen]
pub fn sqlite_sync_probe(exec: &js_sys::Function, sql: &str) -> Result<JsValue, JsValue> {
    let value = exec.call1(&JsValue::NULL, &JsValue::from_str(sql))?;
    if value.is_instance_of::<js_sys::Promise>() {
        return Err(error(AppError::new(
            ErrorCode::Validation,
            "SQLite bridge must return synchronously",
            false,
        )));
    }
    Ok(value)
}

#[cfg(feature = "engine")]
#[wasm_bindgen]
pub fn preview(json: &str) -> Result<String, JsValue> {
    let document = document(json)?;
    DocumentContext::new(document.clone()).map_err(error)?;
    let preview = zinecv_engine::render_preview_with_resources(
        &document,
        None,
        &zinecv_engine::bundled_font_bytes(),
        zinecv_engine::DEFAULT_REFERENCE_DATE,
    )
    .map_err(error)?;
    Ok(serde_json::to_string(&preview).expect("serializable preview"))
}

#[cfg(feature = "engine")]
#[wasm_bindgen]
pub fn export_pdf(json: &str) -> Result<Vec<u8>, JsValue> {
    let document = document(json)?;
    DocumentContext::new(document.clone()).map_err(error)?;
    Ok(zinecv_engine::render_document_pdf_with_resources(
        &document,
        None,
        &zinecv_engine::bundled_font_bytes(),
        zinecv_engine::DEFAULT_REFERENCE_DATE,
    )
    .map_err(error)?
    .bytes)
}
