use super::*;

#[test]
fn switched_account_invalidates_a_late_request_result() {
    let session = ActiveSession(Mutex::new(Some("account-a-token".into())));
    assert!(active_token_matches(&session, "account-a-token"));
    *session.0.lock().expect("session lock") = Some("account-b-token".into());
    assert!(!active_token_matches(&session, "account-a-token"));
    assert!(active_token_matches(&session, "account-b-token"));
}

#[test]
fn anonymous_document_edit_uses_only_local_storage() {
    let mut store = Store::open_in_memory().expect("isolated store");
    let document =
        default_resume_document("anonymous-fixture-document").expect("synthetic blank document");
    store
        .initialize_document(&document, "anonymous-fixture-context")
        .expect("initialize document");
    let cursor = store
        .load_cursor(&document.document_id, "anonymous-fixture-context")
        .expect("load cursor")
        .expect("initialized cursor");
    let actor = document_actor_for_token(&store, None).expect("anonymous actor");
    let result = store
        .apply_command(
            &actor,
            CommandEnvelope {
                protocol_version: 1,
                command_id: "anonymous-edit-fixture".into(),
                document_id: cursor.document_id.clone(),
                context_id: cursor.context_id.clone(),
                expected_revision: cursor.revision,
                expected_branch_id: cursor.branch_id,
                expected_head_id: cursor.head_id,
                payload: crate::domain::DomainCommand::SetDocumentTitle {
                    title: "匿名离线编辑".into(),
                },
            },
        )
        .expect("local durable edit without authentication or network");
    assert_eq!(actor, "local-anonymous");
    assert_eq!(result.document.title, "匿名离线编辑");
    assert!(result.durable);
    let account_count: i64 = store
        .connection()
        .query_row("SELECT COUNT(*) FROM accounts", [], |row| row.get(0))
        .expect("account count");
    assert_eq!(account_count, 0);
}
