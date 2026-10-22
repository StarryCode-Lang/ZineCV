use crate::domain::{AppError, ErrorCode};
use tauri::WebviewWindow;

/// True means the OS accepted the text; false delegates unsupported platforms
/// to the existing browser clipboard path. Never read the user's clipboard.
pub fn write_text(window: &WebviewWindow, text: &str) -> Result<bool, AppError> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::GlobalFree;
        use windows_sys::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
        };
        use windows_sys::Win32::System::Memory::{
            GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
        };
        let failure = || {
            AppError::new(
                ErrorCode::Permission,
                "Clipboard write failed; retry when available",
                true,
            )
        };
        let hwnd = window.hwnd().map_err(|_| failure())?;
        let encoded: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        // Allocate and populate before opening/emptying so allocation failures
        // leave the existing clipboard intact. All Win32 calls stay on this thread.
        unsafe {
            let memory = GlobalAlloc(GMEM_MOVEABLE, encoded.len() * 2);
            if memory.is_null() {
                return Err(failure());
            }
            let buffer = GlobalLock(memory);
            if buffer.is_null() {
                GlobalFree(memory);
                return Err(failure());
            }
            std::ptr::copy_nonoverlapping(encoded.as_ptr(), buffer.cast::<u16>(), encoded.len());
            GlobalUnlock(memory);
            if OpenClipboard(hwnd.0) == 0 {
                GlobalFree(memory);
                return Err(failure());
            }
            // CF_UNICODETEXT = 13. The non-null main HWND owns the clipboard.
            let written = EmptyClipboard() != 0 && !SetClipboardData(13, memory).is_null();
            CloseClipboard();
            if !written {
                GlobalFree(memory);
                return Err(failure());
            }
            // SetClipboardData transferred memory ownership to Windows.
            Ok(true)
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (window, text);
        Ok(false)
    }
}
