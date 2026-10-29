//! Typst 排版引擎已按 C+ 目标架构抽取为独立 crate（P2，见
//! `docs/ARCHITECTURE_TARGET_CPLUS.md`）：
//!
//! - `crates/zinecv-engine`：官方 Typst crates、三模板（templates.typ 随迁）、
//!   TextMap/HitRegion、一页求解、统一 PDF/PNG 导出、内置字体字节
//!   （zero-copy `'static` 静态，现转 pub 供宿主资源清单/协议共享）。
//!
//! 本文件只是再出口垫片：glob 再出口 crate 根全部公开项（含 export/fit/
//! system_fonts 公开子模块），保持 `crate::engine::*` 与
//! `zinecv_desktop_lib::engine::*` 既有引用路径不变——render_worker、
//! storage、font_protocol、lib 与受保护示例均零改动。

pub use zinecv_engine::*;
