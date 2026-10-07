//! Installed heading fonts remain on the user's system, never in the app bundle.
//! The host snapshots fixed Windows font paths; workers receive only verified bytes.
use typst::foundations::Bytes;

#[derive(Debug, Clone)]
pub struct HeadingFonts {
    pub regular: Bytes,
    pub bold: Bytes,
    pub family: &'static str,
}

fn family(bytes: &Bytes, bold: bool) -> Result<&'static str, String> {
    let face = ttf_parser::Face::parse(bytes, 0)
        .map_err(|_| "Installed heading font is not a valid font".to_owned())?;
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
        return Err("Installed heading font does not allow subset outline embedding".into());
    }
    if face.is_bold() != bold || face.is_italic() {
        return Err("Installed heading font has an unexpected style".into());
    }
    let font = typst::text::Font::new(bytes.clone(), 0)
        .ok_or("Installed heading font was rejected by Typst")?;
    match font.info().family.to_ascii_lowercase().as_str() {
        "georgia" => Ok("Georgia"),
        "times new roman" => Ok("Times New Roman"),
        _ => Err("Installed heading font has an unexpected family".into()),
    }
}

pub fn validate(regular: Bytes, bold: Bytes) -> Result<HeadingFonts, String> {
    let regular_family = family(&regular, false)?;
    if family(&bold, true)? != regular_family {
        return Err("Installed heading font styles belong to different families".into());
    }
    Ok(HeadingFonts {
        regular,
        bold,
        family: regular_family,
    })
}

#[cfg(windows)]
fn read_directory(directory: &std::path::Path) -> Option<HeadingFonts> {
    for (regular, bold, expected) in [
        ("georgia.ttf", "georgiab.ttf", "Georgia"),
        ("times.ttf", "timesbd.ttf", "Times New Roman"),
    ] {
        let read = |name: &str| -> Result<Bytes, String> {
            let path = directory.join(name);
            let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
            if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 4 * 1024 * 1024 {
                return Err("Installed heading font exceeds its size limit".into());
            }
            let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
            if bytes.len() > 4 * 1024 * 1024 {
                return Err("Installed heading font changed beyond its size limit".into());
            }
            Ok(Bytes::new(bytes))
        };
        match read(regular).and_then(|regular| read(bold).and_then(|bold| validate(regular, bold)))
        {
            Ok(fonts) if fonts.family == expected => return Some(fonts),
            Ok(_) => {
                eprintln!("Heading font {expected} has an unexpected identity; using fallback")
            }
            Err(error) => eprintln!("Heading font {expected} unavailable: {error}; using fallback"),
        }
    }
    None
}

pub fn installed() -> Option<HeadingFonts> {
    static FONTS: std::sync::OnceLock<Option<HeadingFonts>> = std::sync::OnceLock::new();
    FONTS
        .get_or_init(|| {
            #[cfg(windows)]
            {
                #[link(name = "kernel32")]
                unsafe extern "system" {
                    fn GetWindowsDirectoryW(buffer: *mut u16, size: u32) -> u32;
                }
                let mut buffer = [0u16; 32768];
                // Windows supplies the directory; no webview path, environment override or download.
                let size = unsafe { GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) }
                    as usize;
                if size == 0 || size >= buffer.len() {
                    return None;
                }
                let directory = std::path::PathBuf::from(String::from_utf16(&buffer[..size]).ok()?)
                    .join("Fonts");
                read_directory(&directory)
            }
            #[cfg(not(windows))]
            {
                None
            }
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_body_cannot_impersonate_a_system_heading_font() {
        assert!(validate(
            Bytes::new(super::super::FONT_REGULAR_BYTES),
            Bytes::new(super::super::FONT_HEAVY_BYTES)
        )
        .is_err());
        assert!(validate(Bytes::new(vec![0; 20]), Bytes::new(vec![0; 20])).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn missing_directory_has_an_explicit_bundled_fallback() {
        assert!(read_directory(&std::path::PathBuf::from(
            "Z:\\zinecv-nonexistent-font-directory"
        ))
        .is_none());
    }

    #[cfg(windows)]
    #[test]
    fn installed_fonts_reject_restricted_or_non_subsettable_embedding() {
        let fonts = installed().expect("Windows acceptance requires an installed permitted heading font; missing fonts must not silently pass this test");
        let original = fonts.regular.as_slice();
        let count = u16::from_be_bytes([original[4], original[5]]) as usize;
        let offset = (0..count)
            .find_map(|index| {
                let record = 12 + index * 16;
                (&original[record..record + 4] == b"OS/2").then(|| {
                    u32::from_be_bytes(original[record + 8..record + 12].try_into().unwrap())
                        as usize
                })
            })
            .unwrap();
        for flags in [2u16, 0x108, 0x208] {
            let mut bytes = original.to_vec();
            bytes[offset + 8..offset + 10].copy_from_slice(&flags.to_be_bytes());
            assert!(validate(Bytes::new(bytes), fonts.bold.clone()).is_err());
        }
        assert!(validate(fonts.regular.clone(), fonts.regular).is_err());
    }
}
