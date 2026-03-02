/// Update module for managing daemon updates
///
/// This module provides functionality to check for and install daemon updates
/// independently of the Python daemon's update routes. It queries GitHub Releases
/// for version info and manages the local venv using pip.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

use crate::daemon::DaemonState;

const GITHUB_REPO: &str = "pollen-robotics/reachy_mini";

// ============================================================================
// TYPES
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DaemonUpdateInfo {
    pub current_version: String,
    pub available_version: String,
    pub is_available: bool,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/// Get the path to the local venv SOURCE directory
/// This is the directory that contains the .venv that uv-trampoline will copy
/// - In dev: src-tauri/binaries/.venv
/// - In production (macOS): ~/Library/Application Support/com.pollen-robotics.reachy-mini/.venv
///   (fallback: App.app/Contents/Resources/.venv)
/// - In production (Windows): %LOCALAPPDATA%\Reachy Mini Control\.venv
fn get_local_venv_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        // On Windows, the source venv is in Program Files (MSI install)
        // or in the dev environment
        let program_files =
            std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
        let program_files_dir = PathBuf::from(program_files)
            .join("Reachy Mini Control")
            .join("binaries");

        if program_files_dir.join(".venv").exists() {
            log::info!(
                "[update] Using Program Files venv: {:?}",
                program_files_dir
            );
            return Ok(program_files_dir);
        }

        // Try resource_dir for dev
        let resource_dir = app_handle
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to get resource dir: {}", e))?;
        let binaries_dir = resource_dir.join("binaries");

        if binaries_dir.join(".venv").exists() {
            log::info!("[update] Using dev venv: {:?}", binaries_dir);
            return Ok(binaries_dir);
        }

        Err(format!(
            "Venv not found. Checked {:?} and {:?}",
            program_files_dir, binaries_dir
        ))
    }

    #[cfg(not(target_os = "windows"))]
    {
        // On macOS/Linux, first try to get the executable's directory
        // This will help us determine if we're in dev or prod
        let exe_path =
            std::env::current_exe().map_err(|e| format!("Failed to get exe path: {}", e))?;
        let exe_dir = exe_path
            .parent()
            .ok_or_else(|| "Failed to get exe parent directory".to_string())?;

        log::info!("[update] Executable directory: {:?}", exe_dir);

        // In development, the executable is in target/debug/
        // Tauri copies resources (uv, cpython, .venv) from binaries/ to target/debug/
        // The daemon (via uv-trampoline) runs from target/debug/, so we must
        // update THAT copy for changes to take effect immediately.
        if exe_dir.ends_with("target/debug") || exe_dir.ends_with("target\\debug") {
            let target_debug_dir = exe_dir.to_path_buf();

            // Priority 1: target/debug/.venv (Tauri-copied runtime venv, used by uv-trampoline)
            if target_debug_dir.join(".venv").exists() {
                log::info!(
                    "[update] Using target/debug venv (runtime copy): {:?}",
                    target_debug_dir
                );
                return Ok(target_debug_dir);
            }

            // Priority 2: src-tauri/binaries/.venv (source venv, fallback)
            let src_tauri_dir = exe_dir
                .parent()
                .and_then(|p| p.parent())
                .ok_or_else(|| "Failed to navigate to src-tauri directory".to_string())?;

            let binaries_dir = if src_tauri_dir.ends_with("src-tauri") {
                src_tauri_dir.join("binaries")
            } else {
                src_tauri_dir.join("src-tauri").join("binaries")
            };

            if binaries_dir.join(".venv").exists() {
                log::info!("[update] Using dev binaries venv: {:?}", binaries_dir);
                return Ok(binaries_dir);
            }

            return Err(format!(
                "Dev venv not found in {:?} or {:?}",
                target_debug_dir.join(".venv"),
                binaries_dir.join(".venv")
            ));
        }

        #[cfg(target_os = "macos")]
        {
            // Priority 1: Application Support (externalized venv, persists across Tauri updates)
            if let Ok(home) = std::env::var("HOME") {
                let app_support_dir = PathBuf::from(home)
                    .join("Library")
                    .join("Application Support")
                    .join("com.pollen-robotics.reachy-mini");
                if app_support_dir.join(".venv").exists() {
                    log::info!(
                        "[update] Using Application Support venv: {:?}",
                        app_support_dir
                    );
                    return Ok(app_support_dir);
                }
            }

            // Priority 2: App bundle Resources (before externalization or as fallback)
            if let Some(macos_dir) = exe_dir.parent() {
                let resources_dir = macos_dir.join("Resources");
                if resources_dir.join(".venv").exists() {
                    log::info!("[update] Using production venv: {:?}", resources_dir);
                    return Ok(resources_dir);
                }
            }
        }

        // Fallback: Use resource_dir from Tauri API
        let resource_dir = app_handle
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to get resource dir: {}", e))?;
        let binaries_dir = resource_dir.join("binaries");

        if binaries_dir.join(".venv").exists() {
            log::info!("[update] Using resource_dir venv: {:?}", binaries_dir);
            Ok(binaries_dir)
        } else {
            Err(format!(
                "Venv not found. Checked exe_dir, macOS Resources, and resource_dir: {:?}",
                binaries_dir.join(".venv")
            ))
        }
    }
}

