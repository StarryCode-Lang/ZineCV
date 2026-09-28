//! B11 身份与凭据：本机账户（旧版 Node scrypt 参数兼容）与 Current-user DPAPI 秘密。
//! 密码哈希参数与旧 `server/local-agent-accounts.mjs` 一致：
//! scrypt(password, salt字符串字节, 64)，Node 默认 N=16384/r=8/p=1，hex 存储。
//! 秘密用 CryptProtectData（无 CRYPTPROTECT_LOCAL_MACHINE）加密后存 SQLite BLOB；
//! 同一 Windows 用户在原机器可解密，跨机/换用户恢复时按需重输（计划 §3.3）。
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use rusqlite::{params, OptionalExtension};
use scrypt::{scrypt, Params};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::storage::{StorageError, StorageResult, Store};

const SCRYPT_LOG_N: u8 = 14; // N = 16384，与 Node 默认一致
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;
const KEY_LEN: usize = 64;
const SALT_BYTES: usize = 32;
const MAX_LOGIN_FAILURES: u32 = 5;
const FAILURE_LOCKOUT: Duration = Duration::from_secs(30);

fn scrypt_hex(password: &str, salt: &str) -> String {
    let node_params =
        Params::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, KEY_LEN).expect("fixed scrypt params");
    let mut out = vec![0u8; KEY_LEN];
    scrypt(password.as_bytes(), salt.as_bytes(), &node_params, &mut out)
        .expect("scrypt with fixed params cannot fail");
    hex(&out)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 盐/会话令牌使用 OS CSPRNG（getrandom）。
fn random_hex(byte_len: usize) -> String {
    let mut buffer = vec![0u8; byte_len];
    getrandom::fill(&mut buffer).expect("OS CSPRNG is always available on supported platforms");
    hex(&buffer)
}

/// 登录失败限流：进程内计数（桌面单用户场景），5 次失败锁 30 秒。
type FailureGate = Mutex<HashMap<String, (u32, Option<Instant>)>>;

fn failure_gate() -> &'static FailureGate {
    static GATE: OnceLock<FailureGate> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn check_failure_gate(email: &str) -> Result<(), StorageError> {
    let mut gate = failure_gate().lock().expect("failure gate");
    // 先拷贝状态结束不可变借用，再按需写入锁定时间。
    let state = gate.get(email).map(|(count, until)| (*count, *until));
    if let Some((count, locked_until)) = state {
        if let Some(until) = locked_until {
            if Instant::now() < until {
                return Err(StorageError::Permission("尝试次数过多，请稍后再试".into()));
            }
        }
        if count >= MAX_LOGIN_FAILURES && locked_until.is_none() {
            gate.insert(
                email.into(),
                (count, Some(Instant::now() + FAILURE_LOCKOUT)),
            );
            return Err(StorageError::Permission("尝试次数过多，请稍后再试".into()));
        }
    }
    Ok(())
}

fn record_failure(email: &str) {
    let mut gate = failure_gate().lock().expect("failure gate");
    let entry = gate.entry(email.into()).or_insert((0, None));
    entry.0 += 1;
}

fn clear_failures(email: &str) {
    failure_gate().lock().expect("failure gate").remove(email);
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile {
    pub id: String,
    pub email: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKeyStatus {
    pub account_id: String,
    pub provider_id: String,
    pub configured: bool,
    /// 脱敏展示（前2+后2位）；明文永不返回前端。
    pub masked_tail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileStatus {
    pub provider_id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub capability: String,
    pub has_api_key: bool,
}

fn normalize_email(email: &str) -> Result<String, StorageError> {
    let email = email.trim().to_ascii_lowercase();
    let valid = email.contains('@')
        && email.len() <= 254
        && email.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'@' | b'.' | b'_' | b'-' | b'+')
        });
    if valid {
        Ok(email)
    } else {
        Err(StorageError::Validation("邮箱格式不正确".into()))
    }
}

