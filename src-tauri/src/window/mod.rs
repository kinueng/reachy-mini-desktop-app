use tauri::{AppHandle, Manager};

/// Apply transparent titlebar + full-size content view on a macOS NSWindow.
/// No-op on other platforms.
#[cfg(target_os = "macos")]
pub fn setup_transparent_titlebar(window: &tauri::WebviewWindow) {
    use cocoa::base::{id, YES};
    use objc::{msg_send, sel, sel_impl};

    if let Ok(ns_window_ptr) = window.ns_window() {
        unsafe {
            let ns_window = ns_window_ptr as id;
            let _: () = msg_send![ns_window, setTitlebarAppearsTransparent: YES];
            let style_mask: u64 = msg_send![ns_window, styleMask];
            let new_style = style_mask | (1 << 15); // NSWindowStyleMaskFullSizeContentView
            let _: () = msg_send![ns_window, setStyleMask: new_style];
        }
    }
}

#[tauri::command]
pub fn apply_transparent_titlebar(_app: AppHandle, _window_label: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(window) = _app.get_webview_window(&_window_label) {
            setup_transparent_titlebar(&window);
            Ok(())
        } else {
            Err(format!("Window '{}' not found", _window_label))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

#[tauri::command]
pub fn close_window(app: AppHandle, window_label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&window_label) {
        // Use close() method - this should work for WebviewWindow
        window
            .close()
            .map_err(|e| format!("Failed to close window '{}': {}", window_label, e))?;
        log::info!("Window '{}' closed successfully", window_label);
    } else {
        return Err(format!("Window '{}' not found", window_label));
    }
    Ok(())
}
