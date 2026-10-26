use super::*;

#[test]
fn deleting_branch_with_resource_draft_clears_draft_refs_and_keeps_shared_assets() {
    use sha2::{Digest, Sha256};
    use zinecv_contracts::{BasicPatch, CommandEnvelope, DomainCommand};

    let mut store = Store::open_in_memory().expect("store");
    let avatar_bytes = b"branch-avatar-bytes".as_slice();
    let avatar = format!("{:x}", Sha256::digest(avatar_bytes));
    store
        .put_resource(&avatar, "image/png", avatar_bytes, None)
        .expect("store avatar");
    let mut initial = document("doc-branch-resource");
    initial.basic.avatar_asset_id = Some(avatar.clone());
    store
        .initialize_document(&initial, "context-a")
        .expect("init");
    let main = store
        .load_cursor(&initial.document_id, "context-a")
        .expect("cursor")
        .expect("document");
    let feature = store
        .create_branch_from_current(&main, "feature")
        .expect("feature");
    let switched = store
        .switch_branch(&feature, &feature.branch_id, false)
        .expect("switch to feature");
    let banner_bytes = b"branch-banner-bytes".as_slice();
    let banner = format!("{:x}", Sha256::digest(banner_bytes));
    store
        .put_resource(&banner, "image/png", banner_bytes, None)
        .expect("store banner");
    // feature 分支草稿引用 banner 资产，产生 draft owner 的 resource_refs。
    let edited = store
        .apply_command(
            "host-actor",
            CommandEnvelope {
                protocol_version: 1,
                command_id: "feature-avatar".into(),
                document_id: switched.document_id.clone(),
                context_id: switched.context_id.clone(),
                expected_revision: switched.revision.clone(),
                expected_branch_id: switched.branch_id.clone(),
                expected_head_id: switched.head_id.clone(),
                payload: DomainCommand::UpdateBasic {
                    patch: BasicPatch {
                        avatar_asset_id: Some(banner.clone()),
                        ..Default::default()
                    },
                },
            },
        )
        .expect("edit avatar on feature")
        .cursor;
    let feature_owner =
        Store::draft_resource_owner_id(&initial.document_id, "context-a", &feature.branch_id);
    let draft_refs: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM resource_refs WHERE owner_kind = 'draft' AND owner_id = ?1",
            [&feature_owner],
            |row| row.get(0),
        )
        .expect("draft refs before delete");
    assert_eq!(draft_refs, 1, "feature draft 必须先建立 banner 引用");

    let after = store
        .delete_branch(&edited, &feature.branch_id, true)
        .expect("delete feature with live draft");
    assert_eq!(after.branch_id, main.branch_id);
    // 回归断言：删除仍带草稿的分支必须清掉该草稿 owner 的 resource_refs 与
    // resource_recovery_requirements，否则这些资产被 GC 永久占用。
    let draft_refs: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM resource_refs WHERE owner_kind = 'draft' AND owner_id = ?1",
            [&feature_owner],
            |row| row.get(0),
        )
        .expect("draft refs after delete");
    assert_eq!(draft_refs, 0, "被删分支草稿的资源引用必须被清理");
    let recovery_rows: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM resource_recovery_requirements
             WHERE owner_kind = 'draft' AND owner_id = ?1",
            [&feature_owner],
            |row| row.get(0),
        )
        .expect("recovery rows after delete");
    assert_eq!(recovery_rows, 0, "被删分支草稿的恢复要求必须被清理");
    // 引用保护语义：banner 只被被删草稿引用 → GC 回收；avatar 仍被 main
    // 头快照（snapshot owner）引用 → 必须保留。
    assert_eq!(store.collect_unreferenced_resources().expect("gc"), 1);
    assert!(store
        .read_resource_bytes(&banner)
        .expect("read banner after gc")
        .is_none());
    assert!(store
        .read_resource_bytes(&avatar)
        .expect("read avatar after gc")
        .is_some());
}

