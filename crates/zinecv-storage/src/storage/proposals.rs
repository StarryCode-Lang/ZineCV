use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Map, Value};

use zinecv_contracts::{
    canonical_hash, AgentProposalDraft, AgentProposalInbox, AgentProposalItem,
    AgentProposalReceipt, AgentProposalRecord, AgentProposalStatus, AgentProposalUndoRecord,
    AuthorityCursor, BasicField, BasicInfo, CommandEnvelope, DomainCommand, ProposalChange,
    ResumeDocument, Section,
};

use super::{StorageError, StorageResult, Store};

const MAX_PROPOSAL_ITEMS: usize = 12;
type AgentRunProposalScope = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
);
type AgentProposalSqlRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    String,
    String,
    String,
    String,
    String,
);

mod confirm;
mod inbox;

#[cfg(test)]
#[path = "proposals/tests.rs"]
mod tests;

#[path = "proposals/validation.rs"]
mod validation;

use validation::*;
#[path = "proposals/materialization.rs"]
mod materialization;

use materialization::*;
