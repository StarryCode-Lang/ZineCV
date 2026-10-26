use super::*;

// Tauri 命令的参数由 invoke 调用方逐项命名传入；此处的参数数量是
// IPC 契约的一部分，聚合成单一 struct 反而要求前端同步改调用面。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(super) async fn agent_chat(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    runs: State<'_, AgentRuns>,
    run_id: String,
    session_id: String,
    target_cursor: AuthorityCursor,
    reference_ids: Vec<String>,
    user_text: String,
    skill_id: Option<String>,
    on_event: Channel<AgentRuntimeEvent>,
) -> Result<gateway::ChatReply, AppError> {
    if run_id.len() < 8
        || run_id.len() > 80
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(validation_error("Invalid agent run ID"));
    }
    let database_generation = runs.1.load(Ordering::Acquire);
    let token = active_token(&session)?;
    verify_default_document(&target_cursor)?;
    if session_id.is_empty()
        || session_id.len() > 160
        || user_text.trim().is_empty()
        || user_text.chars().count() > 6_000
        || skill_id.as_ref().is_some_and(|id| id.len() > 80)
    {
        return Err(validation_error("Invalid agent request"));
    }
    agent::trusted_system_message(skill_id.as_deref()).map_err(validation_error)?;
    let epoch = runs
        .2
        .fetch_add(1, Ordering::AcqRel)
        .checked_add(1)
        .filter(|epoch| *epoch > 0)
        .ok_or_else(|| AppError::new(ErrorCode::ResourceLimit, "Agent epoch exhausted", false))?;
    let (account_id, config, tools_enabled) = {
        let store = lock_store(&store)?;
        let account = store
            .session_account(&token)
            .map_err(|error| AppError::from(error).with_context("Account session failed"))?
            .ok_or_else(|| "请先登录本机账户".to_string())?;
        let profile = store
            .provider_profile(&token, DEFAULT_PROVIDER_ID)
            .map_err(|error| AppError::from(error).with_context("Provider profile failed"))?
            .ok_or_else(|| "请先配置模型连接".to_string())?;
        let key = store
            .reveal_provider_secret(&account.id, DEFAULT_PROVIDER_ID)
            .map_err(|error| sanitized_storage_error(error, "模型 Key 无法解密，请重新输入"))?;
        let tools_enabled = profile.capability == "structured";
        (
            account.id,
            gateway::ProviderConfig {
                base_url: profile.base_url,
                model: profile.model,
                key,
            },
            tools_enabled,
        )
    };
    let (sender, receiver) = watch::channel(false);
    let mut selected;
    let messages;
    {
        let mut active = runs
            .0
            .lock()
            .map_err(|_| "Agent run lock failed".to_string())?;
        if runs.1.load(Ordering::Acquire) != database_generation {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "完整数据库已恢复，请重新载入工作区后再运行 Agent",
                false,
            ));
        }
        if active.contains_key(&run_id) {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "Agent run ID already active",
                false,
            ));
        }
        {
            let mut store = lock_store(&store)?;
            let persisted = store
                .load_agent_session(&account_id, &session_id)
                .map_err(|error| AppError::from(error).with_context("Agent session load failed"))?
                .ok_or_else(|| validation_error("Agent session does not belong to this account"))?;
            selected = agent_context::selected_context(&store, &target_cursor, &reference_ids)
                .map_err(|error| AppError::from(error).with_context("Agent run target failed"))?;
            for (reference_id, payload) in reference_ids.iter().zip(selected.iter_mut()) {
                payload["referenceId"] = serde_json::Value::String(reference_id.clone());
            }
            messages = agent::build_messages(
                &persisted.messages,
                &user_text,
                skill_id.as_deref(),
                &selected,
            )
            .map_err(validation_error)?;
            store
                .begin_agent_run_with_epoch(
                    &account_id,
                    &run_id,
                    &session_id,
                    &target_cursor,
                    &reference_ids,
                    epoch,
                )
                .map_err(|error| AppError::from(error).with_context("Agent run start failed"))?;
            store
                .update_agent_run_state(&account_id, &run_id, epoch, "running", 0, 0, 0, None)
                .map_err(|error| AppError::from(error).with_context("Agent run state failed"))?;
        }
        active.insert(run_id.clone(), (token.clone(), sender.clone()));
    }
    let progress = Arc::new(Mutex::new(AgentRunProgress::default()));
    let target_changed = Arc::new(AtomicBool::new(false));
    let persistence_error = Arc::new(Mutex::new(None::<String>));
    let observe_cancel = receiver.clone();
    let token_for_events = token.clone();
    let sender_for_delta = sender.clone();
    let progress_for_delta = Arc::clone(&progress);
    let error_for_delta = Arc::clone(&persistence_error);
    let run_for_delta = run_id.clone();
    let account_for_delta = account_id.clone();
    let delta_channel = on_event.clone();
    let lifecycle_channel = on_event.clone();
    let store_ref = store.inner();
    let session_ref = session.inner();
    let runs_ref = runs.inner();
    let target_cursor_for_events = target_cursor.clone();
    let database_generation = runs_ref.1.load(Ordering::Acquire);
    let staged_proposal_events = Arc::new(Mutex::new(Vec::<String>::new()));
    let staged_proposal_events_for_callback = Arc::clone(&staged_proposal_events);
    let result = agent::run_agent_turns(
        config,
        messages,
        &selected,
        &target_cursor,
        &run_id,
        tools_enabled,
        receiver.clone(),
        move |text| {
            if text.is_empty() {
                return;
            }
            if *observe_cancel.borrow()
                || !active_token_matches(session_ref, &token_for_events)
                || runs_ref.1.load(Ordering::Acquire) != database_generation
            {
                let _ = sender_for_delta.send(true);
                return;
            }
            let seq = {
                let mut current = match progress_for_delta.lock() {
                    Ok(current) => current,
                    Err(_) => {
                        let _ = sender_for_delta.send(true);
                        return;
                    }
                };
                current.seq = current.seq.saturating_add(1);
                current.pending_seq = current.seq;
                current.pending_text.push_str(&text);
                current.seq
            };
            if let Err(error) = flush_agent_delta_buffer(
                &progress_for_delta,
                store_ref,
                &account_for_delta,
                &run_for_delta,
                epoch,
                false,
            ) {
                if let Ok(mut saved_error) = error_for_delta.lock() {
                    *saved_error = Some(error.message);
                }
                let _ = sender_for_delta.send(true);
                return;
            }
            let _ = delta_channel.send(AgentRuntimeEvent {
                run_id: run_for_delta.clone(),
                seq,
                epoch,
                kind: "delta".into(),
                text: Some(text),
            });
        },
        {
            let progress = Arc::clone(&progress);
            let target_changed = Arc::clone(&target_changed);
            let persistence_error = Arc::clone(&persistence_error);
            let sender = sender.clone();
            let token_for_events = token.clone();
            let run_id_for_events = run_id.clone();
            let account_id_for_events = account_id.clone();
            let observe_cancel_events = receiver.clone();
            move |kind, detail| {
                if *observe_cancel_events.borrow()
                    || !active_token_matches(session_ref, &token_for_events)
                    || runs_ref.1.load(Ordering::Acquire) != database_generation
                {
                    let _ = sender.send(true);
                    return;
                }
                // lifecycle 会以更大的 seq 写 last_seq；先把聚合缓冲按当前水位
                // 落库，避免之后的 delta flush 因 last_seq 倒挂而被拒绝。
                if let Err(error) = flush_agent_delta_buffer(
                    &progress,
                    store_ref,
                    &account_id_for_events,
                    &run_id_for_events,
                    epoch,
                    true,
                ) {
                    if let Ok(mut saved_error) = persistence_error.lock() {
                        *saved_error = Some(error.message);
                    }
                    let _ = sender.send(true);
                    return;
                }
                if kind == "proposal.ready" {
                    if let Ok(mut staged) = staged_proposal_events_for_callback.lock() {
                        staged.push(detail.to_string());
                    } else {
                        let _ = sender.send(true);
                    }
                    return;
                }
                if kind == "tool.started" {
                    let valid_target = lock_store_mutex(store_ref)
                        .and_then(|store| {
                            store
                                .validate_active_cursor(&target_cursor_for_events)
                                .map_err(AppError::from)
                        })
                        .is_ok();
                    if !valid_target {
                        target_changed.store(true, Ordering::Release);
                        let _ = sender.send(true);
                        return;
                    }
                }
                let (seq, model_calls, tool_calls) = match progress.lock() {
                    Ok(mut current) => {
                        current.seq = current.seq.saturating_add(1);
                        if kind == "model_call.started" {
                            current.model_calls = detail.parse().unwrap_or(current.model_calls);
                        } else if kind == "tool.started" {
                            current.tool_calls = current.tool_calls.saturating_add(1);
                        }
                        (current.seq, current.model_calls, current.tool_calls)
                    }
                    Err(_) => {
                        let _ = sender.send(true);
                        return;
                    }
                };
                let state = if kind == "proposal.ready" {
                    "awaiting_confirmation"
                } else {
                    "running"
                };
                let persist_result = lock_store_mutex(store_ref).and_then(|mut store| {
                    store
                        .update_agent_run_state(
                            &account_id_for_events,
                            &run_id_for_events,
                            epoch,
                            state,
                            seq,
                            model_calls,
                            tool_calls,
                            None,
                        )
                        .map_err(|error| {
                            AppError::from(error).with_context("Agent lifecycle persistence failed")
                        })
                });
                if let Err(error) = persist_result {
                    if let Ok(mut saved_error) = persistence_error.lock() {
                        *saved_error = Some(error.message);
                    }
                    let _ = sender.send(true);
                    return;
                }
                let _ = lifecycle_channel.send(AgentRuntimeEvent {
                    run_id: run_id_for_events.clone(),
                    seq,
                    epoch,
                    kind: kind.to_string(),
                    text: Some(detail.to_string()),
                });
            }
        },
    )
    .await;

    // Removing the active run is the cancel/finish linearization point. A
    // cancellation accepted before this point suppresses proposal persistence;
    // after it, only the explicit proposal transaction can change the draft.
    runs.0
        .lock()
        .map_err(|_| "Agent run lock failed".to_string())?
        .remove(&run_id);

    let switched = !active_token_matches(session.inner(), &token);
    let stale_target = target_changed.load(Ordering::Acquire);
    // finish_agent_run 终结 status 前落位剩余聚合 delta。lifecycle 已把状态
    // 推离 running（proposal.ready 后的残留）或取消已终结 status 时返回
    // Conflict，缓冲内容属于已终结状态，按无需写入容忍。
    if let Err(error) =
        flush_agent_delta_buffer(&progress, store.inner(), &account_id, &run_id, epoch, true)
    {
        if error.code != ErrorCode::Conflict {
            if let Ok(mut saved) = persistence_error.lock() {
                *saved = Some(error.message);
            }
        }
    }
    let saved_error = persistence_error
        .lock()
        .ok()
        .and_then(|error| error.clone());
    let mut proposal_error = None;
    let mut persisted_proposal_ids = Vec::new();
    if !switched && !*receiver.borrow() && !stale_target && saved_error.is_none() {
        if let Ok(run_result) = &result {
            if !run_result.proposal_drafts.is_empty() {
                match agent::durable_proposal_drafts(
                    &run_result.proposal_drafts,
                    &selected,
                    &run_id,
                ) {
                    Ok(drafts) => {
                        let staged = staged_proposal_events
                            .lock()
                            .map(|values| values.clone())
                            .unwrap_or_default();
                        let draft_ids = drafts
                            .iter()
                            .map(|draft| draft.id.as_str())
                            .collect::<Vec<_>>();
                        let staged_ids = staged.iter().map(String::as_str).collect::<Vec<_>>();
                        if draft_ids != staged_ids {
                            proposal_error = Some(validation_error(
                                "Agent proposal events do not match the durable proposal drafts",
                            ));
                        } else {
                            match lock_store(&store).and_then(|mut store| {
                                store
                                    .create_agent_proposals(
                                        &account_id,
                                        &run_id,
                                        &target_cursor,
                                        &drafts,
                                    )
                                    .map_err(|error| {
                                        AppError::from(error)
                                            .with_context("Agent proposal persistence failed")
                                    })
                            }) {
                                Ok(records) => {
                                    persisted_proposal_ids =
                                        records.into_iter().map(|record| record.id).collect();
                                }
                                Err(error) => proposal_error = Some(error),
                            }
                        }
                    }
                    Err(message) => proposal_error = Some(validation_error(message)),
                }
            }
        }
    }
    let status = if stale_target {
        "failed"
    } else if switched || *receiver.borrow() {
        "cancelled"
    } else if result.is_ok() && proposal_error.is_none() {
        "completed"
    } else {
        "failed"
    };
    lock_store(&store)?
        .finish_agent_run(&account_id, &run_id, status)
        .map_err(|error| AppError::from(error).with_context("Agent run finish failed"))?;
    let (mut seq, model_calls, tool_calls) = {
        let progress = progress.lock().map_err(|_| {
            AppError::new(
                ErrorCode::StorageCorrupt,
                "Agent run progress lock failed",
                false,
            )
        })?;
        (progress.seq, progress.model_calls, progress.tool_calls)
    };
    let lifecycle_state = if !persisted_proposal_ids.is_empty() && status == "completed" {
        "awaiting_confirmation"
    } else {
        status
    };
    if lifecycle_state == "awaiting_confirmation" {
        for proposal_id in &persisted_proposal_ids {
            seq = seq.saturating_add(1);
            lock_store(&store)?
                .update_agent_run_state(
                    &account_id,
                    &run_id,
                    epoch,
                    "awaiting_confirmation",
                    seq,
                    model_calls,
                    tool_calls,
                    None,
                )
                .map_err(|error| {
                    AppError::from(error)
                        .with_context("Agent proposal lifecycle persistence failed")
                })?;
            let _ = on_event.send(AgentRuntimeEvent {
                run_id: run_id.clone(),
                seq,
                epoch,
                kind: "proposal.ready".into(),
                text: Some(proposal_id.clone()),
            });
        }
    }
    seq = seq.saturating_add(1);
    lock_store(&store)?
        .update_agent_run_state(
            &account_id,
            &run_id,
            epoch,
            lifecycle_state,
            seq,
            model_calls,
            tool_calls,
            saved_error
                .as_deref()
                .or_else(|| stale_target.then_some("document target changed during run")),
        )
        .map_err(|error| AppError::from(error).with_context("Agent run terminal state failed"))?;
    let terminal_kind = match status {
        "completed" => "run.completed",
        "cancelled" => "run.cancelled",
        _ => "run.failed",
    };
    let _ = on_event.send(AgentRuntimeEvent {
        run_id: run_id.clone(),
        seq,
        epoch,
        kind: terminal_kind.into(),
        text: saved_error.clone(),
    });
    if switched {
        return Err(AppError::new(
            ErrorCode::Permission,
            "模型请求所属账户已切换",
            false,
        ));
    }
    if stale_target {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "Agent target changed; no late tool result was accepted",
            false,
        ));
    }
    if let Some(message) = saved_error {
        return Err(AppError::new(ErrorCode::StorageCorrupt, message, false));
    }
    if let Some(error) = proposal_error {
        return Err(error);
    }
    result
        .map_err(|message| {
            let code = if message == "模型请求已取消" {
                ErrorCode::Cancelled
            } else {
                ErrorCode::ProviderFailure
            };
            AppError::new(code, message, false)
        })
        .map(|result| result.reply)
}
