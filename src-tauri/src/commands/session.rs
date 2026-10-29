use super::*;

pub(super) fn validation_error(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Validation, message, false)
}

pub(super) fn resource_limit_error(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::ResourceLimit, message, false)
}

pub(super) fn sanitized_storage_error(error: StorageError, message: &str) -> AppError {
    let mut app_error = AppError::from(error);
    app_error.message = message.into();
    app_error
}

// 将聚合缓冲落库。返回 Ok(false) 表示未到阈值无需写入。取走缓冲后发生
// Conflict（lifecycle 已把状态推离 running，或取消已终结 status）说明这批
// 内容所属的运行已不在可持久化状态，交给调用方按语义容忍或记录。
pub(super) fn flush_agent_delta_buffer(
    progress: &Mutex<AgentRunProgress>,
    store_ref: &std::sync::Mutex<Store>,
    account_id: &str,
    run_id: &str,
    epoch: u64,
    document_target: (&str, u64),
    force: bool,
) -> Result<bool, AppError> {
    let (text, seq) = {
        let mut current = progress.lock().map_err(|_| {
            AppError::new(
                ErrorCode::StorageCorrupt,
                "Agent run progress lock failed",
                false,
            )
        })?;
        if current.pending_text.is_empty() {
            return Ok(false);
        }
        if !force
            && current.pending_text.len() < 4096
            && current
                .last_flush
                .map(|at| at.elapsed() < std::time::Duration::from_millis(200))
                .unwrap_or(false)
        {
            return Ok(false);
        }
        current.last_flush = Some(std::time::Instant::now());
        (
            std::mem::take(&mut current.pending_text),
            current.pending_seq,
        )
    };
    lock_store_mutex(store_ref).and_then(|mut store| {
        require_active_document_epoch(document_target.0, document_target.1)?;
        store
            .persist_agent_run_delta(account_id, run_id, epoch, seq, &text)
            .map_err(|error| AppError::from(error).with_context("Agent stream persistence failed"))
    })?;
    Ok(true)
}

pub(super) fn cancel_runs_for_token(
    runs: &State<'_, AgentRuns>,
    token: &str,
) -> Result<(), AppError> {
    let active = runs
        .0
        .lock()
        .map_err(|_| "Agent run lock failed".to_string())?;
    for (owner, sender) in active.values() {
        if owner == token {
            let _ = sender.send(true);
        }
    }
    Ok(())
}

pub(super) fn active_token(session: &State<'_, ActiveSession>) -> Result<String, AppError> {
    session
        .0
        .lock()
        .map_err(|_| "Account session lock failed".to_string())?
        .clone()
        .ok_or_else(|| AppError::new(ErrorCode::Permission, "请先登录本机账户", false))
}

pub(super) fn active_token_matches(session: &ActiveSession, expected: &str) -> bool {
    session
        .0
        .lock()
        .map(|active| active.as_deref() == Some(expected))
        .unwrap_or(false)
}

pub(super) fn document_actor_for_token(
    store: &Store,
    token: Option<&str>,
) -> Result<String, AppError> {
    let Some(token) = token else {
        return Ok("local-anonymous".into());
    };
    let account = store
        .session_account(token)
        .map_err(|error| AppError::from(error).with_context("Account session failed"))?
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::Permission,
                "Active account session is invalid",
                false,
            )
        })?;
    Ok(format!("account:{}", account.id))
}

pub(super) fn require_main_window(window: &WebviewWindow, action: &str) -> Result<(), AppError> {
    if window.label() != "main" {
        return Err(AppError::new(
            ErrorCode::Permission,
            format!("{action} is not available in this window"),
            false,
        ));
    }
    Ok(())
}

#[tauri::command]
pub(super) fn write_clipboard_text(window: WebviewWindow, text: String) -> Result<bool, AppError> {
    require_main_window(&window, "Clipboard write")?;
    if text.len() > 16 * 1024 * 1024 || text.contains('\0') {
        return Err(validation_error(
            "Clipboard text is too large or contains NUL",
        ));
    }
    clipboard::write_text(&window, &text)
}

pub(super) fn lock_store<'a>(
    store: &'a State<'_, Mutex<Store>>,
) -> Result<std::sync::MutexGuard<'a, Store>, AppError> {
    lock_store_mutex(store)
}

pub(super) fn lock_store_mutex(
    store: &Mutex<Store>,
) -> Result<std::sync::MutexGuard<'_, Store>, AppError> {
    store.lock().map_err(|_| {
        AppError::new(
            ErrorCode::StorageCorrupt,
            "Document store lock failed",
            false,
        )
    })
}

