fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["probe_mark", "probe_config", "probe_event", "probe_heartbeat", "probe_report"]))
            .plugin(
                "probe",
                tauri_build::InlinedPlugin::new()
                    .commands(&["mark"])
                    .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
            ),
    )
    .expect("tauri build");
}
