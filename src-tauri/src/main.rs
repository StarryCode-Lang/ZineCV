#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args_os();
    let _executable = args.next();
    if args.next().as_deref()
        == Some(std::ffi::OsStr::new(
            zinecv_desktop_lib::render_worker::WORKER_SWITCH,
        ))
    {
        let generation = args
            .next()
            .and_then(|value| value.to_str().and_then(|value| value.parse::<u64>().ok()));
        if args.next().is_some() || generation.is_none() || generation == Some(0) {
            std::process::exit(64);
        }
        std::process::exit(zinecv_desktop_lib::render_worker::run_worker_mode(
            generation.unwrap(),
        ));
    }
    zinecv_desktop_lib::run()
}
