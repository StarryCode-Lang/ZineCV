use super::*;

#[tauri::command]
pub(super) fn list_agent_proposals(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
) -> Result<AgentProposalInbox, AppError> {
    agent_proposal_command(&store, &session, |store, account_id| {
        store
            .list_agent_proposals(account_id)
            .map_err(|error| AppError::from(error).with_context("Agent proposals load failed"))
    })
}

#[tauri::command]
pub(super) fn confirm_proposal(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    request: ConfirmProposalRequest,
) -> Result<AgentProposalReceipt, AppError> {
    agent_proposal_command(&store, &session, |store, account_id| {
        require_active_document(&request.cursor.document_id)?;
        store
            .confirm_agent_proposal(account_id, &request)
            .map_err(|error| AppError::from(error).with_context("Proposal confirmation failed"))
    })
}

#[tauri::command]
pub(super) fn reject_proposal(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    request: RejectAgentProposalRequest,
) -> Result<AgentProposalReceipt, AppError> {
    agent_proposal_command(&store, &session, |store, account_id| {
        store
            .reject_agent_proposal(account_id, &request)
            .map_err(|error| AppError::from(error).with_context("Proposal rejection failed"))
    })
}

#[tauri::command]
pub(super) fn undo_confirmed_proposal(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    request: UndoConfirmedProposalRequest,
) -> Result<AgentProposalReceipt, AppError> {
    agent_proposal_command(&store, &session, |store, account_id| {
        require_active_document(&request.cursor.document_id)?;
        store
            .undo_agent_proposal(account_id, &request)
            .map_err(|error| AppError::from(error).with_context("Proposal undo failed"))
    })
}

#[tauri::command]
pub(super) fn list_agent_runs(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
) -> Result<Vec<storage::AgentRunRecord>, AppError> {
    let token = active_token(&session)?;
    let store = lock_store(&store)?;
    let account = store
        .session_account(&token)
        .map_err(|error| AppError::from(error).with_context("Account session failed"))?
        .ok_or_else(|| "请先登录本机账户".to_string())?;
    store
        .list_agent_runs(&account.id)
        .map_err(|error| AppError::from(error).with_context("Agent runs load failed"))
}

#[tauri::command]
pub(super) fn cancel_agent_run(
    runs: State<'_, AgentRuns>,
    session: State<'_, ActiveSession>,
    run_id: String,
) -> Result<(), AppError> {
    let token = active_token(&session)?;
    let active = runs
        .0
        .lock()
        .map_err(|_| "Agent run lock failed".to_string())?;
    if let Some((owner, sender)) = active.get(&run_id) {
        if owner != &token {
            return Err(AppError::new(
                ErrorCode::Permission,
                "Agent run belongs to another account",
                false,
            ));
        }
        let _ = sender.send(true);
    }
    Ok(())
}
