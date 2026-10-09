#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

#[tauri::command]
fn frontend_ready(window: tauri::Window, shown: tauri::State<Arc<AtomicBool>>) {
    if !shown.swap(true, Ordering::SeqCst) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn load_notes() -> Result<String, String> {
    let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap_or_default())
        .join("com.quicknote.app");
    let path = dir.join("notes.json");
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(_) => Ok(String::new()),
    }
}

#[tauri::command]
fn save_notes(content: String) -> Result<(), String> {
    let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap_or_default())
        .join("com.quicknote.app");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("notes.json"), &content).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        // 导出 Excel 时弹"另存为"对话框选保存位置
        .plugin(tauri_plugin_dialog::init())
        // HTTP 走 Rust 侧：WebView 内直接 fetch 云端会被 CORS 拒绝
        // （打包版 origin 是 http://tauri.localhost，不在服务端白名单），
        // plugin-http 的 fetch 由 Rust reqwest 发出，无 CORS 概念。
        .plugin(tauri_plugin_http::init())
        // 应用内自动更新：读 latest.json → 下载新包 → 校验 minisign 签名 → 静默安装
        // 全程由 Rust 侧发起，不经过 WebView，因此没有 CORS 问题。
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 更新装完后重启应用到新版本（macOS 必须显式重启；Windows 由安装器 /R 自动完成）
        .plugin(tauri_plugin_process::init())
        // 点 X / Alt+F4 不退出，改为隐藏到系统托盘
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            // 兜底：若前端因异常没调用 frontend_ready，最多等 2.5s 也要把窗口显示出来，
            // 避免用户永远看不到窗口。
            let shown = Arc::new(AtomicBool::new(false));
            let shown_for_cmd = shown.clone();
            app.manage(shown_for_cmd);

            if let Some(window) = app.get_webview_window("main") {
                let shown = shown.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(2500));
                    if !shown.swap(true, Ordering::SeqCst) {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                });
            }

            // 系统托盘：隐藏后可从托盘恢复窗口或彻底退出
            let show_i = MenuItem::with_id(app, "show", "显示 QuickNote", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            TrayIconBuilder::new()
                .icon(tauri::include_image!("icons/icon.png"))
                .tooltip("QuickNote")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            load_notes,
            save_notes
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
