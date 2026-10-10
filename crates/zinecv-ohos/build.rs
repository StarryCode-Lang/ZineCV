fn main() {
    println!("cargo:rerun-if-changed=src/napi.c");
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("ohos") {
        cc::Build::new()
            .cargo_metadata(false)
            .file("src/napi.c")
            .compile("zinecv_napi");
        println!(
            "cargo:rustc-link-search=native={}",
            std::env::var("OUT_DIR").unwrap()
        );
        println!("cargo:rustc-link-lib=static:+whole-archive=zinecv_napi");
        println!("cargo:rustc-link-lib=ace_napi.z");
    }
}
