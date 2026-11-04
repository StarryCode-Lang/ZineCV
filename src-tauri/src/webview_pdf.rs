//! Print the main WebView's prepared print-only document to an in-memory PDF.
use crate::domain::{AppError, ErrorCode};
use tauri::WebviewWindow;

#[cfg(windows)]
pub async fn print_to_pdf(window: WebviewWindow) -> Result<Vec<u8>, AppError> {
    use std::sync::{Arc, Mutex};
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment6, ICoreWebView2_16},
        PrintToPdfStreamCompletedHandler,
    };
    use windows::core::Interface;

    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let callback_sender = sender.clone();
    window
        .with_webview(move |webview| {
            let result = (|| -> windows::core::Result<()> {
                let environment: ICoreWebView2Environment6 = webview.environment().cast()?;
                let view: ICoreWebView2_16 =
                    unsafe { webview.controller().CoreWebView2()? }.cast()?;
                let settings = unsafe { environment.CreatePrintSettings()? };
                unsafe {
                    settings.SetPageWidth(210.0 / 25.4)?;
                    settings.SetPageHeight(297.0 / 25.4)?;
                    settings.SetMarginTop(0.0)?;
                    settings.SetMarginBottom(0.0)?;
                    settings.SetMarginLeft(0.0)?;
                    settings.SetMarginRight(0.0)?;
                    settings.SetShouldPrintBackgrounds(true)?;
                    settings.SetShouldPrintHeaderAndFooter(false)?;
                }
                let completion_sender = callback_sender.clone();
                let completed =
                    PrintToPdfStreamCompletedHandler::create(Box::new(move |status, stream| {
                        let result = status.map_err(|error| error.to_string()).and_then(|_| {
                            let stream =
                                stream.ok_or_else(|| "WebView2 未返回 PDF 数据".to_string())?;
                            let mut output = Vec::new();
                            let mut chunk = [0_u8; 65_536];
                            loop {
                                let mut read = 0_u32;
                                unsafe {
                                    stream
                                        .Read(
                                            chunk.as_mut_ptr().cast(),
                                            chunk.len() as u32,
                                            Some(&mut read),
                                        )
                                        .ok()
                                }
                                .map_err(|error| error.to_string())?;
                                if read == 0 {
                                    break;
                                }
                                if output.len() + read as usize > 48 * 1024 * 1024 {
                                    return Err("PDF 超过导出大小上限".into());
                                }
                                output.extend_from_slice(&chunk[..read as usize]);
                            }
                            if !output.starts_with(b"%PDF-") {
                                return Err("WebView2 返回的 PDF 无效".into());
                            }
                            Ok(output)
                        });
                        if let Ok(mut sender) = completion_sender.lock() {
                            if let Some(sender) = sender.take() {
                                let _ = sender.send(result);
                            }
                        }
                        Ok(())
                    }));
                unsafe {
                    view.PrintToPdfStream(&settings, &completed)?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                if let Ok(mut sender) = callback_sender.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(Err(error.to_string()));
                    }
                }
            }
        })
        .map_err(|error| {
            AppError::new(
                ErrorCode::EngineFailure,
                format!("无法启动 PDF 打印：{error}"),
                false,
            )
        })?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(120), receiver)
        .await
        .map_err(|_| AppError::new(ErrorCode::EngineFailure, "PDF 打印超时", true))?
        .map_err(|_| AppError::new(ErrorCode::EngineFailure, "PDF 打印中断", true))?;
    result.map_err(|message| AppError::new(ErrorCode::EngineFailure, message, false))
}

#[cfg(not(windows))]
pub async fn print_to_pdf(_window: WebviewWindow) -> Result<Vec<u8>, AppError> {
    Err(AppError::new(
        ErrorCode::EngineFailure,
        "当前平台不支持原版式 PDF 打印",
        false,
    ))
}