// 冻结快照 → 资源租约 → worker 渲染 → 租约释放的共享骨架；四个渲染命令仅
// 上下文文案与 worker 入口不同，错误码与文案保持与原实现逐字一致。
pub(super) async fn run_frozen_render<T, F>(
    store: &State<'_, Mutex<Store>>,
    cursor: &AuthorityCursor,
    snapshot_context: &'static str,
    lease_context: &'static str,
    task_failure: &'static str,
    cleanup_context: &'static str,
    render: F,
) -> Result<T, AppError>
where
    F: FnOnce(AuthorityCursor, ResumeDocument, Option<(String, Vec<u8>)>) -> Result<T, String>
        + Send
        + 'static,
    T: Send + 'static,
{
    let (document, avatar, lease_id) = {
        let store = lock_store(store)?;
        require_active_document(&cursor.document_id)?;
        let (document, avatar) = store
            .freeze_export(cursor)
            .map_err(|error| AppError::from(error).with_context(snapshot_context))?;
        let lease_id = document
            .basic
            .avatar_asset_id
            .as_ref()
            .map(|hash| store.create_resource_lease(std::slice::from_ref(hash), 15 * 60))
            .transpose()
            .map_err(|error| AppError::from(error).with_context(lease_context))?;
        (document, avatar, lease_id)
    };
    let cursor = cursor.clone();
    let rendered = tauri::async_runtime::spawn_blocking(move || render(cursor, document, avatar))
        .await
        .map_err(|error| {
            AppError::new(
                ErrorCode::EngineFailure,
                format!("{task_failure}: {error}"),
                false,
            )
        })
        .and_then(|result| {
            result.map_err(|message| AppError::new(ErrorCode::EngineFailure, message, false))
        });
    let release = lease_id
        .as_deref()
        .map(|lease_id| {
            lock_store(store)?
                .release_resource_lease(lease_id)
                .map_err(|error| AppError::from(error).with_context(cleanup_context))
        })
        .transpose();
    match (rendered, release) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(result), Ok(_)) => Ok(result),
    }
}

pub(super) fn agent_proposal_command<T>(
    store: &Mutex<Store>,
    session: &State<'_, ActiveSession>,
    run: impl FnOnce(&mut Store, &str) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let token = active_token(session)?;
    let mut guard = lock_store_mutex(store)?;
    let account = guard
        .session_account(&token)
        .map_err(|error| AppError::from(error).with_context("Account session failed"))?
        .ok_or_else(|| AppError::new(ErrorCode::Permission, "请先登录本机账户", false))?;
    run(&mut guard, &account.id)
}

/// M2：文档类命令统一入口校验——目标必须等于宿主 active 文档，返回当前
/// epoch 供切换协议比对。拒绝语义为不可重试的 Conflict。
pub(super) fn require_active_document(document_id: &str) -> Result<u64, AppError> {
    let guard = ACTIVE_DOCUMENT
        .lock()
        .map_err(|_| AppError::new(ErrorCode::StorageCorrupt, "文档宿主锁失败", false))?;
    let Some(inner) = guard.as_ref() else {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "文档宿主尚未就绪",
            false,
        ));
    };
    if inner.document_id != document_id {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "目标文档已不是当前文档；请返回原目标或重新发起",
            false,
        ));
    }
    Ok(inner.epoch)
}

/// M2：切换/创建文档后推进宿主 epoch 并持久化 settings.active-document-id。
pub(super) fn advance_active_document(
    store: &mut Store,
    document_id: &str,
) -> Result<u64, AppError> {
    let mut guard = ACTIVE_DOCUMENT
        .lock()
        .map_err(|_| AppError::new(ErrorCode::StorageCorrupt, "文档宿主锁失败", false))?;
    let epoch = match guard.as_ref() {
        Some(inner) => inner
            .epoch
            .checked_add(1)
            .ok_or_else(|| resource_limit_error("Document epoch exhausted"))?,
        None => 1,
    };
    store
        .persist_active_document_transition(
            guard.as_ref().map(|inner| inner.document_id.as_str()),
            document_id,
        )
        .map_err(|error| {
            AppError::from(error).with_context("Active document persistence failed")
        })?;
    *guard = Some(crate::ActiveDocumentInner {
        document_id: document_id.to_string(),
        epoch,
    });
    Ok(epoch)
}

pub(super) fn require_active_document_epoch(
    document_id: &str,
    expected: u64,
) -> Result<(), AppError> {
    if require_active_document(document_id)? != expected {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "文档会话已切换，请重新发起",
            false,
        ));
    }
    Ok(())
}

/// M2：读取当前 active 文档 ID（document_list 等需要展示 active 的命令用）。
pub(super) fn active_document_id() -> Result<Option<String>, AppError> {
    let guard = ACTIVE_DOCUMENT
        .lock()
        .map_err(|_| AppError::new(ErrorCode::StorageCorrupt, "文档宿主锁失败", false))?;
    Ok(guard.as_ref().map(|inner| inner.document_id.clone()))
}

pub(super) fn trusted_document_actor(
    store: &Store,
    session: &State<'_, ActiveSession>,
    window: &WebviewWindow,
) -> Result<String, AppError> {
    require_main_window(window, "Document editing")?;
    let token = session
        .0
        .lock()
        .map_err(|_| "Account session lock failed".to_string())?
        .clone();
    document_actor_for_token(store, token.as_deref())
}
