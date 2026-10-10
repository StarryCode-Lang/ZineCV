//! Read-only font transport. The renderer and WebView borrow the same embedded bytes.
use std::borrow::Cow;

use tauri::http::{header, Method, Request, Response, StatusCode};

use crate::engine::{FONT_HEAVY_BYTES, FONT_HEBREW_BYTES, FONT_ICON_BYTES, FONT_REGULAR_BYTES};

pub(crate) fn respond(
    webview_label: &str,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    let allowed_origin = origin.filter(|value| {
        matches!(
            *value,
            "http://tauri.localhost" | "https://tauri.localhost" | "tauri://localhost"
        ) || (cfg!(debug_assertions) && *value == "http://127.0.0.1:5174")
    });
    let (status, mime, bytes) = if webview_label != "main"
        || (origin.is_some() && allowed_origin.is_none())
    {
        (StatusCode::FORBIDDEN, "text/plain", &b"Forbidden"[..])
    } else if request.method() != Method::GET && request.method() != Method::HEAD {
        (
            StatusCode::METHOD_NOT_ALLOWED,
            "text/plain",
            &b"Method not allowed"[..],
        )
    } else if request.uri().query().is_some()
        || !matches!(
            request.uri().host(),
            Some("localhost" | "zinecv-font.localhost")
        )
    {
        (StatusCode::NOT_FOUND, "text/plain", &b"Not found"[..])
    } else {
        match request.uri().path() {
            "/source-han-serif-cn-regular.otf" => (StatusCode::OK, "font/otf", FONT_REGULAR_BYTES),
            "/source-han-serif-cn-heavy.ttf" => (StatusCode::OK, "font/ttf", FONT_HEAVY_BYTES),
            "/noto-sans-hebrew-regular.ttf" => (StatusCode::OK, "font/ttf", FONT_HEBREW_BYTES),
            "/wondercv-iconfont.ttf" => (StatusCode::OK, "font/ttf", FONT_ICON_BYTES),
            _ => (StatusCode::NOT_FOUND, "text/plain", &b"Not found"[..]),
        }
    };
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, bytes.len())
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .header("X-Content-Type-Options", "nosniff")
        .header(header::VARY, "Origin");
    if let Some(origin) = allowed_origin {
        builder = builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    builder
        .body(Cow::Borrowed(if request.method() == Method::HEAD {
            &[] as &[u8]
        } else {
            bytes
        }))
        .expect("fixed font response headers are valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fonts_borrow_the_engine_bytes_and_only_allow_fixed_paths() {
        for (file, expected, mime) in [
            (
                "source-han-serif-cn-regular.otf",
                FONT_REGULAR_BYTES,
                "font/otf",
            ),
            (
                "source-han-serif-cn-heavy.ttf",
                FONT_HEAVY_BYTES,
                "font/ttf",
            ),
            ("wondercv-iconfont.ttf", FONT_ICON_BYTES, "font/ttf"),
            (
                "noto-sans-hebrew-regular.ttf",
                FONT_HEBREW_BYTES,
                "font/ttf",
            ),
        ] {
            let response = respond(
                "main",
                Request::builder()
                    .uri(format!("zinecv-font://localhost/{file}"))
                    .body(vec![])
                    .unwrap(),
            );
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_TYPE], mime);
            assert_eq!(response.body().as_ptr(), expected.as_ptr());
            assert_eq!(response.body().as_ref(), expected);
        }
        for path in [
            "/../secret",
            "/%2e%2e/secret",
            "/fonts/source-han-serif-cn-heavy.ttf",
            "/wondercv-iconfont.ttf?path=secret",
            "/secret",
        ] {
            let response = respond(
                "main",
                Request::builder()
                    .uri(format!("zinecv-font://localhost{path}"))
                    .body(vec![])
                    .unwrap(),
            );
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }
    }

    #[test]
    fn transport_restricts_origin_window_and_method() {
        let request = || Request::builder().uri("zinecv-font://localhost/wondercv-iconfont.ttf");
        assert_eq!(
            respond("other", request().body(vec![]).unwrap()).status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            respond(
                "main",
                request()
                    .header(header::ORIGIN, "https://example.com")
                    .body(vec![])
                    .unwrap()
            )
            .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            respond("main", request().method(Method::POST).body(vec![]).unwrap()).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(
            respond(
                "main",
                Request::builder()
                    .uri("zinecv-font://other/wondercv-iconfont.ttf")
                    .body(vec![])
                    .unwrap()
            )
            .status(),
            StatusCode::NOT_FOUND
        );
        let response = respond(
            "main",
            request()
                .header(header::ORIGIN, "http://tauri.localhost")
                .method(Method::HEAD)
                .body(vec![])
                .unwrap(),
        );
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.body().is_empty());
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "http://tauri.localhost"
        );
    }
}