#[test]
fn version_graph_uses_one_cursor_and_marks_deleted_commit_origin() {
    let mut store = Store::open_in_memory().expect("store");
    let document_id = "doc-version-graph";
    store
        .initialize_document(&document(document_id), "context-a")
        .expect("init");
    let main = store
        .load_cursor(document_id, "context-a")
        .expect("cursor")
        .expect("document");
    let feature = store
        .create_branch_from_current(&main, "feature")
        .expect("feature");
    let descendant = store
        .create_branch_from_current(&feature, "descendant")
        .expect("descendant");
    let current = store
        .delete_branch(&descendant, &feature.branch_id, true)
        .expect("delete feature");
    let graph = store.load_version_graph(document_id).expect("graph");
    assert_eq!(graph.cursor, current);
    assert_eq!(graph.branches.len(), 2);
    assert!(graph
        .branches
        .iter()
        .any(|branch| branch.id == descendant.branch_id && branch.is_current));
    assert!(!graph
        .branches
        .iter()
        .any(|branch| branch.id == feature.branch_id));
    assert_eq!(graph.commits.len(), 3);
    let feature_commit = graph
        .commits
        .iter()
        .find(|commit| Some(&commit.id) == feature.head_id.as_ref())
        .expect("retained feature ancestor");
    assert!(feature_commit.origin_deleted);
    assert_eq!(feature_commit.parent_id, main.head_id);
    let json = serde_json::to_value(&graph).expect("json");
    assert!(json["commits"][0].get("originDeleted").is_some());
}

#[test]
fn version_graph_detailed_window_returns_newest_commits_and_keeps_current_head() {
    let mut store = Store::open_in_memory().expect("store");
    let document_id = "doc-graph-window";
    store
        .initialize_document(&document(document_id), "context-a")
        .expect("init");
    let start = store
        .load_cursor(document_id, "context-a")
        .expect("cursor")
        .expect("document");
    let mut chain = vec![start.head_id.clone().expect("initial head")];
    let mut cursor = start;
    for index in 0..4 {
        let edited = edit_title(
            &mut store,
            &cursor,
            &format!("window-edit-{index}"),
            &format!("标题 {index}"),
        );
        let committed = store
            .commit_draft(&edited, &format!("main commit {index}"))
            .expect("commit");
        chain.push(committed.head_id.clone().expect("head"));
        cursor = committed;
    }
    let main_head = chain[4].clone();
    let side = store
        .create_branch_from_current(&cursor, "side")
        .expect("side");
    let switched = store
        .switch_branch(&side, &side.branch_id, false)
        .expect("switch to side");
    let side_edited = edit_title(&mut store, &switched, "side-edit", "side 标题");
    let side_commit = store
        .commit_draft(&side_edited, "side commit")
        .expect("side commit");
    let side_head = side_commit.head_id.clone().expect("side head");
    chain.push(side_head.clone());
    let back = store
        .switch_branch(&side_commit, &cursor.branch_id, false)
        .expect("back to main");
    assert_eq!(back.head_id.as_deref(), Some(main_head.as_str()));
    // 图中共 7 个提交：baseline、4 次 main 编辑、side 分支创建提交、side 提交。
    // 创建提交不在 chain 里，查出来插入 main_head 与 side_head 之间，统一固定
    // created_at，保证语义顺序与查询排序（created_at DESC, id DESC）一致。
    let creation_commit: String = store
        .connection
        .query_row(
            "SELECT id FROM commits WHERE message = '创建分支：side'",
            [],
            |row| row.get(0),
        )
        .expect("side branch creation commit");
    let mut order: Vec<String> = chain.clone();
    order.insert(5, creation_commit.clone());
    for (index, id) in order.iter().enumerate() {
        let stamp = format!("2026-01-01T00:00:{index:02}");
        store
            .connection
            .execute(
                "UPDATE commits SET created_at = ?1 WHERE id = ?2",
                [&stamp, id],
            )
            .expect("stamp commit");
    }
    let full = store.load_version_graph(document_id).expect("full graph");
    assert_eq!(full.commits.len(), 7);
    assert_eq!(full.commits[0].id, side_head);
    // 分支创建提交在 main_head 之后发生，排序上位于两者之间。
    assert_eq!(full.commits[1].id, creation_commit);
    assert_eq!(full.commits[2].id, main_head);

    let window = store
        .load_version_graph_detailed_with_limit(document_id, 3)
        .expect("window");
    // 结构全量返回：7 个提交一个不少（祖先/共享节点不丢）。
    assert_eq!(window.commits.len(), 7);
    for (index, item) in window.commits.iter().enumerate() {
        assert_eq!(item.commit.id, full.commits[index].id);
        // 只有最新 3 个物化快照；main_head 是第 3 新，也在物化范围内。
        if index < 3 {
            assert!(!item.snapshot_document_json.is_empty());
        } else {
            assert!(item.snapshot_document_json.is_empty());
        }
    }
    // 物化上限 1：当前 head（main 头，第 3 新）不在窗口内也必须物化。
    let narrow = store
        .load_version_graph_detailed_with_limit(document_id, 1)
        .expect("narrow window");
    assert_eq!(narrow.commits.len(), 7);
    assert_eq!(narrow.commits[0].commit.id, side_head);
    assert!(!narrow.commits[0].snapshot_document_json.is_empty());
    assert_eq!(narrow.commits[2].commit.id, main_head);
    assert!(!narrow.commits[2].snapshot_document_json.is_empty());
    assert!(narrow.commits[1].snapshot_document_json.is_empty());
    // 无参调用物化全量（7 ≤ 默认上限），与旧全量实现行为一致。
    let all = store
        .load_version_graph_detailed(document_id)
        .expect("detailed");
    assert_eq!(all.commits.len(), 7);
    assert!(all
        .commits
        .iter()
        .all(|item| !item.snapshot_document_json.is_empty()));
    assert!(matches!(
        store.load_version_graph_detailed_with_limit(document_id, 0),
        Err(StorageError::Validation(_))
    ));
}

