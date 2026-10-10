//! Platform secret protection. Windows uses Current-user DPAPI without changing blob bytes.
use zinecv_contracts::capability::SecretProvider;

pub struct NativeSecrets;

impl SecretProvider for NativeSecrets {
    fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        dpapi_protect(plaintext)
    }
    fn unprotect(&self, ciphertext: &[u8]) -> Result<Vec<u8>, String> {
        dpapi_unprotect(ciphertext)
    }
}

#[cfg(windows)]
fn dpapi_protect(plain: &[u8]) -> Result<Vec<u8>, String> {
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
            return Err("CryptProtectData failed".into());
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as HLOCAL);
        Ok(bytes)
    }
}

#[cfg(windows)]
fn dpapi_unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
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
            return Err("CryptUnprotectData failed".into());
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as HLOCAL);
        Ok(bytes)
    }
}

#[cfg(not(windows))]
fn dpapi_protect(_plain: &[u8]) -> Result<Vec<u8>, String> {
    Err("DPAPI is only available on Windows".into())
}

#[cfg(not(windows))]
fn dpapi_unprotect(_blob: &[u8]) -> Result<Vec<u8>, String> {
    Err("DPAPI is only available on Windows".into())
}
