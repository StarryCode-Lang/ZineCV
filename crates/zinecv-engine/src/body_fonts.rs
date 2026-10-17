//! Fixed, installed Windows body-font snapshots. No system font is redistributed.
use std::sync::{Mutex, OnceLock};
use typst::foundations::Bytes;

#[derive(Debug, Clone)]
pub struct BodyFonts {
    pub regular: Bytes,
    pub bold: Bytes,
    pub family: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    YaHei,
    Hei,
    Kai,
    FangSong,
}

fn kind(id: &str) -> Option<Kind> {
    match id {
        "legacy-font:雅黑" => Some(Kind::YaHei),
        "legacy-font:黑体" => Some(Kind::Hei),
        "legacy-font:楷体" => Some(Kind::Kai),
        "legacy-font:仿宋" => Some(Kind::FangSong),
        _ => None,
    }
}

pub fn is_installed_selection(id: &str) -> bool {
    kind(id).is_some()
}

impl Kind {
    fn family(self) -> &'static str {
        match self {
            Self::YaHei => "Microsoft YaHei",
            Self::Hei => "SimHei",
            Self::Kai => "KaiTi",
            Self::FangSong => "FangSong",
        }
    }
    #[cfg(windows)]
    fn files(self) -> (&'static str, &'static str) {
        match self {
            Self::YaHei => ("msyh.ttc", "msyhbd.ttc"),
            Self::Hei => ("simhei.ttf", "simhei.ttf"),
            Self::Kai => ("simkai.ttf", "simkai.ttf"),
            Self::FangSong => ("simfang.ttf", "simfang.ttf"),
        }
    }
}

pub fn validate(id: &str, regular: Bytes, bold: Bytes) -> Result<BodyFonts, String> {
    let kind = kind(id).ok_or("Document does not select an installed body font")?;
    for (bytes, is_bold) in [(&regular, false), (&bold, kind == Kind::YaHei)] {
        if bytes.is_empty() || bytes.len() > 24 * 1024 * 1024 {
            return Err("Installed body font exceeds its size limit".into());
        }
        let face = ttf_parser::Face::parse(bytes.as_slice(), 0)
            .map_err(|_| "Invalid installed body font")?;
        if !matches!(
            face.permissions(),
            Some(
                ttf_parser::Permissions::Installable
                    | ttf_parser::Permissions::Editable
                    | ttf_parser::Permissions::PreviewAndPrint
            )
        ) || !face.is_subsetting_allowed()
            || !face.is_outline_embedding_allowed()
        {
            return Err("Installed body font does not permit subset outline embedding".into());
        }
        let font = typst::text::Font::new(bytes.clone(), 0)
            .ok_or("Installed body font rejected by Typst")?;
        if !font.info().family.eq_ignore_ascii_case(kind.family())
            || face.is_bold() != is_bold
            || face.is_italic()
        {
            return Err(
                "Installed body font identity or style differs from the document selection".into(),
            );
        }
    }
    Ok(BodyFonts {
        regular,
        bold,
        family: kind.family(),
    })
}

pub fn installed(id: &str) -> Result<Option<BodyFonts>, String> {
    let Some(selected) = kind(id) else {
        return Ok(None);
    };
    static CACHE: OnceLock<Mutex<Option<(Kind, BodyFonts)>>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Body font cache poisoned")?;
    if let Some((cached, fonts)) = cache.as_ref() {
        if *cached == selected {
            return Ok(Some(fonts.clone()));
        }
    }
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetWindowsDirectoryW(buffer: *mut u16, size: u32) -> u32;
        }
        let mut buffer = [0u16; 32768];
        // OS directory only: never consume an IPC path or environment override.
        let length =
            unsafe { GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
        if length == 0 || length >= buffer.len() {
            return Err("Windows font directory unavailable".into());
        }
        let directory = std::path::PathBuf::from(
            String::from_utf16(&buffer[..length]).map_err(|_| "Invalid Windows font directory")?,
        )
        .join("Fonts");
        let read = |name: &str| -> Result<Bytes, String> {
            let path = directory.join(name);
            let metadata = std::fs::metadata(&path)
                .map_err(|_| format!("所选字体 {} 未安装", selected.family()))?;
            if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 24 * 1024 * 1024 {
                return Err("Installed body font exceeds its size limit".into());
            }
            Ok(Bytes::new(
                std::fs::read(path).map_err(|error| error.to_string())?,
            ))
        };
        let (regular_file, bold_file) = selected.files();
        let regular = read(regular_file)?;
        let bold = if regular_file == bold_file {
            regular.clone()
        } else {
            read(bold_file)?
        };
        let fonts = validate(id, regular, bold)?;
        *cache = Some((selected, fonts.clone()));
        Ok(Some(fonts))
    }
    #[cfg(not(windows))]
    {
        let _ = &mut cache;
        Err(format!(
            "所选字体 {} 需要宿主提供字体资源",
            selected.family()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unrelated_fonts_cannot_impersonate_a_selection() {
        assert!(validate(
            "legacy-font:雅黑",
            Bytes::new(crate::FONT_REGULAR_BYTES),
            Bytes::new(crate::FONT_HEAVY_BYTES)
        )
        .is_err());
        assert!(validate(
            "legacy-font:未知",
            Bytes::new(vec![0; 20]),
            Bytes::new(vec![0; 20])
        )
        .is_err());
        assert!(installed("legacy-font:宋体").unwrap().is_none());
    }
    #[cfg(windows)]
    #[test]
    fn selected_fonts_are_cached_and_keep_the_selected_identity() {
        for id in [
            "legacy-font:雅黑",
            "legacy-font:黑体",
            "legacy-font:楷体",
            "legacy-font:仿宋",
        ] {
            let first = installed(id)
                .unwrap()
                .expect("Windows acceptance requires selected installed fonts");
            let second = installed(id).unwrap().unwrap();
            assert_eq!(first.family, kind(id).unwrap().family());
            assert_eq!(
                first.regular.as_slice().as_ptr(),
                second.regular.as_slice().as_ptr()
            );
            assert_eq!(
                first.bold.as_slice().as_ptr(),
                second.bold.as_slice().as_ptr()
            );
            if id != "legacy-font:雅黑" {
                assert_eq!(
                    first.regular.as_slice().as_ptr(),
                    first.bold.as_slice().as_ptr()
                );
            }
        }
    }
}