impl Store {
    pub fn register_account(&self, email: &str, password: &str) -> StorageResult<AccountProfile> {
        let email = normalize_email(email)?;
        if password.len() < 6 {
            return Err(StorageError::Validation("密码至少 6 位".into()));
        }
        let existing: Option<String> = self
            .connection()
            .query_row(
                "SELECT id FROM accounts WHERE email = ?1",
                [&email],
                |row| row.get(0),
            )
            .optional()?;
        if existing.is_some() {
            return Err(StorageError::Validation("该邮箱已注册".into()));
        }
        let salt = random_hex(SALT_BYTES);
        let password_hash = scrypt_hex(password, &salt);
        let id = format!("acct-{}", random_hex(8));
        self.connection().execute(
            "INSERT INTO accounts(id, email, salt, password_hash) VALUES (?1, ?2, ?3, ?4)",
            params![id, email, salt, password_hash],
        )?;
        Ok(AccountProfile { id, email })
    }

    pub fn login_account(&self, email: &str, password: &str) -> StorageResult<String> {
        let email = normalize_email(email)?;
        check_failure_gate(&email)?;
        let row: Option<(String, String, String)> = self
            .connection()
            .query_row(
                "SELECT id, salt, password_hash FROM accounts WHERE email = ?1",
                [&email],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((account_id, salt, expected_hash)) = row else {
            // 与密码错误同文案，避免账户枚举。
            record_failure(&email);
            return Err(StorageError::Permission("邮箱或密码不正确".into()));
        };
        let supplied = scrypt_hex(password, &salt);
        if supplied.as_bytes().ct_eq(expected_hash.as_bytes()).into() {
            clear_failures(&email);
            let token = random_hex(32);
            self.connection().execute(
                "INSERT INTO account_sessions(token, account_id) VALUES (?1, ?2)",
                params![token, account_id],
            )?;
            Ok(token)
        } else {
            record_failure(&email);
            Err(StorageError::Permission("邮箱或密码不正确".into()))
        }
    }

    pub fn logout_account(&self, token: &str) -> StorageResult<()> {
        self.connection()
            .execute("DELETE FROM account_sessions WHERE token = ?1", [token])?;
        Ok(())
    }

    pub fn session_account(&self, token: &str) -> StorageResult<Option<AccountProfile>> {
        Ok(self
            .connection()
            .query_row(
                "SELECT accounts.id, accounts.email FROM account_sessions
                 JOIN accounts ON accounts.id = account_sessions.account_id
                 WHERE account_sessions.token = ?1",
                [token],
                |row| {
                    Ok(AccountProfile {
                        id: row.get(0)?,
                        email: row.get(1)?,
                    })
                },
            )
            .optional()?)
    }

    fn require_session_account(&self, token: &str) -> StorageResult<AccountProfile> {
        self.session_account(token)?
            .ok_or_else(|| StorageError::Permission("请先登录账户".into()))
    }

    /// 保存 provider Key：DPAPI 加密后入库；连接配置与密文同事务更新。
    pub fn store_provider_key(
        &self,
        token: &str,
        provider_id: &str,
        name: &str,
        base_url: &str,
        model: &str,
        plaintext_key: &str,
    ) -> StorageResult<()> {
        let account = self.require_session_account(token)?;
        let account_id = account.id.as_str();
        if name.len() > 80 || model.trim().is_empty() || model.len() > 256 {
            return Err(StorageError::Validation("连接名称或模型 ID 无效".into()));
        }
        if plaintext_key.len() > 16 * 1024 {
            return Err(StorageError::Validation("Key 超出长度限制".into()));
        }
        crate::gateway::chat_endpoint(base_url).map_err(StorageError::Validation)?;
        let has_existing_key: bool = self.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM secrets WHERE account_id = ?1 AND provider_id = ?2)",
            params![account_id, provider_id],
            |row| row.get(0),
        )?;
        if plaintext_key.is_empty() && !has_existing_key && base_url.starts_with("https://") {
            return Err(StorageError::Validation("远程连接需要 API Key".into()));
        }
        let encrypted = if plaintext_key.is_empty() {
            None
        } else {
            Some(dpapi_protect(plaintext_key.as_bytes())?)
        };
        let digest = Sha256::digest(format!("{account_id}:{provider_id}").as_bytes());
        let secret_id = format!("secret-{}", &hex(&digest)[..16]);
        let transaction = self.connection().unchecked_transaction()?;
        if let Some(encrypted) = encrypted {
            transaction.execute(
                "INSERT INTO secrets(secret_id, account_id, provider_id, encrypted_blob)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(account_id, provider_id) DO UPDATE SET
               encrypted_blob = excluded.encrypted_blob,
               updated_at = CURRENT_TIMESTAMP",
                params![secret_id, account_id, provider_id, encrypted],
            )?;
        }
        transaction.execute(
            "INSERT INTO provider_profiles(account_id, connection_id, name, base_url, model)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(account_id, connection_id) DO UPDATE SET
               name = excluded.name,
               base_url = excluded.base_url,
               model = excluded.model,
               updated_at = CURRENT_TIMESTAMP",
            params![account_id, provider_id, name, base_url, model],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// 密钥状态（脱敏）；明文只有 gateway 路径可取。
    pub fn provider_key_status(
        &self,
        token: &str,
        provider_id: &str,
    ) -> StorageResult<ProviderKeyStatus> {
        let account = self.require_session_account(token)?;
        let account_id = account.id.as_str();
        let blob: Option<Vec<u8>> = self
            .connection()
            .query_row(
                "SELECT encrypted_blob FROM secrets WHERE account_id = ?1 AND provider_id = ?2",
                params![account_id, provider_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(ProviderKeyStatus {
            account_id: account_id.into(),
            provider_id: provider_id.into(),
            configured: blob.is_some(),
            masked_tail: blob.and_then(|blob| {
                dpapi_unprotect(&blob).ok().map(|plain| {
                    let text = String::from_utf8_lossy(&plain).into_owned();
                    let chars: Vec<char> = text.chars().collect();
                    if chars.len() > 4 {
                        format!(
                            "{}…{}",
                            chars[..2].iter().collect::<String>(),
                            chars[chars.len() - 2..].iter().collect::<String>()
                        )
                    } else {
                        "…".into()
                    }
                })
            }),
        })
    }

    pub fn provider_profile(
        &self,
        token: &str,
        provider_id: &str,
    ) -> StorageResult<Option<ProviderProfileStatus>> {
        let account = self.require_session_account(token)?;
        let profile: Option<(String, String, String, String)> = self
            .connection()
            .query_row(
                "SELECT name, base_url, model, capability FROM provider_profiles
                 WHERE account_id = ?1 AND connection_id = ?2",
                params![account.id, provider_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let has_api_key: bool = self.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM secrets WHERE account_id = ?1 AND provider_id = ?2)",
            params![account.id, provider_id],
            |row| row.get(0),
        )?;
        Ok(profile.map(
            |(name, base_url, model, capability)| ProviderProfileStatus {
                provider_id: provider_id.into(),
                name,
                base_url,
                model,
                capability,
                has_api_key,
            },
        ))
    }

    pub fn clear_provider(&self, token: &str, provider_id: &str) -> StorageResult<()> {
        let account = self.require_session_account(token)?;
        let transaction = self.connection().unchecked_transaction()?;
        transaction.execute(
            "DELETE FROM secrets WHERE account_id = ?1 AND provider_id = ?2",
            params![account.id, provider_id],
        )?;
        transaction.execute(
            "DELETE FROM provider_profiles WHERE account_id = ?1 AND connection_id = ?2",
            params![account.id, provider_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// 明文解密（B12 网关使用）；账号+provider 必须成对存在。
    pub fn reveal_provider_secret(
        &self,
        account_id: &str,
        provider_id: &str,
    ) -> StorageResult<Option<String>> {
        let blob: Option<Vec<u8>> = self
            .connection()
            .query_row(
                "SELECT encrypted_blob FROM secrets WHERE account_id = ?1 AND provider_id = ?2",
                params![account_id, provider_id],
                |row| row.get(0),
            )
            .optional()?;
        match blob {
            Some(blob) => dpapi_unprotect(&blob)
                .map(|plain| Some(String::from_utf8_lossy(&plain).into_owned()))
                .map_err(|error| StorageError::Corrupt(format!("Key 无法解密：{error:?}"))),
            None => Ok(None),
        }
    }
}

#[cfg(windows)]
fn dpapi_protect(plain: &[u8]) -> Result<Vec<u8>, StorageError> {
    use windows_sys::Win32::Foundation::{LocalFree, HLOCAL};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let mut output: CRYPT_INTEGER_BLOB = std::mem::zeroed();
        let ok = CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 {
            return Err(StorageError::Corrupt("CryptProtectData failed".into()));
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as HLOCAL);
        Ok(bytes)
    }
}

#[cfg(windows)]
fn dpapi_unprotect(blob: &[u8]) -> Result<Vec<u8>, StorageError> {
    use windows_sys::Win32::Foundation::{LocalFree, HLOCAL};
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: blob.len() as u32,
            pbData: blob.as_ptr() as *mut u8,
        };
        let mut output: CRYPT_INTEGER_BLOB = std::mem::zeroed();
        let ok = CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 {
            return Err(StorageError::Corrupt("CryptUnprotectData failed".into()));
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as HLOCAL);
        Ok(bytes)
    }
}

#[cfg(not(windows))]
fn dpapi_protect(_plain: &[u8]) -> Result<Vec<u8>, StorageError> {
    Err(StorageError::Validation(
        "DPAPI is only available on Windows".into(),
    ))
}

#[cfg(not(windows))]
fn dpapi_unprotect(_blob: &[u8]) -> Result<Vec<u8>, StorageError> {
    Err(StorageError::Validation(
        "DPAPI is only available on Windows".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::open_in_memory().expect("store")
    }

    #[test]
    fn register_login_logout_round_trip_with_scrypt_compat() {
        let store = store();
        let account = store
            .register_account("User@Example.com", "secret-123")
            .expect("register");
        assert_eq!(account.email, "user@example.com");
        // 重复注册拒绝。
        assert!(matches!(
            store.register_account("user@example.com", "another-123"),
            Err(StorageError::Validation(_))
        ));
        // 正确密码 → 会话令牌可换取账户。
        let token = store
            .login_account("user@example.com", "secret-123")
            .expect("login");
        assert_eq!(
            store.session_account(&token).expect("session"),
            Some(account.clone())
        );
        store.logout_account(&token).expect("logout");
        assert_eq!(store.session_account(&token).expect("session"), None);
        // 错误密码拒绝，文案不区分账户存在性。
        assert!(matches!(
            store.login_account("user@example.com", "wrong-pass"),
            Err(StorageError::Permission(_))
        ));
        // 与旧版 Node scrypt 参数兼容：手工构造 16384/8/1 哈希可验证。
        let salt = "0123456789abcdef0123456789abcdef";
        let legacy_hash = scrypt_hex("legacy-password", salt);
        let legacy_id = "acct-legacy";
        let store_ref = store.connection();
        store_ref
            .execute(
                "INSERT INTO accounts(id, email, salt, password_hash) VALUES (?1, ?2, ?3, ?4)",
                params![legacy_id, "legacy@example.com", salt, legacy_hash],
            )
            .expect("insert legacy account");
        assert!(store
            .login_account("legacy@example.com", "legacy-password")
            .is_ok());
    }

    #[test]
    fn login_failures_are_rate_limited() {
        let store = store();
        store
            .register_account("locked@example.com", "correct-horse")
            .expect("register");
        for _ in 0..MAX_LOGIN_FAILURES {
            let result = store.login_account("locked@example.com", "bad-guess");
            assert!(matches!(result, Err(StorageError::Permission(_))));
        }
        // 达到上限后即使密码正确也被暂时锁定。
        assert!(matches!(
            store.login_account("locked@example.com", "correct-horse"),
            Err(StorageError::Permission(_))
        ));
    }

    #[cfg(windows)]
    #[test]
    fn provider_key_dpapi_round_trip_and_masking() {
        let store = store();
        let account = store
            .register_account("key@example.com", "key-pass-1")
            .expect("register");
        let token = store
            .login_account("key@example.com", "key-pass-1")
            .expect("login");
        store
            .store_provider_key(
                &token,
                "openai",
                "我的连接",
                "https://api.openai.com/v1",
                "gpt-6",
                "sk-test-abcdef0123456789",
            )
            .expect("store key");
        let status = store.provider_key_status(&token, "openai").expect("status");
        assert!(status.configured);
        let profile = store
            .provider_profile(&token, "openai")
            .expect("profile")
            .expect("configured profile");
        assert_eq!(profile.base_url, "https://api.openai.com/v1");
        assert_eq!(profile.name, "我的连接");
        assert_eq!(profile.model, "gpt-6");
        assert!(profile.has_api_key);
        store
            .store_provider_key(
                &token,
                "openai",
                "更新名称",
                "https://api.openai.com/v1",
                "gpt-6",
                "",
            )
            .expect("keep stored key");
        assert_eq!(
            store
                .provider_profile(&token, "openai")
                .expect("profile")
                .expect("configured")
                .name,
            "更新名称"
        );
        let masked = status.masked_tail.expect("masked");
        assert!(masked.contains('…'));
        assert!(
            !masked.contains("abcdef0123456789"),
            "mask must not leak the key"
        );
        // 明文只能由 gateway 路径取回。
        assert_eq!(
            store
                .reveal_provider_secret(&account.id, "openai")
                .expect("reveal"),
            Some("sk-test-abcdef0123456789".into())
        );
        // 未配置的 provider 返回未配置状态。
        assert!(
            !store
                .provider_key_status(&token, "missing")
                .expect("status")
                .configured
        );
        // 非法连接地址拒绝。
        assert!(store
            .store_provider_key(&token, "evil2", "test", "ftp://bad", "m", "k")
            .is_err());
        assert!(store
            .store_provider_key(
                &token,
                "remote-no-key",
                "test",
                "https://api.example.com/v1",
                "model",
                ""
            )
            .is_err());
        store
            .store_provider_key(
                &token,
                "local",
                "本地",
                "http://127.0.0.1:3000/v1",
                "model",
                "",
            )
            .expect("local profile without key");
        assert!(
            !store
                .provider_profile(&token, "local")
                .expect("local profile")
                .expect("configured local profile")
                .has_api_key
        );
        let other = store
            .register_account("other@example.com", "other-pass")
            .expect("register other");
        let other_token = store
            .login_account("other@example.com", "other-pass")
            .expect("login other");
        assert!(
            !store
                .provider_key_status(&other_token, "openai")
                .expect("other status")
                .configured
        );
        assert_eq!(
            store
                .provider_profile(&other_token, "openai")
                .expect("other profile"),
            None
        );
        assert!(matches!(
            store.store_provider_key(
                &account.id,
                "openai",
                "test",
                "https://api.openai.com/v1",
                "m",
                "k"
            ),
            Err(StorageError::Permission(_))
        ));
        store.logout_account(&token).expect("logout");
        assert!(matches!(
            store.provider_key_status(&token, "openai"),
            Err(StorageError::Permission(_))
        ));
        assert_ne!(other.id, account.id);
        assert!(matches!(
            store.clear_provider(&token, "openai"),
            Err(StorageError::Permission(_))
        ));
        let token = store
            .login_account("key@example.com", "key-pass-1")
            .expect("login again");
        store
            .clear_provider(&token, "openai")
            .expect("clear provider");
        assert_eq!(
            store
                .provider_profile(&token, "openai")
                .expect("profile after clear"),
            None
        );
        assert_eq!(
            store
                .reveal_provider_secret(&account.id, "openai")
                .expect("secret after clear"),
            None
        );
    }

    #[cfg(windows)]
    #[test]
    fn provider_key_survives_database_reopen_without_exposing_plaintext() {
        let path = std::env::temp_dir().join(format!(
            "zinecv-identity-{}-{}.db",
            std::process::id(),
            random_hex(8)
        ));
        {
            let store = Store::open(&path).expect("create isolated store");
            store
                .register_account("reopen@example.com", "fixture-password")
                .expect("register");
            let token = store
                .login_account("reopen@example.com", "fixture-password")
                .expect("login");
            store
                .store_provider_key(
                    &token,
                    "primary",
                    "持久连接",
                    "https://api.example.com/v1",
                    "fixture-model",
                    "sk-fixture-reopen-123",
                )
                .expect("save encrypted provider");
        }
        {
            let store = Store::open(&path).expect("reopen isolated store");
            let token = store
                .login_account("reopen@example.com", "fixture-password")
                .expect("login after reopen");
            let profile = store
                .provider_profile(&token, "primary")
                .expect("profile")
                .expect("saved profile");
            assert_eq!(profile.name, "持久连接");
            assert_eq!(profile.model, "fixture-model");
            assert!(profile.has_api_key);
            assert!(!serde_json::to_string(&profile)
                .expect("serialize public profile")
                .contains("sk-fixture-reopen-123"));
            let account = store
                .session_account(&token)
                .expect("session")
                .expect("account");
            assert_eq!(
                store
                    .reveal_provider_secret(&account.id, "primary")
                    .expect("decrypt"),
                Some("sk-fixture-reopen-123".into())
            );
        }
        for suffix in ["", "-wal", "-shm"] {
            let file = std::path::PathBuf::from(format!("{}{suffix}", path.display()));
            let _ = std::fs::remove_file(file);
        }
    }
}
