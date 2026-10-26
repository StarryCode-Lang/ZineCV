use super::{
    build_manifest, host_resources, material, render_key, validate_descriptors, worker_loop,
    HostMessage, RenderFormat, RenderManifest, ResourceDescriptor, ResourceMaterial, ResourceRole,
    WorkerMessage, ENGINE_VERSION, PROTOCOL_VERSION, REFERENCE_DATE, RESOURCE_VERSION,
};
use crate::domain::{default_resume_document, AuthorityCursor};

#[test]
fn export_key_binds_product_normalized_selection_and_dpi() {
    use crate::domain::ExportProduct;
    let mut manifest = test_manifest(7);
    manifest.format = RenderFormat::Export;
    let default_key = super::manifest_render_key(&manifest).unwrap();
    manifest.dpi = Some(192);
    manifest.product = Some(ExportProduct::Bundle);
    assert_eq!(super::manifest_render_key(&manifest).unwrap(), default_key);
    manifest.dpi = Some(300);
    assert_ne!(super::manifest_render_key(&manifest).unwrap(), default_key);
    manifest.dpi = None;
    manifest.product = Some(ExportProduct::Pdf);
    let pdf_key = super::manifest_render_key(&manifest).unwrap();
    assert_ne!(pdf_key, default_key);
    manifest.selected_pages = Some(vec![2, 1, 2]);
    let selected_key = super::manifest_render_key(&manifest).unwrap();
    assert_ne!(selected_key, pdf_key);
    manifest.selected_pages = Some(vec![1, 2]);
    assert_eq!(super::manifest_render_key(&manifest).unwrap(), selected_key);
    manifest.selected_pages = Some(vec![1]);
    assert_ne!(super::manifest_render_key(&manifest).unwrap(), selected_key);
}

#[test]
fn worker_rejects_export_dpi_before_requesting_resources() {
    for dpi in [71, 301] {
        let mut manifest = test_manifest(7);
        manifest.format = RenderFormat::Export;
        manifest.dpi = Some(dpi);
        manifest.render_key = super::manifest_render_key(&manifest).unwrap();
        let mut input = Vec::new();
        append_message(
            &mut input,
            &HostMessage::Render {
                manifest: Box::new(manifest),
            },
        );
        let mut output = Vec::new();
        worker_loop(input.as_slice(), &mut output, 7).unwrap();
        let mut reader = Cursor::new(output);
        let _hello: WorkerMessage = super::read_message(&mut reader).unwrap();
        assert!(
            matches!(super::read_message::<WorkerMessage>(&mut reader).unwrap(), WorkerMessage::Failed { code, message, .. } if code == "invalidManifest" && message.contains("DPI"))
        );
        assert_eq!(reader.position() as usize, reader.get_ref().len());
    }
}
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use std::io::Cursor;
use typst::foundations::Bytes;

fn test_cursor(document_id: &str) -> AuthorityCursor {
    AuthorityCursor {
        document_id: document_id.to_owned(),
        context_id: "context-test".into(),
        revision: "r1".into(),
        branch_id: "main-test".into(),
        head_id: None,
    }
}

#[test]
fn test_deadline_override_is_bounded_and_absent_from_production() {
    assert_eq!(super::RENDER_TIMEOUT, std::time::Duration::from_secs(90));
    for candidate in [
        None,
        Some("0"),
        Some("1"),
        Some("2999"),
        Some("3001"),
        Some("90000"),
        Some(" 3000"),
        Some("3000ms"),
    ] {
        assert_eq!(
            super::configured_render_timeout(RenderFormat::Pdf, candidate).as_secs(),
            90
        );
    }
    let expected_ms = if cfg!(feature = "test-hooks") {
        3000
    } else {
        90_000
    };
    assert_eq!(
        super::configured_render_timeout(RenderFormat::Pdf, Some("3000")).as_millis(),
        expected_ms
    );
    assert_eq!(
        super::configured_render_timeout(RenderFormat::Fit, Some("3000")).as_secs(),
        10
    );
    for format in [RenderFormat::Preview, RenderFormat::Export] {
        assert_eq!(
            super::configured_render_timeout(format, Some("3000")).as_secs(),
            90
        );
    }
}

