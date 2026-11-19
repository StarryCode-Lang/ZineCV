use super::*;

// 版本备份按“新→旧”导出；替换时父提交可能晚于子提交插入。
// commit_links 对 visible_parent_id 有外键，必须先落全部提交再写父链。
#[test]
fn replacement_accepts_newest_first_parent_links() {
    let (mut store, _) = seeded_store("doc-replace", "context-replace");
    let cursor = store
        .load_active_document("doc-replace")
        .unwrap()
        .expect("active document")
        .0;
    let mut older = document("doc-replace");
    older.title = "第一版".into();
    let mut newer = document("doc-replace");
    newer.title = "第二版".into();
    let branches = vec![ReplaceBranch {
        id: "main".into(),
        name: "main".into(),
        head_commit_id: Some("commit-newer".into()),
        created_at: "2026-01-02T00:00:00Z".into(),
    }];
    let commits = vec![
        ReplaceCommit {
            id: "commit-newer".into(),
            branch_id: "main".into(),
            parent_id: Some("commit-older".into()),
            message: "第二版".into(),
            created_at: "2026-01-02T00:00:00Z".into(),
            snapshot: newer,
        },
        ReplaceCommit {
            id: "commit-older".into(),
            branch_id: "main".into(),
            parent_id: None,
            message: "第一版".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            snapshot: older,
        },
    ];

    let next = store
        .replace_version_store(&cursor, "main", &branches, &commits)
        .expect("newest-first backup should replace");
    assert_eq!(next.head_id.as_deref(), Some("commit-newer"));

    let graph = store.load_version_graph("doc-replace").expect("graph");
    let newer_row = graph
        .commits
        .iter()
        .find(|commit| commit.id == "commit-newer")
        .expect("newer commit");
    assert_eq!(newer_row.parent_id.as_deref(), Some("commit-older"));
    let older_row = graph
        .commits
        .iter()
        .find(|commit| commit.id == "commit-older")
        .expect("older commit");
    assert_eq!(older_row.parent_id, None);
}

// 刚提交后的干净状态没有 durable draft，工作内容由当前分支 head 快照提供；
// 版本备份替换必须接受这种正常状态。
#[test]
fn replacement_accepts_clean_state_with_head_only() {
    let (mut store, _) = seeded_store("doc-clean", "context-a");
    let mut changed = document("doc-clean");
    changed.title = "已提交".into();
    store.save_draft(&changed, "context-a", 2).expect("draft");
    commit(&mut store, "doc-clean", "初始提交");
    assert!(store
        .load_draft("doc-clean", "context-a")
        .expect("load draft")
        .is_none());
    let cursor = store
        .load_cursor("doc-clean", "context-a")
        .expect("cursor")
        .expect("document");
    let snapshot = document("doc-clean");
    let branches = vec![ReplaceBranch {
        id: "main".into(),
        name: "main".into(),
        head_commit_id: Some("commit-clean".into()),
        created_at: "2026-01-01T00:00:00Z".into(),
    }];
    let commits = vec![ReplaceCommit {
        id: "commit-clean".into(),
        branch_id: "main".into(),
        parent_id: None,
        message: "导入版本".into(),
        created_at: "2026-01-01T00:00:00Z".into(),
        snapshot,
    }];

    let next = store
        .replace_version_store(&cursor, "main", &branches, &commits)
        .expect("clean state should replace");
    assert_eq!(next.head_id.as_deref(), Some("commit-clean"));
    assert!(store
        .load_draft("doc-clean", "context-a")
        .expect("load draft")
        .is_some());
}
