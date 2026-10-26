#[cfg(feature = "test-hooks")]
use super::test_hooks_before_render;
use super::{worker_loop, HostMessage, RenderManifest, WorkerMessage};
use std::io::Cursor;
use std::time::{Duration, Instant};
use typst::foundations::Bytes;

fn append_message(input: &mut Vec<u8>, message: &impl serde::Serialize) {
    input.extend(serde_json::to_vec(message).unwrap());
    input.push(b'\n');
}

fn clear_hooks() {
    std::env::remove_var("ZINECV_TEST_WORKER_DELAY_MS");
    std::env::remove_var("ZINECV_TEST_WORKER_ALLOC_MB");
    std::env::remove_var("ZINECV_TEST_CRASH_MARKER");
}

fn hooks_cursor(document_id: &str) -> crate::domain::AuthorityCursor {
    crate::domain::AuthorityCursor {
        document_id: document_id.to_owned(),
        context_id: "context-hooks".into(),
        revision: "r1".into(),
        branch_id: "main-hooks".into(),
        head_id: None,
    }
}

#[test]
fn test_hooks_fire_before_render_in_worker_loop() {
    let manifest: RenderManifest = {
        let resources = vec![
            super::material(
                super::ResourceRole::BodyFontRegular,
                "font/otf",
                Bytes::new(vec![1]),
            ),
            super::material(
                super::ResourceRole::BodyFontHeavy,
                "font/ttf",
                Bytes::new(vec![2]),
            ),
            super::material(
                super::ResourceRole::IconFont,
                "font/ttf",
                Bytes::new(vec![3]),
            ),
        ];
        super::build_manifest(
            hooks_cursor("doc-render-hooks"),
            crate::domain::default_resume_document("doc-render-hooks").unwrap(),
            &resources,
            7,
            91,
            super::RenderFormat::Pdf,
            None,
            None,
            None,
        )
        .unwrap()
    };
    let message = HostMessage::Render {
        manifest: Box::new(manifest),
    };

    clear_hooks();
    let mut plain_input = Vec::new();
    append_message(&mut plain_input, &message);
    let mut plain_output = Vec::new();
    let plain_started = Instant::now();
    worker_loop(plain_input.as_slice(), &mut plain_output, 7).unwrap();
    assert!(
        plain_started.elapsed() < Duration::from_millis(400),
        "baseline loop should be fast"
    );

    std::env::set_var("ZINECV_TEST_WORKER_DELAY_MS", "500");
    let mut delayed_input = Vec::new();
    append_message(&mut delayed_input, &message);
    let mut delayed_output = Vec::new();
    let delayed_started = Instant::now();
    worker_loop(delayed_input.as_slice(), &mut delayed_output, 7).unwrap();
    let delayed_elapsed = delayed_started.elapsed();
    clear_hooks();
    assert!(
        delayed_elapsed >= Duration::from_millis(500),
        "delay hook must run inside the render loop before responding: {delayed_elapsed:?}"
    );
    let mut reader = Cursor::new(delayed_output);
    assert!(matches!(
        super::read_message::<WorkerMessage>(&mut reader).unwrap(),
        WorkerMessage::Hello { generation: 7, .. }
    ));
    // The valid manifest requests its first font before the fixture's EOF
    // becomes a protocol failure; the delay must precede this request too.
    assert!(matches!(
        super::read_message::<WorkerMessage>(&mut reader).unwrap(),
        WorkerMessage::ResourceRequest {
            request_id: 91,
            generation: 7,
            ..
        }
    ));
    assert!(matches!(
        super::read_message::<WorkerMessage>(&mut reader).unwrap(),
        WorkerMessage::Failed { .. }
    ));

    std::env::set_var("ZINECV_TEST_WORKER_ALLOC_MB", "64");
    test_hooks_before_render();
    clear_hooks();
    assert!(std::env::var("ZINECV_TEST_WORKER_DELAY_MS").is_err());
    assert!(std::env::var("ZINECV_TEST_WORKER_ALLOC_MB").is_err());
    assert!(std::env::var("ZINECV_TEST_CRASH_MARKER").is_err());
}
