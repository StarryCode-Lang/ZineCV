fn main() {
    // Derive the restricted application-command manifest from the registered
    // handlers. The main window capability explicitly grants their permissions.
    let source = include_str!("src/lib.rs");
    let handlers = source
        .split("tauri::generate_handler![")
        .nth(1)
        .expect("registered IPC handlers")
        .split(']')
        .next()
        .expect("handler list");
    let commands: Vec<&'static str> = handlers
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect();
    let commands = Box::leak(commands.into_boxed_slice());
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("Tauri application permissions and build");
}
