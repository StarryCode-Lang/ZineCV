use super::*;

fn test_target() -> UpdaterTargetInfo {
    UpdaterTargetInfo {
        version: "9.9.9".into(),
        notes: None,
        pub_date: None,
        cached: true,
    }
}

fn test_downloading() -> UpdaterStatus {
    UpdaterStatus::Downloading {
        current_version: "1.0.0".into(),
        target: test_target(),
        received: 0.0,
        total: None,
    }
}

#[test]
fn install_gate_rechecks_exports_admitted_after_initial_settle() {
    let manager = UpdaterManager::new(&std::env::temp_dir());
    *manager.0.phase.lock().unwrap() = UpdaterStatus::ReadyToInstall {
        current_version: "1.0.0".into(),
        target: test_target(),
        received: 42.0,
    };
    // The initial settle observed zero, then a new export was admitted
    // while cache verification ran. The final locked gate must refuse it.
    assert_eq!(manager.0.export_flight.load(Ordering::SeqCst), 0);
    let export = ExportFlightGuard::acquire(&manager).unwrap();
    {
        let mut phase = manager.0.phase.lock().unwrap();
        assert!(transition_phase_locked(&mut phase, |phase| install_phase(
            phase,
            &test_target(),
            "1.0.0",
            manager.0.export_flight.load(Ordering::SeqCst),
        ))
        .is_err());
    }
    drop(export);
    {
        let mut phase = manager.0.phase.lock().unwrap();
        assert!(transition_phase_locked(&mut phase, |phase| install_phase(
            phase,
            &test_target(),
            "1.0.0",
            manager.0.export_flight.load(Ordering::SeqCst),
        ))
        .is_ok());
    }
    assert!(ExportFlightGuard::acquire(&manager).is_err());
    assert_eq!(manager.0.export_flight.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn cancel_before_download_handle_publication_aborts_the_late_task() {
    let manager = UpdaterManager::new(&std::env::temp_dir());
    manager.0.download_generation.store(1, Ordering::SeqCst);
    *manager.0.phase.lock().unwrap() = test_downloading();
    {
        let mut phase = manager.0.phase.lock().unwrap();
        let (_, abort) = manager
            .0
            .cancel_download_locked(&mut phase, "1.0.0".into())
            .unwrap();
        assert!(abort.is_none());
    }
    let task = tokio::spawn(std::future::pending::<()>());
    manager.0.register_download(1, task.abort_handle());
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(manager.0.download_task.lock().unwrap().is_none());
    assert!(!manager.0.download_is_current(1, &test_downloading()));
}

#[tokio::test(flavor = "current_thread")]
async fn retired_cancelled_download_cannot_clear_new_download_handle() {
    let manager = UpdaterManager::new(&std::env::temp_dir());
    manager.0.download_generation.store(1, Ordering::SeqCst);
    *manager.0.phase.lock().unwrap() = test_downloading();
    let old = tokio::spawn(std::future::pending::<()>());
    manager.0.register_download(1, old.abort_handle());
    let abort = {
        let mut phase = manager.0.phase.lock().unwrap();
        manager
            .0
            .cancel_download_locked(&mut phase, "1.0.0".into())
            .unwrap()
            .1
            .unwrap()
    };
    abort.abort();
    assert!(old.await.unwrap_err().is_cancelled());
    manager.0.download_generation.store(3, Ordering::SeqCst);
    *manager.0.phase.lock().unwrap() = test_downloading();
    let new = tokio::spawn(std::future::pending::<()>());
    manager.0.register_download(3, new.abort_handle());
    manager.0.retire_download(1);
    assert_eq!(
        manager.0.download_task.lock().unwrap().as_ref().unwrap().0,
        3
    );
    assert!(!manager.0.download_is_current(1, &test_downloading()));
    assert!(manager.0.download_is_current(3, &test_downloading()));
    new.abort();
    assert!(new.await.unwrap_err().is_cancelled());
    manager.0.retire_download(3);
}

#[test]
fn cached_payload_and_matching_rewritten_hash_still_require_a_trusted_signature() {
    // Public fixture signed with an isolated test key, never a production key.
    const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEVDQzZBNkUyQkFEQUJGMUIKUldRYnY5cTY0cWJHN0l6cEFrUG1zN2RXWExWMDJPM2tFcS9Mc3VrcnpiS3ErRzhKQzNlb3AzMTQK";
    const SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRYnY5cTY0cWJHN0M0MENEbG8vQ01PcFJZeGFGV2ZwSGlpbE1rc0xQYjEyN3ZkSytEZWs0eERnSVdhVU1NVVB6R3JjWGd3RWx5THFSUEdoMDVRb0VFcXR6K1Y5Wm1ndXdNPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyODQ4NjMxCWZpbGU6Y2FjaGUtc2lnbmF0dXJlLWZpeHR1cmUuYmluCXZlcnNpb246OS45LjkKeXBXdWxLVnBZa3duVW9keldncFhCZjlmVHM2aU5XL2NsY1Y1SDZKNXkvejBVdmRpTEplaE85Q0swWnlMeHZOemMzVWlIMmt3NUpZZkU4cVVSRE94Q3c9PQo=";
    let original = b"ZineCV cache authentication regression fixture";
    verify_cached_signature(original, SIGNATURE, PUBKEY, "9.9.9").unwrap();
    assert!(verify_cached_signature(original, SIGNATURE, PUBKEY, "10.0.0").is_err());
    let tampered = b"attacker replaced executable and metadata together";
    let mut meta = CachedUpdateMeta {
        version: "9.9.9".into(),
        notes: None,
        pub_date: None,
        file: "9.9.9.exe".into(),
        received: original.len() as u64,
        sha256: format!("{:x}", Sha256::digest(original)),
        saved_at: "1".into(),
    };
    meta.sha256 = format!("{:x}", Sha256::digest(tampered));
    meta.received = tampered.len() as u64;
    assert_eq!(format!("{:x}", Sha256::digest(tampered)), meta.sha256);
    assert!(verify_cached_signature(tampered, SIGNATURE, PUBKEY, &meta.version).is_err());
}
#[test]
fn cache_meta_roundtrip_and_path_safety() {
    let dir = std::env::temp_dir().join(format!("zinecv-updater-test-{}", std::process::id()));
    let manager = UpdaterManager::new(&dir);
    let meta = CachedUpdateMeta {
        version: "2.0.0-alpha.2".into(),
        notes: Some("说明".into()),
        pub_date: None,
        file: "2.0.0-alpha.2.exe".into(),
        received: 42,
        sha256: format!("{:x}", Sha256::digest(b"payload")),
        saved_at: "1".into(),
    };
    manager.0.write_cached(&meta, b"payload").unwrap();
    let loaded = manager.0.read_cached_meta().expect("cache restored");
    assert_eq!(loaded.version, "2.0.0-alpha.2");
    assert_eq!(
        manager.0.read_cached_bytes(&loaded).as_deref(),
        Some(b"payload".as_slice())
    );
    // 新版本缓存写入后旧缓存被清理，目录里只剩一份。
    let newer = CachedUpdateMeta {
        version: "2.0.0-alpha.3".into(),
        notes: None,
        pub_date: None,
        file: "2.0.0-alpha.3.exe".into(),
        received: 7,
        sha256: format!("{:x}", Sha256::digest(b"next")),
        saved_at: "2".into(),
    };
    manager.0.write_cached(&newer, b"next").unwrap();
    assert_eq!(
        manager.0.read_cached_meta().unwrap().version,
        "2.0.0-alpha.3"
    );
    // file_name() 剥掉目录组件后一切输入都被限制在缓存目录内，不可逃逸。
    let confined = manager.0.payload_path("../escape.exe");
    assert_eq!(
        confined.as_ref().and_then(|path| path.parent()),
        Some(manager.0.cache_dir.as_path())
    );
    let nested = manager.0.payload_path("sub/dir/file.exe");
    assert_eq!(
        nested.as_ref().and_then(|path| path.parent()),
        Some(manager.0.cache_dir.as_path())
    );
    assert!(manager.0.metadata_path("").is_none());
    manager.0.clear_cache();
    assert!(manager.0.read_cached_meta().is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn semver_newer_respects_prerelease_order() {
    assert!(remote_is_newer("2.0.0-alpha.1", "2.0.0-alpha.0"));
    assert!(remote_is_newer("2.0.0", "2.0.0-alpha.9"));
    assert!(!remote_is_newer("2.0.0-alpha.0", "2.0.0-alpha.0"));
    assert!(!remote_is_newer("2.0.0-alpha.0", "2.0.0-alpha.1"));
    assert!(!remote_is_newer("not-a-version", "2.0.0-alpha.0"));
}

#[test]
fn gate_transition_is_atomic_and_single_shot() {
    // check/download/install 的"判断并置位"共用 transition_phase_locked：
    // 置位后第二个并发请求看到的是新状态，读后写窗口不存在。
    let target = UpdaterTargetInfo {
        version: "2.0.0-alpha.2".into(),
        notes: None,
        pub_date: None,
        cached: true,
    };
    let mut phase = UpdaterStatus::Available {
        current_version: "2.0.0-alpha.1".into(),
        target: target.clone(),
    };
    let begin_download = |phase: &UpdaterStatus| match phase {
        UpdaterStatus::Available { target, .. } => Some(UpdaterStatus::Downloading {
            current_version: "2.0.0-alpha.1".into(),
            target: target.clone(),
            received: 0.0,
            total: None,
        }),
        _ => None,
    };
    // 第一次置位成功；紧随其后的第二个请求（已置 Downloading）被拒。
    assert!(matches!(
        transition_phase_locked(&mut phase, begin_download),
        Ok(UpdaterStatus::Downloading { .. })
    ));
    assert!(matches!(
        transition_phase_locked(&mut phase, begin_download),
        Err(UpdaterStatus::Downloading { .. })
    ));
    // installing 前摇期间一切常规转换被拒（回退只能走 retract）。
    let begin_install = |phase: &UpdaterStatus| match phase {
        UpdaterStatus::ReadyToInstall { target, .. } if target.version == "2.0.0-alpha.2" => {
            Some(UpdaterStatus::Installing {
                current_version: "2.0.0-alpha.1".into(),
                target: target.clone(),
            })
        }
        _ => None,
    };
    phase = UpdaterStatus::ReadyToInstall {
        current_version: "2.0.0-alpha.1".into(),
        target,
        received: 42.0,
    };
    assert!(matches!(
        transition_phase_locked(&mut phase, begin_install),
        Ok(UpdaterStatus::Installing { .. })
    ));
    assert!(matches!(
        transition_phase_locked(&mut phase, begin_install),
        Err(UpdaterStatus::Installing { .. })
    ));
    // 非 installing 状态经 set_status 语义的常规转换不受 retract 影响；
    // retract 只从 installing 回退。
    let ready = UpdaterStatus::ReadyToInstall {
        current_version: "2.0.0-alpha.1".into(),
        target: UpdaterTargetInfo {
            version: "2.0.0-alpha.2".into(),
            notes: None,
            pub_date: None,
            cached: true,
        },
        received: 42.0,
    };
    assert!(retract_phase_locked(&mut phase, ready.clone()));
    assert!(matches!(phase, UpdaterStatus::ReadyToInstall { .. }));
    // 已经回退后再 retract 不生效，避免覆盖后续新状态。
    assert!(!retract_phase_locked(
        &mut phase,
        UpdaterStatus::Idle {
            current_version: "2.0.0-alpha.1".into()
        }
    ));
    assert!(matches!(phase, UpdaterStatus::ReadyToInstall { .. }));
}

#[test]
fn status_serializes_camel_case_with_phase_tag() {
    let payload = serde_json::to_value(UpdaterStatus::UpToDate {
        current_version: "2.0.0-alpha.0".into(),
    })
    .unwrap();
    assert_eq!(payload["phase"], "upToDate");
    assert_eq!(payload["currentVersion"], "2.0.0-alpha.0");
    let downloading = serde_json::to_value(UpdaterStatus::Downloading {
        current_version: "2.0.0-alpha.0".into(),
        target: UpdaterTargetInfo {
            version: "2.0.0-alpha.1".into(),
            notes: None,
            pub_date: None,
            cached: false,
        },
        received: 128.0,
        total: None,
    })
    .unwrap();
    assert_eq!(downloading["phase"], "downloading");
    assert_eq!(downloading["total"], serde_json::Value::Null);
}