#[test]
fn version_graph_detailed_default_limit_bounds_large_graph() {
    let mut store = Store::open_in_memory().expect("store");
    let document_id = "doc-graph-large";
    store
        .initialize_document(&document(document_id), "context-a")
        .expect("init");
    let start = store
        .load_cursor(document_id, "context-a")
        .expect("cursor")
        .expect("document");
    let initial_head = start.head_id.clone().expect("initial head");
    let initial_snapshot: String = store
        .connection
        .query_row(
            "SELECT snapshot_id FROM commits WHERE id = ?1",
            [&initial_head],
            |row| row.get(0),
        )
        .expect("initial snapshot");
    // 超过默认 1000 物化上限，验证图保留结构且详情可按需读取。
    let seeded = store
        .connection
        .unchecked_transaction()
        .expect("seed transaction");
    for index in 0..1199 {
        let commit_id = format!("commit:{document_id}:seeded-{index:04}");
        let parent = if index == 0 {
            initial_head.clone()
        } else {
            format!("commit:{document_id}:seeded-{:04}", index - 1)
        };
        seeded
            .execute(
                "INSERT INTO commits(id, document_id, origin_branch_id, snapshot_id, message, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    commit_id,
                    document_id,
                    start.branch_id.as_str(),
                    initial_snapshot.as_str(),
                    format!("seeded {index}"),
                    format!("2020-01-01T{:02}:{:02}:00", index / 60, index % 60),
                ],
            )
            .expect("seed commit");
        seeded
            .execute(
                "INSERT INTO commit_links(commit_id, visible_parent_id) VALUES (?1, ?2)",
                params![commit_id, parent],
            )
            .expect("seed link");
    }
    seeded.commit().expect("seed commits");

    let full = store.load_version_graph(document_id).expect("full graph");
    assert_eq!(full.commits.len(), 1200);
    assert_eq!(full.commits[0].id, initial_head);
    let detailed = store
        .load_version_graph_detailed(document_id)
        .expect("detailed");
    assert_eq!(detailed.commits.len(), 1200);
    for index in [0usize, 1, 250, 499, 599] {
        assert_eq!(detailed.commits[index].commit.id, full.commits[index].id);
    }
    assert_eq!(
        detailed
            .commits
            .iter()
            .filter(|item| !item.snapshot_document_json.is_empty())
            .count(),
        1000
    );
    let lazy = &detailed.commits[1100];
    assert!(lazy.snapshot_document_json.is_empty());
    let detail = store
        .load_commit_detail(document_id, &lazy.commit.id)
        .expect("detail")
        .expect("visible commit");
    assert_eq!(detail.commit, lazy.commit);
    assert!(!detail.snapshot_document_json.is_empty());
    assert!(store
        .load_commit_detail("other-document", &lazy.commit.id)
        .expect("document scope")
        .is_none());
    // 显式物化上限：结构仍全量，只有最新 limit 个（含 head）物化快照。
    let page = store
        .load_version_graph_detailed_with_limit(document_id, 100)
        .expect("page");
    assert_eq!(page.commits.len(), 1200);
    assert_eq!(page.commits[0].commit.id, full.commits[0].id);
    assert!(!page.commits[99].snapshot_document_json.is_empty());
    assert!(page.commits[100].snapshot_document_json.is_empty());
    assert!(!page.commits[0].snapshot_document_json.is_empty());
}

