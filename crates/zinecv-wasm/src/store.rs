//! Worker-owned OPFS adapter; all database semantics come from zinecv-storage.
use rusqlite::{Connection, OpenFlags};
use sqlite_wasm_vfs::sahpool::{install, OpfsSAHPoolCfgBuilder, OpfsSAHPoolUtil};
use wasm_bindgen::prelude::*;
use zinecv_storage::storage::Store;

fn host_error(value: impl std::fmt::Display) -> JsValue {
    super::error(zinecv_contracts::AppError::new(
        zinecv_contracts::ErrorCode::StorageCorrupt,
        value.to_string(),
        false,
    ))
}

fn connection(name: &str) -> Result<Connection, JsValue> {
    Connection::open_with_flags_and_vfs(
        name,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        "zinecv-opfs",
    )
    .map_err(host_error)
}

fn snapshot_name(kind: &str) -> Result<String, JsValue> {
    let mut random = [0u8; 12];
    getrandom::fill(&mut random).map_err(host_error)?;
    Ok(format!(
        "/{kind}-{}.sqlite3",
        random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

#[wasm_bindgen]
pub struct WebStore {
    pub(crate) store: Option<Store>,
    pub(crate) pool: OpfsSAHPoolUtil,
    pub(crate) token: Option<String>,
    pub(crate) last_restore_snapshot: Option<String>,
    #[cfg(feature = "agent")]
    pub(crate) run: Option<super::agent_host::Run>,
}

#[wasm_bindgen]
impl WebStore {
    /// Host serializes this preparation and forbids snapshots during Agent runs.
    pub async fn reserve_snapshot_capacity(&self) -> Result<(), JsValue> {
        self.pool
            .reserve_minimum_capacity(self.pool.count().saturating_add(4))
            .await
            .map_err(host_error)
    }
    pub fn snapshot_before_replace(&self) -> Result<String, JsValue> {
        let name = snapshot_name("pre-replace")?;
        let mut snapshot = connection(&name)?;
        self.store
            .as_ref()
            .ok_or_else(|| host_error("Store closed"))?
            .backup_into(&mut snapshot)
            .map_err(super::error)?;
        Ok(name)
    }
    pub fn backup_ciphertexts(&self, json: &str) -> Result<String, JsValue> {
        let payload = serde_json::from_str(json).map_err(host_error)?;
        let blobs = self
            .store
            .as_ref()
            .ok_or_else(|| host_error("Store closed"))?
            .backup_secret_blobs(&payload)
            .map_err(super::error)?;
        serde_json::to_string(&blobs).map_err(host_error)
    }
    pub async fn open(directory: &str) -> Result<WebStore, JsValue> {
        let cfg = OpfsSAHPoolCfgBuilder::new()
            .vfs_name("zinecv-opfs")
            .directory(directory)
            .initial_capacity(16)
            .build();
        let pool = install::<sqlite_wasm_rs::WasmOsCallback>(&cfg, true)
            .await
            .map_err(host_error)?;
        pool.reserve_minimum_capacity(pool.count().saturating_add(4))
            .await
            .map_err(host_error)?;
        let database = connection("/workspace.sqlite3")?;
        let backup_name = snapshot_name("pre-upgrade")?;
        let mut backup = connection(&backup_name)?;
        let mut store = Store::from_platform_connection(database, Some(&mut backup))
            .map_err(super::error)?
            .with_secret_provider(std::sync::Arc::new(super::secrets::WebSecrets));
        store
            .recover_interrupted_agent_runs()
            .map_err(super::error)?;
        drop(backup);
        // Keep a nonempty pre-upgrade snapshot; fresh databases need no snapshot.
        if pool.export_db(&backup_name).map_err(host_error)?.is_empty() {
            pool.delete_db(&backup_name).map_err(host_error)?;
        }
        Ok(Self {
            store: Some(store),
            pool,
            token: None,
            last_restore_snapshot: None,
            #[cfg(feature = "agent")]
            run: None,
        })
    }

    pub fn initialize(&mut self, json: &str, context: &str) -> Result<bool, JsValue> {
        self.store
            .as_mut()
            .ok_or_else(|| host_error("Store closed"))?
            .initialize_document(&super::document(json)?, context)
            .map_err(super::error)
    }

    pub fn load(&self, document_id: &str) -> Result<String, JsValue> {
        let value = self
            .store
            .as_ref()
            .ok_or_else(|| host_error("Store closed"))?
            .load_active_document(document_id)
            .map_err(super::error)?;
        serde_json::to_string(&value).map_err(host_error)
    }

    pub fn apply(&mut self, actor: &str, json: &str) -> Result<String, JsValue> {
        let value = self
            .store
            .as_mut()
            .ok_or_else(|| host_error("Store closed"))?
            .apply_command(actor, serde_json::from_str(json).map_err(host_error)?)
            .map_err(super::error)?;
        serde_json::to_string(&value).map_err(host_error)
    }

    pub fn backup(&self) -> Result<String, JsValue> {
        let value = self
            .store
            .as_ref()
            .ok_or_else(|| host_error("Store closed"))?
            .export_database_backup()
            .map_err(super::error)?;
        serde_json::to_string(&value).map_err(host_error)
    }

    pub fn restore(&mut self, json: &str) -> Result<String, JsValue> {
        let payload: zinecv_contracts::DatabaseBackupPayload =
            serde_json::from_str(json).map_err(host_error)?;
        let name = snapshot_name("pre-restore")?;
        let mut snapshot = connection(&name)?;
        let result = self
            .store
            .as_mut()
            .ok_or_else(|| host_error("Store closed"))?
            .restore_database_backup_with_snapshot(&payload, &mut snapshot)
            .map_err(super::error)?;
        self.last_restore_snapshot = Some(name);
        serde_json::to_string(&result).map_err(host_error)
    }

    pub fn close(&mut self) -> Result<(), JsValue> {
        drop(self.store.take());
        self.pool.pause_vfs().map_err(host_error)
    }

    pub fn ciphertexts(&self) -> Result<String, JsValue> {
        let store = self
            .store
            .as_ref()
            .ok_or_else(|| host_error("Store closed"))?;
        let mut query = store
            .connection()
            .prepare("SELECT encrypted_blob FROM secrets")
            .map_err(host_error)?;
        let rows = query
            .query_map([], |row| row.get::<_, Vec<u8>>(0))
            .map_err(host_error)?;
        serde_json::to_string(&rows.collect::<Result<Vec<_>, _>>().map_err(host_error)?)
            .map_err(host_error)
    }
}