#[test]
fn fit_has_a_separate_key_deadline_and_zero_attempt_envelope() {
    let manifest = test_manifest(7);
    let mut fit = manifest.clone();
    fit.format = RenderFormat::Fit;
    assert_ne!(
        super::manifest_render_key(&fit).unwrap(),
        manifest.render_key
    );
    fit.format = RenderFormat::Preview;
    let preview_key = super::manifest_render_key(&fit).unwrap();
    fit.format = RenderFormat::Fit;
    assert_ne!(super::manifest_render_key(&fit).unwrap(), preview_key);
    assert_eq!(super::render_timeout(RenderFormat::Fit).as_secs(), 10);
    assert_eq!(super::render_timeout(RenderFormat::Pdf).as_secs(), 90);
    assert!(super::valid_output_page_count(RenderFormat::Fit, 0));
    assert!(!super::valid_output_page_count(RenderFormat::Pdf, 0));
    assert!(!super::valid_output_page_count(RenderFormat::Preview, 0));
    assert!(!super::valid_output_page_count(RenderFormat::Fit, 201));
}

fn descriptors() -> Vec<ResourceDescriptor> {
    vec![
        ResourceDescriptor {
            role: ResourceRole::BodyFontRegular,
            hash: "a".repeat(64),
            size_bytes: 1,
            mime: "font/otf".into(),
        },
        ResourceDescriptor {
            role: ResourceRole::BodyFontHeavy,
            hash: "b".repeat(64),
            size_bytes: 1,
            mime: "font/ttf".into(),
        },
        ResourceDescriptor {
            role: ResourceRole::IconFont,
            hash: "c".repeat(64),
            size_bytes: 1,
            mime: "font/ttf".into(),
        },
    ]
}

fn fake_resources() -> Vec<ResourceMaterial> {
    vec![
        material(
            ResourceRole::BodyFontRegular,
            "font/otf",
            Bytes::new(vec![1]),
        ),
        material(ResourceRole::BodyFontHeavy, "font/ttf", Bytes::new(vec![2])),
        material(ResourceRole::IconFont, "font/ttf", Bytes::new(vec![3])),
    ]
}

/// 轻量化证据：内置字体材料按进程只缓存一份（含 SHA-256 身份哈希），
/// 重复构造只克隆 `Bytes` 的引用计数；指针相同即证明没有再复制
/// ~22MB 字体数据，也没有重复计算 22MB 的哈希。
#[test]
fn bundled_font_materials_are_cached_not_recopied() {
    let first = host_resources("legacy-font:宋体", None).expect("bundled resources");
    let second = host_resources("legacy-font:宋体", None).expect("bundled resources");
    let expected = if crate::engine::system_fonts::installed().is_some() {
        5
    } else {
        3
    };
    assert_eq!(first.len(), expected);
    assert_eq!(second.len(), expected);
    for (left, right) in first.iter().zip(second.iter()) {
        assert_eq!(left.role, right.role);
        assert_eq!(left.hash, right.hash, "identity hash must stay stable");
        assert_eq!(
            left.bytes.as_slice().as_ptr(),
            right.bytes.as_slice().as_ptr(),
            "font materials must share one cached buffer"
        );
    }
}

fn test_manifest(generation: u64) -> RenderManifest {
    build_manifest(
        test_cursor("doc-test"),
        default_resume_document("doc-test").unwrap(),
        &fake_resources(),
        generation,
        17,
        RenderFormat::Pdf,
        None,
        None,
        None,
    )
    .unwrap()
}

fn append_message(input: &mut Vec<u8>, message: &impl serde::Serialize) {
    input.extend(serde_json::to_vec(message).unwrap());
    input.push(b'\n');
}

#[test]
fn render_key_binds_authoritative_cursor_document_date_format_and_resource_hashes() {
    let document = default_resume_document("doc-test").unwrap();
    let cursor = test_cursor("doc-test");
    let resources = descriptors();
    let base = render_key(
        &cursor,
        &document,
        REFERENCE_DATE,
        RenderFormat::Pdf,
        &resources,
    )
    .unwrap();
    assert_eq!(
        base,
        render_key(
            &cursor,
            &document,
            REFERENCE_DATE,
            RenderFormat::Pdf,
            &resources
        )
        .unwrap()
    );
    let mut changed = cursor.clone();
    changed.revision = "r2".into();
    assert_ne!(
        base,
        render_key(
            &changed,
            &document,
            REFERENCE_DATE,
            RenderFormat::Pdf,
            &resources
        )
        .unwrap()
    );
    assert_ne!(
        base,
        render_key(
            &cursor,
            &document,
            "2026-09-29",
            RenderFormat::Pdf,
            &resources
        )
        .unwrap()
    );
    let mut changed_resources = resources.clone();
    changed_resources[0].hash = "d".repeat(64);
    assert_ne!(
        base,
        render_key(
            &cursor,
            &document,
            REFERENCE_DATE,
            RenderFormat::Pdf,
            &changed_resources
        )
        .unwrap()
    );
}