/// Get the currently installed version of reachy-mini from the local venv
fn get_local_daemon_version(venv_path: &Path) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    let site_packages = venv_path.join(".venv").join("Lib").join("site-packages");

    #[cfg(not(target_os = "windows"))]
    let site_packages = {
        // Auto-detect Python version instead of hardcoding python3.12
        let lib_dir = venv_path.join(".venv").join("lib");
        if !lib_dir.exists() {
            return Err(format!("Venv lib dir not found at {:?}", lib_dir));
        }

        let python_dir = std::fs::read_dir(&lib_dir)
            .map_err(|e| format!("Failed to read lib dir: {}", e))?
            .filter_map(|e| e.ok())
            .find(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("python3")
            })
            .ok_or_else(|| format!("No python3.x directory found in {:?}", lib_dir))?;

        log::info!(
            "[update] Detected Python version dir: {:?}",
            python_dir.file_name()
        );
        python_dir.path().join("site-packages")
    };

    if !site_packages.exists() {
        return Err(format!("Site-packages not found at {:?}", site_packages));
    }

    let entries = std::fs::read_dir(&site_packages)
        .map_err(|e| format!("Failed to read site-packages: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with("reachy_mini-") && name.ends_with(".dist-info") {
            let metadata_path = entry.path().join("METADATA");
            if metadata_path.exists() {
                let content = std::fs::read_to_string(&metadata_path)
                    .map_err(|e| format!("Failed to read METADATA: {}", e))?;

                for line in content.lines() {
                    if line.starts_with("Version: ") {
                        return Ok(line.replace("Version: ", "").trim().to_string());
                    }
                }
            }
        }
    }

    Err("reachy-mini version not found in venv".to_string())
}

/// Get the latest version available from GitHub Releases.
///
/// - Stable: GET /repos/{repo}/releases/latest (excludes pre-releases)
/// - Pre-release: GET /repos/{repo}/releases?per_page=1 (most recent, any type)
async fn get_github_version(pre_release: bool) -> Result<String, String> {
    let url = if pre_release {
        format!(
            "https://api.github.com/repos/{}/releases?per_page=1",
            GITHUB_REPO
        )
    } else {
        format!(
            "https://api.github.com/repos/{}/releases/latest",
            GITHUB_REPO
        )
    };

    log::info!("[update] Fetching GitHub release from: {}", url);

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "reachy-mini-desktop-app")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch GitHub releases: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("GitHub API returned status: {}", response.status()));
    }

    let tag = if pre_release {
        let releases: Vec<GitHubRelease> = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse GitHub JSON: {}", e))?;

        releases
            .first()
            .ok_or_else(|| "No releases found on GitHub".to_string())?
            .tag_name
            .clone()
    } else {
        let release: GitHubRelease = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse GitHub JSON: {}", e))?;

        release.tag_name
    };

    let version = tag.strip_prefix('v').unwrap_or(&tag).to_string();
    log::info!("[update] GitHub version: {}", version);
    Ok(version)
}

/// Parse a PEP 440 version string into semver.
///
/// Handles: "1.4.0", "1.2.5rc1", "1.3.1.dev0", "1.2.5a1", "1.2.5b2"
fn parse_version(version_str: &str) -> Result<semver::Version, String> {
    if let Ok(ver) = semver::Version::parse(version_str) {
        return Ok(ver);
    }

    let parts: Vec<&str> = version_str.split('.').collect();
    if parts.len() < 3 {
        return Err(format!("Invalid version string: {}", version_str));
    }

    let major = parts[0];
    let minor = parts[1];
    let patch_part = parts[2];

    // PEP 440 ".devN" suffix: "1.3.1.dev0" -> parts = ["1", "3", "1", "dev0"]
    if parts.len() >= 4 && parts[3].starts_with("dev") {
        let dev_num = &parts[3][3..];
        let clean = format!("{}.{}.{}-dev.{}", major, minor, patch_part, dev_num);
        return semver::Version::parse(&clean)
            .map_err(|e| format!("Failed to parse dev version '{}': {}", clean, e));
    }

    // PEP 440 "rcN" in patch: "1.2.5rc1" -> "1.2.5-rc.1"
    if patch_part.contains("rc") {
        let rc_parts: Vec<&str> = patch_part.split("rc").collect();
        if rc_parts.len() == 2 {
            let clean = format!("{}.{}.{}-rc.{}", major, minor, rc_parts[0], rc_parts[1]);
            return semver::Version::parse(&clean)
                .map_err(|e| format!("Failed to parse rc version '{}': {}", clean, e));
        }
    }

    // PEP 440 "aN" (alpha): "1.2.5a1" -> "1.2.5-alpha.1"
    if patch_part.contains('a') {
        let a_parts: Vec<&str> = patch_part.split('a').collect();
        if a_parts.len() == 2 {
            let clean = format!("{}.{}.{}-alpha.{}", major, minor, a_parts[0], a_parts[1]);
            return semver::Version::parse(&clean)
                .map_err(|e| format!("Failed to parse alpha version '{}': {}", clean, e));
        }
    }

    // PEP 440 "bN" (beta): "1.2.5b2" -> "1.2.5-beta.2"
    if patch_part.contains('b') {
        let b_parts: Vec<&str> = patch_part.split('b').collect();
        if b_parts.len() == 2 {
            let clean = format!("{}.{}.{}-beta.{}", major, minor, b_parts[0], b_parts[1]);
            return semver::Version::parse(&clean)
                .map_err(|e| format!("Failed to parse beta version '{}': {}", clean, e));
        }
    }

    Err(format!("Could not parse version: {}", version_str))
}