#[test]
fn load_current_prefers_draft_then_head_snapshot() {
    let mut store = Store::open_in_memory().expect("store");
    assert!(store
        .load_current("missing", "context-a")
        .expect("missing")
        .is_none());
    let document = document("doc-current");
    store
        .save_draft(&document, "context-a", 2)
        .expect("save draft");
    assert_eq!(
        store
            .load_current("doc-current", "context-a")
            .expect("draft")
            .expect("value")
            .0,
        2
    );
    assert_eq!(
        store
            .load_cursor("doc-current", "context-a")
            .expect("cursor")
            .expect("value")
            .revision,
        "2"
    );
    assert!(matches!(
        store.load_current("doc-current", "context-other"),
        Err(StorageError::Conflict(_))
    ));
    commit(&mut store, "doc-current", "提交");
    assert_eq!(
        store
            .load_current("doc-current", "context-a")
            .expect("head")
            .expect("value")
            .1,
        document
    );
}

#[test]
fn initialization_never_replaces_an_existing_draft() {
    use zinecv_contracts::{CommandEnvelope, DomainCommand};

    let mut store = Store::open_in_memory().expect("store");
    let initial = document("doc-initialize");
    assert!(store
        .initialize_document(&initial, "context-a")
        .expect("first initialization"));
    let initial_head = store
        .load_cursor("doc-initialize", "context-a")
        .expect("initial cursor")
        .expect("document")
        .head_id;
    let result = store
        .apply_command(
            "host-actor",
            CommandEnvelope {
                protocol_version: 1,
                command_id: "edit-before-restart".into(),
                document_id: initial.document_id.clone(),
                context_id: "context-a".into(),
                expected_revision: "0".into(),
                expected_branch_id: default_branch_id("doc-initialize"),
                expected_head_id: initial_head,
                payload: DomainCommand::SetDocumentTitle {
                    title: "用户已修改".into(),
                },
            },
        )
        .expect("edit");
    assert_eq!(result.cursor.revision, "1");
    assert!(!store
        .initialize_document(&initial, "context-a")
        .expect("repeat initialization"));
    let (revision, persisted) = store
        .load_current("doc-initialize", "context-a")
        .expect("read")
        .expect("document");
    assert_eq!(revision, 1);
    assert_eq!(persisted.title, "用户已修改");

    assert!(store
        .initialize_document(&document("another-document"), "context-b")
        .expect("second document"));
    assert_eq!(
        store
            .load_current("another-document", "context-b")
            .expect("second document read")
            .expect("second document draft")
            .1
            .document_id,
        "another-document"
    );
}

#[test]
fn simultaneous_initialization_creates_one_document() {
    use std::sync::{Arc, Barrier};

    let path = std::env::temp_dir().join(format!(
        "zinecv-initialize-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    drop(Store::open(&path).expect("migrated empty database"));
    let barrier = Arc::new(Barrier::new(2));
    let handles = (0..2)
        .map(|_| {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let mut store = Store::open(&path).expect("store");
                barrier.wait();
                store
                    .initialize_document(&document("doc-simultaneous"), "context-a")
                    .expect("initialize")
            })
        })
        .collect::<Vec<_>>();
    let created = handles
        .into_iter()
        .map(|handle| handle.join().expect("initializer thread"))
        .filter(|created| *created)
        .count();
    assert_eq!(created, 1);
    let reopened = Store::open(&path).expect("reopen");
    let (revision, _) = reopened
        .load_current("doc-simultaneous", "context-a")
        .expect("read")
        .expect("document");
    assert_eq!(revision, 0);
    drop(reopened);
    for suffix in ["", "-wal", "-shm"] {
        let candidate = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
        if candidate.exists() {
            std::fs::remove_file(candidate).expect("cleanup database");
        }
    }
}
