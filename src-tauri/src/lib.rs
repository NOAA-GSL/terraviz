// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// Tauri app entry point — shared between desktop and mobile (iOS / Android).
// Desktop launches via `main.rs` which calls `run()`; mobile launches via the
// `mobile_entry_point` macro below, which the OS-native host (Android JNI or
// iOS Swift shell) loads as a cdylib symbol.

mod download_commands;
mod download_manager;
mod keychain;
mod tile_cache;

use base64::Engine;
use download_manager::DownloadManager;
use serde::Serialize;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tile_cache::TileCache;

/// Payload emitted on the `native_panic` event when the Rust panic hook
/// fires. Mirrors the shape that
/// `src/analytics/errorCapture.ts`'s listener expects. Kept minimal on
/// purpose — the JS sanitizer (URL / email / digit / file-path
/// stripping) runs on the message before any analytics event is
/// emitted, so passing the raw text here is fine.
#[derive(Debug, Clone, Serialize)]
struct NativePanicPayload {
    /// Best-effort panic message string. Falls back to `"<unknown
    /// panic>"` when the payload isn't a `&str` / `String`.
    message: String,
    /// `file:line` of the panic site, when available. None for panics
    /// without a captured location (rare in practice).
    location: Option<String>,
}

#[tauri::command]
async fn get_tile(
    tile_path: String,
    state: tauri::State<'_, Arc<TileCache>>,
) -> Result<String, String> {
    let bytes = state
        .get_tile(&tile_path)
        .await
        .map_err(|e| e.to_string())?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Dev-only command for the plan's native-panic acceptance check
/// ("force a Rust panic in a dev build, watch a sanitized event
/// appear in the stream"). Always present in the handler list so
/// the macro expansion is stable across build profiles, but the
/// panic body is gated to debug builds. In release this is a
/// no-op — the JS side calling it gets a successful invocation
/// with no observable effect.
#[tauri::command]
fn __dev_force_panic() {
    #[cfg(debug_assertions)]
    {
        panic!("dev-only forced panic for testing native_panic event");
    }
}

/// Exit the application.
///
/// Exists for the keyboard quit a kiosk window has no other way to
/// reach (`docs/MULTI_MONITOR_PLAN.md` §3.6, rung 9 step 29). Launched
/// with `--kiosk` the main window is fullscreen and decorationless, so
/// there is no close button and no title bar to right-click; Alt+F4 is
/// a Windows answer and the checklist asks for Ctrl+Q everywhere.
///
/// A command rather than `tauri-plugin-process` because this is the
/// only thing the app would use that plugin for, and rather than a
/// menu accelerator because a window with no menu bar — which is what
/// kiosk mode is — does not reliably fire one.
///
/// **Who may call it is not decided by the capability split**, and this
/// paragraph used to say the opposite. Tauri's ACL gates *plugin*
/// commands (`plugin:window|...`, `plugin:http|...`); an app-defined
/// command is checked only when the app ships an ACL manifest of its
/// own, and this one does not — `build.rs` is a bare
/// `tauri_build::build()` and there is no `src-tauri/permissions/`
/// directory, so `has_app_acl_manifest` is false and the gate in
/// `tauri::webview` (`plugin_command.is_some() || has_app_acl_manifest
/// || !is_local`) is false for every local caller. Withholding
/// `core:default` from `capabilities/output.json` therefore buys
/// nothing here: an output window can reach this command, and the
/// keychain and download commands beside it. Narrowing that means
/// giving the app a permission manifest and granting each command
/// explicitly, which is its own change and is written up in
/// `docs/MULTI_MONITOR_PLAN.md` §6. The `windowChrome` hotkey is wired
/// only in the control window, which is a convention rather than a
/// boundary.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Destroy the window that called this.
///
/// The one thing an output window invokes, and it exists so that
/// `core:window:allow-destroy` can stay out of
/// `capabilities/output.json`.
///
/// Registering `onCloseRequested` moves completion of the close into
/// JS: `@tauri-apps/api`'s helper awaits the handler and then calls
/// `destroy()` on the window unless the handler called
/// `preventDefault()`. That call is ACL-checked against the *output*,
/// so granting `allow-close` alone made every output unclosable —
/// Remove, Alt+F4 and all — with the denial happening inside Tauri's
/// own listener callback where nothing in this repo can observe it.
/// Granting `allow-destroy` fixed that and handed a compromised output
/// rather more than it needed: neither `close` nor `destroy` is scoped
/// to the calling window, so an output could tear down the control
/// window or a sibling — and `destroy` skips the sibling's own
/// `onCloseRequested`, which is precisely what makes the manager read a
/// departure as a *crash* (three of those blocklist a working monitor
/// for the session).
///
/// **This takes no label.** Tauri supplies the calling window, so there
/// is no target argument to forge and an output can only ever destroy
/// itself. The output's close handler calls `preventDefault()` and
/// invokes this instead of letting the helper's `destroy()` run.
#[tauri::command]
fn close_self<R: tauri::Runtime>(window: tauri::Window<R>) {
    // Swallowed like the kiosk failures below: the window is on its way
    // out and there is no surface left to report to. A failure here is
    // visible as the window simply not closing.
    if let Err(err) = window.destroy() {
        eprintln!("[output] could not destroy {}: {err}", window.label());
    }
}

/// CLI flag and environment variable that launch straight into kiosk
/// mode (`docs/MULTI_MONITOR_PLAN.md` §3.6 mechanism 3).
///
/// Two paths for one thing because they serve different launchers: a
/// `.desktop` autostart entry or a systemd unit sets an environment
/// variable naturally, while a wrapper script or a manual launch passes
/// a flag. Neither can drive a runtime keystroke, which is the whole
/// reason this is read at startup rather than left to the F11 handler.
#[cfg(desktop)]
const KIOSK_FLAG: &str = "--kiosk";
#[cfg(desktop)]
const KIOSK_ENV: &str = "TERRAVIZ_KIOSK";

/// Whether this launch asked for kiosk mode.
///
/// Takes its inputs rather than reading the process, so the parsing
/// rules below are testable without spawning a binary.
///
/// **A set variable is not a true one.** `TERRAVIZ_KIOSK=0` and
/// `TERRAVIZ_KIOSK=` both mean *off*: an installation that sets the
/// variable explicitly to disable kiosk — which is exactly what a
/// deployment script templating one unit file for several machines
/// does — must not get a decorationless fullscreen window instead. So
/// the value is matched against an allowlist rather than tested for
/// presence.
#[cfg(desktop)]
fn kiosk_requested<I: IntoIterator<Item = String>>(args: I, env: Option<String>) -> bool {
    if args.into_iter().any(|arg| arg == KIOSK_FLAG) {
        return true;
    }
    matches!(
        env.as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// Put the main window into kiosk shape: fullscreen, no decorations.
///
/// Applied in `setup()`, which is the earliest point an `AppHandle`
/// exists — so "before the first paint" is best-effort rather than
/// guaranteed. The alternative, declaring it in `tauri.conf.json`, is
/// static and cannot be conditional on a flag.
///
/// A failure is logged and swallowed. An operator who asked for kiosk
/// and got a windowed app has a cosmetic problem; one whose unattended
/// installation refused to boot has an outage.
#[cfg(desktop)]
fn apply_kiosk(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[kiosk] no main window to put into kiosk mode");
        return;
    };
    if let Err(err) = window.set_fullscreen(true) {
        eprintln!("[kiosk] could not go fullscreen: {err}");
        // Deliberately not dropping the decorations after a failed
        // fullscreen: that leaves an undecorated *windowed* app the
        // operator cannot move, resize or close, which is worse than
        // the title bar this was trying to remove. Same ordering rule
        // as `windowChrome.ts` on the TypeScript side.
        return;
    }
    if let Err(err) = window.set_decorations(false) {
        eprintln!("[kiosk] could not drop the window decorations: {err}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `mut` is only meaningful on desktop, where the cfg block below reassigns
    // `builder` to add the updater plugin. On mobile that block is cfg'd out
    // and the binding is never reassigned.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init())
        // Phase 4: Apple Intelligence on-device LLM. On non-iOS platforms the
        // plugin's commands return "not available" gracefully; the JS provider
        // checks availability and falls back to HTTP automatically.
        .plugin(tauri_plugin_apple_intelligence::init());

    // The updater plugin is desktop-only — App Store and Play Store handle
    // updates on iOS and Android. See docs/MOBILE_APP_PLAN.md.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .setup(|app| {
            // Panic hook — forwards every Rust panic to the JS error
            // capture pipeline as a `native_panic` event. The default
            // hook runs first so Tauri's existing log behaviour (and
            // any process-level panic handler from cargo / OS) keeps
            // working unchanged. Installed inside setup() because we
            // need a clone of the AppHandle for `emit()`; before
            // setup, no app handle exists.
            let panic_emit_handle = app.handle().clone();
            let default_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |panic_info| {
                // Default hook first — preserves stderr/log output.
                default_hook(panic_info);

                // Best-effort message extraction. Rust's panic
                // payloads are commonly &str (panic!("...")) or
                // String (panic!("{}", x)); anything else (custom
                // panic types via panic_any) collapses to a marker.
                let message = panic_info
                    .payload()
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_string())
                    .or_else(|| panic_info.payload().downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "<unknown panic>".to_string());

                let location = panic_info
                    .location()
                    .map(|loc| format!("{}:{}", loc.file(), loc.line()));

                let payload = NativePanicPayload { message, location };
                // Best-effort emit — if the JS side isn't listening
                // (window not yet created, app shutting down) this
                // silently no-ops. The default hook above already
                // logged for human readers.
                let _ = panic_emit_handle.emit("native_panic", &payload);
            }));

            let app_data = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data directory");
            let cache_dir = app_data.join("tiles");
            std::fs::create_dir_all(&cache_dir).expect("failed to create tile cache directory");

            let tile_cache = Arc::new(TileCache::new(cache_dir));
            app.manage(tile_cache);

            let dataset_dir = app_data.join("datasets");
            std::fs::create_dir_all(&dataset_dir)
                .expect("failed to create dataset download directory");
            let download_manager = Arc::new(DownloadManager::new(dataset_dir));
            app.manage(download_manager);

            // Kiosk launch (§3.6 mechanism 3). Desktop-gated because
            // this file also compiles into the iOS/Android cdylib,
            // where argv flags and a decorationless fullscreen toggle
            // mean nothing — an ungated version would be dead weight at
            // best and a build break at worst.
            #[cfg(desktop)]
            if kiosk_requested(std::env::args(), std::env::var(KIOSK_ENV).ok()) {
                apply_kiosk(app.handle());
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_tile,
            keychain::get_api_key,
            keychain::set_api_key,
            download_commands::download_dataset,
            download_commands::cancel_download,
            download_commands::list_downloads,
            download_commands::get_download,
            download_commands::delete_download,
            download_commands::get_download_path,
            download_commands::get_downloads_size,
            download_commands::is_downloading,
            quit_app,
            close_self,
            __dev_force_panic,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn flag_turns_kiosk_on() {
        assert!(kiosk_requested(args(&["terraviz", "--kiosk"]), None));
    }

    #[test]
    fn no_flag_and_no_env_is_off() {
        assert!(!kiosk_requested(args(&["terraviz"]), None));
    }

    #[test]
    fn a_similar_flag_is_not_the_flag() {
        assert!(!kiosk_requested(args(&["terraviz", "--kiosk-mode"]), None));
        assert!(!kiosk_requested(args(&["terraviz", "kiosk"]), None));
    }

    #[test]
    fn truthy_env_values_turn_kiosk_on() {
        for value in ["1", "true", "TRUE", "Yes", "on", " 1 "] {
            assert!(
                kiosk_requested(args(&["terraviz"]), Some(value.to_string())),
                "expected {value:?} to enable kiosk"
            );
        }
    }

    #[test]
    fn a_set_variable_is_not_a_true_one() {
        // The trap this allowlist exists for: a deployment templating
        // one unit file across several machines sets TERRAVIZ_KIOSK=0
        // to *disable* kiosk on the ones with a keyboard. Testing for
        // presence would hand those a decorationless fullscreen window.
        for value in ["0", "", "false", "no", "off", "maybe"] {
            assert!(
                !kiosk_requested(args(&["terraviz"]), Some(value.to_string())),
                "expected {value:?} to leave kiosk off"
            );
        }
    }

    #[test]
    fn the_flag_wins_over_a_falsy_env() {
        // An operator adding --kiosk to one launch is making a decision
        // now; the environment is the installation's default.
        assert!(kiosk_requested(
            args(&["terraviz", "--kiosk"]),
            Some("0".to_string())
        ));
    }
}

/// Does an `output-*` window have what `close_self` needs, and has it
/// stopped having what it must not?
///
/// Neither half is readable off `capabilities/output.json` alone, which
/// is why these run rather than being argued in a comment. An app
/// command needs no permission entry at all — Tauri's ACL gates
/// *plugin* commands, and app-defined ones only when the app ships a
/// permission manifest of its own, which this app does not — while
/// `plugin:window|destroy` does need one and no longer has it. Getting
/// the first half wrong puts a window on a projector that cannot be
/// closed by any means; getting the second wrong hands a compromised
/// output the ability to destroy the control window or a sibling.
///
/// `generate_context!()` embeds the ACL resolved from the real
/// `capabilities/` directory and `get_ipc_response` puts the request
/// through the same `RuntimeAuthority` a packaged build uses, so these
/// are the shipped files being exercised, not a restatement of them.
#[cfg(all(test, desktop))]
mod acl_tests {
    use super::*;
    use tauri::test::{mock_builder, MockRuntime, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    fn app() -> tauri::App<MockRuntime> {
        mock_builder()
            // `close_self` alone: it is the only command under test, and
            // `quit_app` takes a non-generic `AppHandle` (i.e. `AppHandle<Wry>`),
            // which no `MockRuntime` app can supply.
            .invoke_handler(tauri::generate_handler![close_self])
            .build(tauri::generate_context!())
            .expect("failed to build the mock app")
    }

    fn request(cmd: &str) -> InvokeRequest {
        InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::default(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        }
    }

    fn window(
        app: &tauri::App<MockRuntime>,
        label: &str,
    ) -> tauri::WebviewWindow<MockRuntime> {
        tauri::WebviewWindowBuilder::new(app, label, Default::default())
            .build()
            .expect("failed to build the window")
    }

    #[test]
    fn an_output_can_close_itself() {
        let app = app();
        let output = window(&app, "output-1");
        assert!(
            tauri::test::get_ipc_response(&output, request("close_self")).is_ok(),
            "an output must be able to invoke close_self, or it cannot be closed at all"
        );
    }

    #[test]
    fn an_output_cannot_destroy_another_window() {
        let app = app();
        let output = window(&app, "output-1");
        let err = tauri::test::get_ipc_response(&output, request("plugin:window|destroy"))
            .expect_err("an output must not hold the generic window destroy");
        let message = err.to_string();
        assert!(
            message.contains("not allowed"),
            "expected an ACL rejection, got: {message}"
        );
    }

    #[test]
    fn the_control_window_keeps_the_generic_destroy() {
        // The manager tears an output down with it, so removing the
        // grant from `output.json` must not have reached `default.json`.
        // A missing `label` argument fails *after* the ACL, so the
        // distinction being asserted is the rejection text, not success.
        let app = app();
        let main = window(&app, "main");
        if let Err(err) = tauri::test::get_ipc_response(&main, request("plugin:window|destroy")) {
            let message = err.to_string();
            assert!(
                !message.contains("not allowed"),
                "the control window lost the destroy grant: {message}"
            );
        }
    }
}