/// Check if a new version is available
fn is_update_available(current: &str, available: &str) -> Result<bool, String> {
    let current_ver = parse_version(current)?;
    let available_ver = parse_version(available)?;

    Ok(available_ver > current_ver)
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Check if an update is available for the daemon
#[tauri::command]
pub async fn check_daemon_update(
    app_handle: AppHandle,
    pre_release: bool,
) -> Result<DaemonUpdateInfo, String> {
    log::info!(
        "[update] Checking for daemon updates (pre_release: {})",
        pre_release
    );

    // 1. Get local version
    let venv_path = get_local_venv_path(&app_handle)?;
    let current_version = get_local_daemon_version(&venv_path)?;
    log::info!("[update] Current version: {}", current_version);

    // 2. Get latest version from GitHub Releases
    let available_version = get_github_version(pre_release).await?;
    log::info!("[update] Available version: {}", available_version);

    // 3. Compare versions
    let is_available = is_update_available(&current_version, &available_version)?;
    log::info!("[update] Update available: {}", is_available);

    Ok(DaemonUpdateInfo {
        current_version,
        available_version,
        is_available,
    })
}

/// Update the daemon to the latest version
#[tauri::command]
pub async fn update_daemon(
    app_handle: AppHandle,
    state: State<'_, DaemonState>,
    pre_release: bool,
) -> Result<String, String> {
    log::info!(
        "[update] Starting daemon update (pre_release: {})",
        pre_release
    );

    // 1. Stop the daemon gracefully
    log::info!("[update] Stopping daemon...");
    crate::stop_daemon(app_handle.clone(), state.clone())?;

    // Wait a bit for the daemon to stop completely
    tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;

    // 2. Get venv path and pip executable
    let venv_path = get_local_venv_path(&app_handle)?;

    #[cfg(target_os = "windows")]
    let pip_path = venv_path.join(".venv").join("Scripts").join("pip.exe");

    #[cfg(not(target_os = "windows"))]
    let pip_path = venv_path.join(".venv").join("bin").join("pip");

    if !pip_path.exists() {
        return Err(format!("pip not found at {:?}", pip_path));
    }

    log::info!("[update] Using pip at: {:?}", pip_path);

    // 3. Install gstreamer first (from freedesktop GitLab registry)
    // Only on macOS/Windows - no Linux wheels available (Linux uses system GStreamer)
    #[cfg(not(target_os = "linux"))]
    {
        let gstreamer_args = vec![
            "install",
            "--upgrade",
            "--index-url",
            "https://gitlab.freedesktop.org/api/v4/projects/1340/packages/pypi/simple",
            "gstreamer==1.28.0",
        ];

        log::info!(
            "[update] Installing gstreamer: {:?} {:?}",
            pip_path,
            gstreamer_args
        );

        let gst_output = std::process::Command::new(&pip_path)
            .args(&gstreamer_args)
            .output()
            .map_err(|e| format!("Failed to run pip for gstreamer: {}", e))?;

        if !gst_output.status.success() {
            let gst_stderr = String::from_utf8_lossy(&gst_output.stderr);
            log::warn!(
                "[update] gstreamer install failed (non-fatal): {}",
                gst_stderr
            );
        } else {
            log::info!("[update] gstreamer installed successfully");
        }
    }

    #[cfg(target_os = "linux")]
    {
        log::info!("[update] Skipping gstreamer pip package on Linux (using system GStreamer)");
    }

    // 4. Upgrade reachy-mini
    let mut args = vec!["install", "--upgrade", "reachy-mini"];
    if pre_release {
        args.push("--pre");
    }

    log::info!("[update] Running: {:?} {:?}", pip_path, args);

    let output = std::process::Command::new(&pip_path)
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run pip: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !stdout.is_empty() {
        log::info!("[update] pip stdout:\n{}", stdout);
    }
    if !stderr.is_empty() {
        log::info!("[update] pip stderr:\n{}", stderr);
    }

    if !output.status.success() {
        return Err(format!(
            "pip update failed with exit code {:?}:\n{}",
            output.status.code(),
            stderr
        ));
    }

    log::info!("[update] Daemon updated successfully!");
    log::info!("[update] The updated venv will be used on next connection");
    log::info!("[update] uv-trampoline will copy the new venv when daemon starts again");

    // 5. DON'T restart daemon here
    // Let the user reconnect - uv-trampoline will copy the updated venv at next launch

    Ok("Daemon updated successfully. Reconnect to use the new version.".to_string())
}
