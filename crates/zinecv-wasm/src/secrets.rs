use wasm_bindgen::prelude::*;
use zinecv_contracts::capability::SecretProvider;

#[wasm_bindgen(module = "/js/web-secrets.mjs")]
extern "C" {
    #[wasm_bindgen(catch)]
    fn protect_sync(bytes: &[u8]) -> Result<js_sys::Uint8Array, JsValue>;
    #[wasm_bindgen(catch)]
    fn unprotect_sync(bytes: &[u8]) -> Result<js_sys::Uint8Array, JsValue>;
    fn init_secrets(scope: &str) -> js_sys::Promise;
    fn prepare_secret(plaintext: &str) -> js_sys::Promise;
    fn prepare_ciphertexts(ciphertexts: JsValue) -> js_sys::Promise;
    fn clear_plaintext();
}
pub struct WebSecrets;
impl SecretProvider for WebSecrets {
    fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        protect_sync(plaintext)
            .map(|value| value.to_vec())
            .map_err(|_| "WebCrypto preparation required".into())
    }
    fn unprotect(&self, ciphertext: &[u8]) -> Result<Vec<u8>, String> {
        unprotect_sync(ciphertext)
            .map(|value| value.to_vec())
            .map_err(|_| "Secret unavailable in this browser".into())
    }
}

#[wasm_bindgen]
pub async fn open_secret_capability(scope: &str) -> Result<(), JsValue> {
    wasm_bindgen_futures::JsFuture::from(init_secrets(scope)).await?;
    Ok(())
}
#[wasm_bindgen]
pub async fn prepare_provider_secret(plaintext: &str) -> Result<(), JsValue> {
    wasm_bindgen_futures::JsFuture::from(prepare_secret(plaintext)).await?;
    Ok(())
}
#[wasm_bindgen]
pub async fn prepare_stored_secrets(ciphertexts: JsValue) -> Result<(), JsValue> {
    wasm_bindgen_futures::JsFuture::from(prepare_ciphertexts(ciphertexts)).await?;
    Ok(())
}
#[wasm_bindgen]
pub fn clear_secret_cache() {
    clear_plaintext();
}
