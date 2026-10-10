//! Host-provided secret protection; persisted ciphertext remains an opaque blob.

pub trait SecretProvider: Send + Sync {
    fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>, String>;
    fn unprotect(&self, ciphertext: &[u8]) -> Result<Vec<u8>, String>;
}