#[test]
fn resource_manifest_rejects_missing_duplicate_and_oversized_resources() {
    let mut resources = descriptors();
    assert!(validate_descriptors(&resources, false).is_ok());
    resources.pop();
    assert!(validate_descriptors(&resources, false).is_err());
    resources = descriptors();
    resources.push(resources[0].clone());
    assert!(validate_descriptors(&resources, false).is_err());
    resources = descriptors();
    resources[0].size_bytes = usize::MAX;
    assert!(validate_descriptors(&resources, false).is_err());
}

#[test]
fn worker_rejects_stale_generation_and_invalid_render_key() {
    let mut input = Vec::new();
    append_message(
        &mut input,
        &HostMessage::Render {
            manifest: Box::new(test_manifest(1)),
        },
    );
    let mut output = Vec::new();
    worker_loop(input.as_slice(), &mut output, 2).unwrap();
    let mut reader = Cursor::new(output);
    assert!(matches!(
        super::read_message::<WorkerMessage>(&mut reader).unwrap(),
        WorkerMessage::Hello { generation: 2, .. }
    ));
    assert!(matches!(
        super::read_message::<WorkerMessage>(&mut reader).unwrap(),
        WorkerMessage::Failed { code, .. } if code == "invalidManifest"
    ));

    let mut manifest = test_manifest(2);
    manifest.render_key = "0".repeat(64);
    let mut input = Vec::new();
    append_message(
        &mut input,
        &HostMessage::Render {
            manifest: Box::new(manifest),
        },
    );
    let mut output = Vec::new();
    worker_loop(input.as_slice(), &mut output, 2).unwrap();
    let mut reader = Cursor::new(output);
    let _hello: WorkerMessage = super::read_message(&mut reader).unwrap();
    assert!(matches!(
        super::read_message::<WorkerMessage>(&mut reader).unwrap(),
        WorkerMessage::Failed { code, .. } if code == "invalidManifest"
    ));
}

#[test]
fn worker_rejects_corrupted_resource_bytes_before_typst_compile() {
    let resources = fake_resources();
    let manifest = build_manifest(
        test_cursor("doc-test"),
        default_resume_document("doc-test").unwrap(),
        &resources,
        3,
        18,
        RenderFormat::Pdf,
        None,
        None,
        None,
    )
    .unwrap();
    let descriptor = manifest
        .resources
        .iter()
        .find(|item| item.role == ResourceRole::BodyFontRegular)
        .unwrap()
        .clone();
    let mut input = Vec::new();
    append_message(
        &mut input,
        &HostMessage::Render {
            manifest: Box::new(manifest),
        },
    );
    append_message(
        &mut input,
        &HostMessage::ResourceBytes {
            request_id: 18,
            generation: 3,
            role: descriptor.role,
            hash: descriptor.hash.clone(),
            size_bytes: descriptor.size_bytes,
            mime: descriptor.mime.clone(),
            data_base64: BASE64.encode([9_u8]),
        },
    );
    let mut output = Vec::new();
    worker_loop(input.as_slice(), &mut output, 3).unwrap();
    let mut reader = Cursor::new(output);
    let _hello: WorkerMessage = super::read_message(&mut reader).unwrap();
    assert!(matches!(
        super::read_message::<WorkerMessage>(&mut reader).unwrap(),
        WorkerMessage::ResourceRequest {
            generation: 3,
            request_id: 18,
            ..
        }
    ));
    assert!(matches!(
        super::read_message::<WorkerMessage>(&mut reader).unwrap(),
        WorkerMessage::Failed { code, .. } if code == "resourceHashMismatch"
    ));
}

#[test]
fn worker_version_contract_is_explicit() {
    assert_eq!(PROTOCOL_VERSION, 1);
    assert_eq!(RESOURCE_VERSION, 1);
    assert_eq!(ENGINE_VERSION, "zinecv-typst-0.15.1-engine-2");
    assert!(super::validate_reference_date("２０２６-09-28").is_err());
    assert!(super::validate_reference_date("2026-02-30").is_err());
}

#[test]
fn preview_format_cannot_reuse_a_pdf_manifest_key() {
    let mut manifest = test_manifest(7);
    let pdf_key = manifest.render_key.clone();
    manifest.format = RenderFormat::Preview;
    let preview_key = super::manifest_render_key(&manifest).unwrap();
    assert_ne!(preview_key, pdf_key);
    let mut input = Vec::new();
    append_message(
        &mut input,
        &HostMessage::Render {
            manifest: Box::new(manifest),
        },
    );
    let mut output = Vec::new();
    worker_loop(input.as_slice(), &mut output, 7).unwrap();
    let mut reader = Cursor::new(output);
    let _hello: WorkerMessage = super::read_message(&mut reader).unwrap();
    assert!(
        matches!(super::read_message::<WorkerMessage>(&mut reader).unwrap(),
            WorkerMessage::Failed { code, .. } if code == "invalidManifest")
    );
}
