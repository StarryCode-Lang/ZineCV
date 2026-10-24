fn main() {
    // test-hooks 会让运行时环境变量完全覆盖更新信任链（HTTP 端点 + 任意
    // 公钥），这类构建绝不能作为正式发布外发。release 形态（含继承
    // release 的自定义 profile）默认直接编译失败；仅本地更新闭环 e2e
    // （.artifacts/updater-test/build.ps1）与故障注入 worker
    // （tools/build-receipt.mjs build:native-hooks）显式设置
    // ZINECV_ALLOW_TEST_HOOKS_RELEASE=1 放行，产物隔离命名不外发。
    if std::env::var("CARGO_FEATURE_TEST_HOOKS").is_ok()
        && std::env::var("PROFILE").as_deref() == Ok("release")
        && std::env::var("ZINECV_ALLOW_TEST_HOOKS_RELEASE").as_deref() != Ok("1")
    {
        panic!("test-hooks is not allowed in release-profile builds (ZINECV_ALLOW_TEST_HOOKS_RELEASE=1 is reserved for isolated local updater e2e / fault-injection worker builds)");
    }
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
        // generate_handler! 允许模块路径（如 app_update::app_update_state），
        // 但 IPC 命令名与 ACL 权限只用函数短名；模块路径进入权限文件名会在
        // Windows 上撞上非法的 `::` 字符。
        .map(|name| name.rsplit("::").next().unwrap_or(name))
        .collect();
    let commands = Box::leak(commands.into_boxed_slice());
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("Tauri application permissions and build");
}
