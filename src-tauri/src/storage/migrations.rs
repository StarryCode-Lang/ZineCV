pub(super) const MIGRATIONS: [(i64, &str); 17] = [
    (
        1,
        r##"
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      current_branch_id TEXT NOT NULL,
      active_context_id TEXT NOT NULL,
      revision INTEGER NOT NULL
    );
    CREATE TABLE editing_contexts (
      id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      PRIMARY KEY(document_id, id),
      FOREIGN KEY(document_id) REFERENCES documents(id)
    );
    CREATE TABLE branches (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      name TEXT NOT NULL,
      head_commit_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(document_id, name),
      FOREIGN KEY(document_id) REFERENCES documents(id)
    );
    CREATE TABLE drafts (
      document_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      document_json TEXT NOT NULL,
      hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(document_id, context_id, branch_id),
      FOREIGN KEY(document_id) REFERENCES documents(id),
      FOREIGN KEY(branch_id) REFERENCES branches(id)
    );
    CREATE TABLE snapshots (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      canonical_version INTEGER NOT NULL,
      document_json TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE
    );
    CREATE TABLE commits (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      origin_branch_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(document_id) REFERENCES documents(id),
      FOREIGN KEY(origin_branch_id) REFERENCES branches(id),
      FOREIGN KEY(snapshot_id) REFERENCES snapshots(id)
    );
    CREATE TABLE commit_links (
      commit_id TEXT PRIMARY KEY,
      visible_parent_id TEXT,
      FOREIGN KEY(commit_id) REFERENCES commits(id),
      FOREIGN KEY(visible_parent_id) REFERENCES commits(id)
    );
    CREATE TABLE resources (
      hash TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      bytes BLOB NOT NULL,
      size INTEGER NOT NULL,
      license_ref TEXT
    );
    CREATE TABLE resource_refs (
      resource_hash TEXT NOT NULL,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      PRIMARY KEY(resource_hash, owner_kind, owner_id),
      FOREIGN KEY(resource_hash) REFERENCES resources(hash)
    );
    CREATE TABLE command_receipts (
      command_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      revision INTEGER NOT NULL
    );
    CREATE INDEX idx_drafts_document ON drafts(document_id, updated_at);
    CREATE INDEX idx_commits_document ON commits(document_id, created_at);
    CREATE INDEX idx_resource_refs_owner ON resource_refs(owner_kind, owner_id);
    "##,
    ),
    (
        2,
        r##"
    CREATE TABLE branch_tombstones (
      branch_id TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(branch_id) REFERENCES branches(id)
    );
    "##,
    ),
    (
        3,
        r##"
    -- 工作区偏好（分栏宽度、模板收藏/最近使用、导入模板目录等）。
    -- 不进入文档内容 hash，也不参与版本快照。
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    "##,
    ),
    (
        4,
        r##"
    -- B11 身份与凭据：本机账户、会话、模型连接与 DPAPI 密文。
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      kdf TEXT NOT NULL DEFAULT 'scrypt-n16384-r8-p1',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE account_sessions (
      token TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );
    CREATE TABLE provider_profiles (
      account_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      capability TEXT NOT NULL DEFAULT 'chat-only',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(account_id, connection_id),
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );
    CREATE TABLE secrets (
      secret_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      backend_version INTEGER NOT NULL DEFAULT 1,
      encrypted_blob BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(account_id, provider_id),
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );
    "##,
    ),
    (
        5,
        r##"
    ALTER TABLE provider_profiles ADD COLUMN name TEXT NOT NULL DEFAULT '';
    "##,
    ),
    (
        6,
        r##"
    CREATE TABLE imported_template_catalog (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      payload_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    "##,
    ),
    (
        7,
        r##"
    CREATE TABLE template_activity (
      template_id TEXT PRIMARY KEY,
      favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0, 1)),
      last_used_at INTEGER CHECK(last_used_at IS NULL OR last_used_at > 0)
    );
    "##,
    ),
    (
        8,
        r##"
    CREATE TABLE agent_session_meta (
      account_id TEXT PRIMARY KEY,
      active_session_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(account_id, ordinal),
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );
    CREATE INDEX idx_agent_sessions_account ON agent_sessions(account_id, updated_at);
    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      source_view TEXT,
      source_refs_json TEXT,
      UNIQUE(session_id, ordinal),
      FOREIGN KEY(session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
    );
    "##,
    ),
    (
        9,
        r##"
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      revision TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      head_id TEXT,
      reference_ids_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'cancelled', 'failed')),
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      FOREIGN KEY(account_id) REFERENCES accounts(id),
      FOREIGN KEY(document_id) REFERENCES documents(id)
    );
    CREATE INDEX idx_agent_runs_account ON agent_runs(account_id, started_at);
    "##,
    ),
    (
        10,
        r##"
    CREATE INDEX idx_editing_context_source
      ON editing_contexts(document_id, source_kind, source_id);
    "##,
    ),
    (
        11,
        r##"
    CREATE TABLE template_revisions (
      template_id TEXT NOT NULL,
      revision_hash TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(template_id, revision_hash)
    );
    CREATE INDEX idx_template_revisions_hash ON template_revisions(revision_hash);
    CREATE TABLE resource_leases (
      lease_id TEXT NOT NULL,
      resource_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY(lease_id, resource_hash),
      FOREIGN KEY(resource_hash) REFERENCES resources(hash) ON DELETE CASCADE
    );
    CREATE INDEX idx_resource_leases_expiry ON resource_leases(expires_at);
    CREATE TABLE resource_recovery_requirements (
      id INTEGER PRIMARY KEY,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      resource_hash TEXT,
      reason TEXT NOT NULL,
      detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_resource_recovery_owner
      ON resource_recovery_requirements(owner_kind, owner_id);
    "##,
    ),
    (
        12,
        r##"
    CREATE TABLE import_drafts (
      id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('pdf', 'docx', 'image', 'legacy_json')),
      display_name TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'review_required', 'committed', 'failed', 'cancelled')),
      preview_asset_id TEXT,
      candidates_json TEXT NOT NULL DEFAULT '[]',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      unsupported_features_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY(preview_asset_id) REFERENCES resources(hash)
    );
    CREATE INDEX idx_import_drafts_status ON import_drafts(status, updated_at);
    CREATE INDEX idx_import_drafts_source_hash ON import_drafts(source_hash);
    "##,
    ),
    (
        13,
        r##"
    CREATE TABLE legacy_migration_batches (
      batch_key TEXT PRIMARY KEY,
      command_id TEXT NOT NULL UNIQUE,
      actor TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE legacy_migration_commands (
      command_id TEXT PRIMARY KEY,
      batch_key TEXT NOT NULL,
      actor TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      FOREIGN KEY(batch_key) REFERENCES legacy_migration_batches(batch_key)
    );
    CREATE TABLE legacy_entity_identity (
      namespace TEXT NOT NULL,
      target_document_id TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      legacy_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      native_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY(namespace, target_document_id, entity_kind, legacy_id, content_hash),
      FOREIGN KEY(target_document_id) REFERENCES documents(id)
    );
    CREATE INDEX idx_legacy_entity_identity_lookup
      ON legacy_entity_identity(namespace, target_document_id, entity_kind, legacy_id);
    "##,
    ),
    (
        14,
        r##"
    CREATE TABLE agent_run_lifecycle (
      run_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK(state IN (
        'idle', 'preparing', 'running', 'awaiting_confirmation',
        'applying', 'completed', 'failed', 'cancelled'
      )),
      epoch INTEGER NOT NULL CHECK(epoch > 0),
      last_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_seq >= 0),
      model_calls INTEGER NOT NULL DEFAULT 0 CHECK(model_calls >= 0),
      tool_calls INTEGER NOT NULL DEFAULT 0 CHECK(tool_calls >= 0),
      partial_text TEXT NOT NULL DEFAULT '',
      interrupted_reason TEXT,
      deadline_at INTEGER NOT NULL,
      awaiting_confirmation_since INTEGER,
      confirmation_wait_ms INTEGER NOT NULL DEFAULT 0 CHECK(confirmation_wait_ms >= 0),
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_agent_run_lifecycle_state ON agent_run_lifecycle(state, updated_at);
    "##,
    ),
    (
        15,
        r##"
    CREATE TABLE agent_proposals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      base_revision TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      head_id TEXT,
      scope_hash TEXT NOT NULL,
      explanation TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','confirmed','rejected','undone','expired')),
      items_json TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
      FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_agent_proposals_account_status
      ON agent_proposals(account_id, status, created_at DESC);
    CREATE INDEX idx_agent_proposals_run ON agent_proposals(run_id);

    CREATE TABLE agent_proposal_receipts (
      id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL UNIQUE,
      proposal_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('confirm','reject','undo')),
      request_hash TEXT NOT NULL,
      cursor_json TEXT,
      accepted_item_ids_json TEXT NOT NULL DEFAULT '[]',
      undo_of_receipt_id TEXT UNIQUE,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY(proposal_id) REFERENCES agent_proposals(id),
      FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY(undo_of_receipt_id) REFERENCES agent_proposal_receipts(id)
    );
    CREATE INDEX idx_agent_proposal_receipts_proposal
      ON agent_proposal_receipts(proposal_id, created_at);
    "##,
    ),
    (
        16,
        r##"
    ALTER TABLE provider_profiles ADD COLUMN needs_reentry INTEGER NOT NULL DEFAULT 0
      CHECK(needs_reentry IN (0, 1));
    "##,
    ),
    (
        17,
        r##"
    -- delete_commit 按 visible_parent_id 回填父链（storage.rs UPDATE commit_links），
    -- 无索引时每次删除提交都会全表扫描 commit_links。
    CREATE INDEX IF NOT EXISTS idx_commit_links_visible_parent
      ON commit_links(visible_parent_id);
    "##,
    ),
];
