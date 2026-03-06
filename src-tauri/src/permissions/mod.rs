//! Module for managing cross-platform permissions (camera, microphone, local network, etc.)
//!
//! Note: Camera/microphone permissions are managed by tauri-plugin-macos-permissions.
//!
//! Local Network (macOS Sequoia+): There is no API to silently check permission
//! status (Apple FB8711182). UDP connect() does not trigger the privacy check;
//! only real I/O (send_to) or Bonjour operations do. We use a state machine:
//! - UNKNOWN: check returns None, no I/O is performed (avoids auto-triggering popup)
//! - REQUESTED: user clicked the card, we do send_to to trigger the dialog and verify
//! - GRANTED/DENIED: confirmed state, cached for subsequent checks

/// Log configured permissions at app startup (macOS only)
#[cfg(target_os = "macos")]
pub fn request_all_permissions() {
    log::info!("macOS permissions configured:");
    log::info!("   Camera: NSCameraUsageDescription declared in Info.plist");
    log::info!("   Microphone: NSMicrophoneUsageDescription declared in Info.plist");
    log::info!("   Filesystem: Entitlements configured");
    log::info!("   USB: Entitlements configured");
    log::info!("Permissions will be requested automatically when needed:");
    log::info!("   - Camera/microphone: macOS will show dialog when first accessed by apps");
    log::info!("   - Filesystem/USB: Already granted via entitlements");
    log::info!("Note: Permissions granted to the main app will propagate to child processes");
    log::info!("   (Python daemon and its apps)");
    log::info!("Note: App will appear in System Settings > Privacy after first permission request");
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
pub fn request_all_permissions() {
    // No-op on non-macOS platforms
    log::info!("Permission requests are only needed on macOS");
}

/// Open System Settings to Privacy & Security > Camera (macOS)
#[tauri::command]
#[cfg(target_os = "macos")]
pub fn open_camera_settings() -> Result<(), String> {
    use std::process::Command;

    let output = Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Camera")
        .output()
        .map_err(|e| format!("Failed to open System Settings: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to open System Settings: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

/// Open System Settings to Privacy & Security > Microphone (macOS)
#[tauri::command]
#[cfg(target_os = "macos")]
pub fn open_microphone_settings() -> Result<(), String> {
    use std::process::Command;

    let output = Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        .output()
        .map_err(|e| format!("Failed to open System Settings: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to open System Settings: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

/// Open System Settings to Network/WiFi (macOS)
#[tauri::command]
#[cfg(target_os = "macos")]
pub fn open_wifi_settings() -> Result<(), String> {
    use std::process::Command;

    // Try the new macOS 13+ Network Settings first
    let output = Command::new("open")
        .arg("x-apple.systempreferences:com.apple.Network-Settings.extension")
        .output()
        .map_err(|e| format!("Failed to open System Settings: {}", e))?;

    if !output.status.success() {
        // Fallback to legacy Network preferences (macOS 12 and earlier)
        let fallback = Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.network")
            .output()
            .map_err(|e| format!("Failed to open System Settings: {}", e))?;

        if !fallback.status.success() {
            return Err(format!(
                "Failed to open System Settings: {}",
                String::from_utf8_lossy(&fallback.stderr)
            ));
        }
    }

    Ok(())
}

/// Open System Settings to Privacy & Security > Files and Folders (macOS)
#[tauri::command]
#[cfg(target_os = "macos")]
pub fn open_files_settings() -> Result<(), String> {
    use std::process::Command;

    let output = Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")
        .output()
        .map_err(|e| format!("Failed to open System Settings: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to open System Settings: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

/// Open System Settings to Privacy & Security > Local Network (macOS Sequoia+)
#[tauri::command]
#[cfg(target_os = "macos")]
pub fn open_local_network_settings() -> Result<(), String> {
    use std::process::Command;

    let output = Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork")
        .output()
        .map_err(|e| format!("Failed to open System Settings: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to open System Settings: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

// Local Network permission state machine (macOS only).
// 0 = UNKNOWN (never requested), 1 = GRANTED, 2 = DENIED, 3 = REQUESTED (dialog may be showing)
#[cfg(target_os = "macos")]
static LOCAL_NETWORK_STATE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

// NWBrowser FFI (compiled from nw_local_network.m).
// This is the Apple-recommended approach (TN3179) for detecting local network
// permission: NWBrowser reports .ready when granted, .waiting(PolicyDenied)
// when denied, and times out while the dialog is still visible.
#[cfg(target_os = "macos")]
extern "C" {
    /// Probe local network permission using NWBrowser.
    /// Returns: 0 = timeout (dialog showing), 1 = granted, 2 = denied
    fn nw_probe_local_network(timeout_secs: f64) -> i32;
}

#[cfg(target_os = "macos")]
fn probe_local_network(timeout_secs: f64) -> Result<Option<bool>, String> {
    use std::sync::atomic::Ordering;

    let result = unsafe { nw_probe_local_network(timeout_secs) };

    match result {
        1 => {
            log::info!("[permissions] NWBrowser: .ready (permission granted)");
            LOCAL_NETWORK_STATE.store(1, Ordering::Relaxed);
            Ok(Some(true))
        }
        2 => {
            log::info!("[permissions] NWBrowser: PolicyDenied (permission denied)");
            LOCAL_NETWORK_STATE.store(2, Ordering::Relaxed);
            Ok(Some(false))
        }
        _ => {
            log::debug!("[permissions] NWBrowser: timeout (dialog may be showing)");
            Ok(None)
        }
    }
}

/// Check Local Network permission status (macOS Sequoia/Tahoe+)
///
/// Returns: true if granted, false if denied, None if unknown/pending.
///
/// When the state is UNKNOWN (user hasn't clicked the card yet), this returns
/// None WITHOUT performing any network I/O - avoiding auto-triggering the
/// macOS privacy dialog. Only after request_local_network_permission has been
/// called does this function perform actual probing via NWBrowser.
#[tauri::command]
#[cfg(target_os = "macos")]
pub async fn check_local_network_permission() -> Result<Option<bool>, String> {
    use std::sync::atomic::Ordering;

    match LOCAL_NETWORK_STATE.load(Ordering::Relaxed) {
        1 => Ok(Some(true)),
        2 => {
            // Denied, but re-probe in case the user toggled it back on in
            // System Settings.
            LOCAL_NETWORK_STATE.store(3, Ordering::Relaxed);
            tokio::task::spawn_blocking(|| probe_local_network(0.5))
                .await
                .map_err(|e| format!("spawn_blocking failed: {}", e))?
        }
        3 => {
            // Request was made; probe to detect the user's choice
            tokio::task::spawn_blocking(|| probe_local_network(0.5))
                .await
                .map_err(|e| format!("spawn_blocking failed: {}", e))?
        }
        _ => {
            // UNKNOWN: never requested -> return None, no I/O
            Ok(None)
        }
    }
}

/// Request Local Network permission (macOS Sequoia/Tahoe+)
///
/// Creates an NWBrowser which triggers the macOS privacy dialog if the
/// permission is undetermined. Blocks (on a dedicated thread) for up to
/// 3 seconds waiting for the user's response.
#[tauri::command]
#[cfg(target_os = "macos")]
pub async fn request_local_network_permission() -> Result<Option<bool>, String> {
    LOCAL_NETWORK_STATE.store(3, std::sync::atomic::Ordering::Relaxed);
    tokio::task::spawn_blocking(|| probe_local_network(3.0))
        .await
        .map_err(|e| format!("spawn_blocking failed: {}", e))?
}

// ============================================================================
// Windows Implementation
// ============================================================================

#[tauri::command]
#[cfg(target_os = "windows")]
pub fn open_camera_settings() -> Result<(), String> {
    use std::process::Command;
    // Open Windows Settings > Privacy > Camera
    Command::new("cmd")
        .args(["/C", "start", "ms-settings:privacy-webcam"])
        .spawn()
        .map_err(|e| format!("Failed to open Settings: {}", e))?;
    Ok(())
}

#[tauri::command]
#[cfg(target_os = "windows")]
pub fn open_microphone_settings() -> Result<(), String> {
    use std::process::Command;
    // Open Windows Settings > Privacy > Microphone
    Command::new("cmd")
        .args(["/C", "start", "ms-settings:privacy-microphone"])
        .spawn()
        .map_err(|e| format!("Failed to open Settings: {}", e))?;
    Ok(())
}

#[tauri::command]
#[cfg(target_os = "windows")]
pub fn open_wifi_settings() -> Result<(), String> {
    use std::process::Command;
    // Open Windows Settings > Network & Internet > Wi-Fi
    Command::new("cmd")
        .args(["/C", "start", "ms-settings:network-wifi"])
        .spawn()
        .map_err(|e| format!("Failed to open Settings: {}", e))?;
    Ok(())
}

#[tauri::command]
#[cfg(target_os = "windows")]
pub fn open_files_settings() -> Result<(), String> {
    use std::process::Command;
    // Open Windows Settings > Privacy > File System
    Command::new("cmd")
        .args(["/C", "start", "ms-settings:privacy-broadfilesystemaccess"])
        .spawn()
        .map_err(|e| format!("Failed to open Settings: {}", e))?;
    Ok(())
}

#[tauri::command]
#[cfg(target_os = "windows")]
pub fn open_local_network_settings() -> Result<(), String> {
    use std::process::Command;
    // Open Windows Settings > Network & Internet (no direct local network privacy setting)
    Command::new("cmd")
        .args(["/C", "start", "ms-settings:network"])
        .spawn()
        .map_err(|e| format!("Failed to open Settings: {}", e))?;
    Ok(())
}

/// Windows doesn't have Local Network permission - always granted
#[tauri::command]
#[cfg(target_os = "windows")]
pub async fn check_local_network_permission() -> Result<Option<bool>, String> {
    Ok(Some(true))
}

#[tauri::command]
#[cfg(target_os = "windows")]
pub async fn request_local_network_permission() -> Result<Option<bool>, String> {
    Ok(Some(true))
}

// ============================================================================
// Linux Implementation
// ============================================================================

#[tauri::command]
#[cfg(target_os = "linux")]
pub fn open_camera_settings() -> Result<(), String> {
    // Linux doesn't have a centralized camera settings
    // Best effort: open GNOME Settings if available
    use std::process::Command;
    let _ = Command::new("gnome-control-center").arg("privacy").spawn();
    Ok(())
}

#[tauri::command]
#[cfg(target_os = "linux")]
pub fn open_microphone_settings() -> Result<(), String> {
    use std::process::Command;
    // Try GNOME Sound settings
    let _ = Command::new("gnome-control-center").arg("sound").spawn();
    Ok(())
}

#[tauri::command]
#[cfg(target_os = "linux")]
pub fn open_wifi_settings() -> Result<(), String> {
    use std::process::Command;
    // Try GNOME Network settings first, fallback to nm-connection-editor
    if Command::new("gnome-control-center")
        .arg("wifi")
        .spawn()
        .is_err()
    {
        let _ = Command::new("nm-connection-editor").spawn();
    }
    Ok(())
}

#[tauri::command]
#[cfg(target_os = "linux")]
pub fn open_files_settings() -> Result<(), String> {
    // Linux doesn't have centralized file access permissions
    // Best effort: open file manager or GNOME privacy settings
    use std::process::Command;
    let _ = Command::new("gnome-control-center").arg("privacy").spawn();
    Ok(())
}

#[tauri::command]
#[cfg(target_os = "linux")]
pub fn open_local_network_settings() -> Result<(), String> {
    // Linux doesn't have centralized local network privacy settings
    // Best effort: open GNOME network settings
    use std::process::Command;
    let _ = Command::new("gnome-control-center").arg("network").spawn();
    Ok(())
}

/// Linux doesn't have Local Network permission - always granted
#[tauri::command]
#[cfg(target_os = "linux")]
pub async fn check_local_network_permission() -> Result<Option<bool>, String> {
    Ok(Some(true))
}

#[tauri::command]
#[cfg(target_os = "linux")]
pub async fn request_local_network_permission() -> Result<Option<bool>, String> {
    Ok(Some(true))
}

// ============================================================================
// Fallback for other platforms (no-op)
// ============================================================================

#[tauri::command]
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn open_camera_settings() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn open_microphone_settings() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn open_wifi_settings() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn open_files_settings() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn open_local_network_settings() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub async fn check_local_network_permission() -> Result<Option<bool>, String> {
    Ok(Some(true))
}

#[tauri::command]
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub async fn request_local_network_permission() -> Result<Option<bool>, String> {
    Ok(Some(true))
}
