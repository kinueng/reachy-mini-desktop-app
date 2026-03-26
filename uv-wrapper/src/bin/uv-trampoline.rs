use std::env;
use std::path::PathBuf;
use std::process::{Command, ExitCode};
use std::fs;

use uv_wrapper::{get_data_dir, bootstrap, venv_exists, uv_exe_path, needs_upgrade, upgrade_venvs};

#[cfg(not(target_os = "windows"))]
use signal_hook::{consts::TERM_SIGNALS, flag::register};

/// Re-sign all Python binaries (.so, .dylib) in a venv after pip install.
/// This fixes Team ID mismatch issues on macOS by applying entitlements
/// (disable-library-validation) to all native binaries.
#[cfg(target_os = "macos")]
fn resign_all_venv_binaries(venv_dir: &PathBuf, signing_identity: &str) -> Result<(), String> {
    println!("🔐 Signing unsigned binaries in {}...", venv_dir.display());
    println!("   Signing identity: {}", if signing_identity == "-" { "adhoc" } else { signing_identity });

    // Find python-entitlements.plist:
    // 1. App bundle: exe/../Resources/python-entitlements.plist
    // 2. Same directory as the binary (dev mode: src-tauri/binaries/)
    // 3. Parent directory of binary (dev mode fallback: src-tauri/)
    let entitlements_path = env::current_exe()
        .ok()
        .and_then(|exe| {
            // Production: .app/Contents/MacOS/uv-trampoline -> .app/Contents/Resources/
            let resources_dir = exe.parent()?.parent()?.join("Resources");
            let candidate = resources_dir.join("python-entitlements.plist");
            if candidate.exists() {
                println!("   📜 Found python-entitlements.plist in Resources");
                return Some(candidate);
            }
            // Dev mode: binary is in src-tauri/binaries/ — check same dir
            let same_dir = exe.parent()?.join("python-entitlements.plist");
            if same_dir.exists() {
                println!("   📜 Found python-entitlements.plist next to binary");
                return Some(same_dir);
            }
            // Dev mode fallback: check parent dir (src-tauri/)
            let parent_dir = exe.parent()?.parent()?.join("python-entitlements.plist");
            if parent_dir.exists() {
                println!("   📜 Found python-entitlements.plist in parent dir");
                return Some(parent_dir);
            }
            println!("   ⚠️  python-entitlements.plist not found");
            None
        });

    fn find_files(dir: &PathBuf, extension: &str) -> Result<Vec<PathBuf>, String> {
        let mut files = Vec::new();
        if !dir.exists() {
            return Ok(files);
        }
        let entries = fs::read_dir(dir)
            .map_err(|e| format!("Failed to read directory {}: {}", dir.display(), e))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
            let path = entry.path();
            if path.is_dir() {
                let mut sub_files = find_files(&path, extension)?;
                files.append(&mut sub_files);
            } else if path.is_file() {
                if let Some(file_name) = path.file_name() {
                    if file_name.to_string_lossy().ends_with(extension) {
                        files.push(path);
                    }
                }
            }
        }
        Ok(files)
    }

    /// Returns Ok(Some(true)) if signed, Ok(Some(false)) if signing failed,
    /// Ok(None) if skipped (not Mach-O or already signed).
    fn sign_binary(
        binary_path: &PathBuf,
        signing_identity: &str,
        entitlements: Option<&PathBuf>,
    ) -> Result<Option<bool>, String> {
        let file_output = Command::new("file")
            .arg(binary_path)
            .output()
            .map_err(|e| format!("Failed to check file type: {}", e))?;
        let file_str = String::from_utf8_lossy(&file_output.stdout);
        if !file_str.contains("Mach-O") && !file_str.contains("dynamically linked") && !file_str.contains("shared library") {
            return Ok(None);
        }

        // Skip if already properly signed
        let already_signed = Command::new("codesign")
            .arg("--verify")
            .arg("--strict")
            .arg(binary_path)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if already_signed {
            return Ok(None);
        }

        let mut cmd = Command::new("codesign");
        cmd.arg("--force").arg("--sign").arg(signing_identity).arg("--options").arg("runtime");
        if let Some(ent_path) = entitlements {
            cmd.arg("--entitlements").arg(ent_path);
        }
        if signing_identity != "-" {
            cmd.arg("--timestamp");
        }
        cmd.arg(binary_path);

        match cmd.output() {
            Ok(output) if output.status.success() => Ok(Some(true)),
            Ok(output) => {
                eprintln!("   ⚠️  Failed to sign {}: {}", binary_path.display(), String::from_utf8_lossy(&output.stderr));
                Ok(Some(false))
            }
            Err(e) => {
                eprintln!("   ⚠️  Error signing {}: {}", binary_path.display(), e);
                Ok(Some(false))
            }
        }
    }

    let mut signed_count = 0;
    let mut skipped_count = 0;
    let mut error_count = 0;

    // Sign python3 and libpython with entitlements
    for bin_name in &["bin/python3", "bin/python3.12", "lib/libpython3.12.dylib"] {
        let bin_path = venv_dir.join(bin_name);
        if bin_path.exists() {
            match sign_binary(&bin_path, signing_identity, entitlements_path.as_ref())? {
                Some(true) => signed_count += 1,
                Some(false) => error_count += 1,
                None => skipped_count += 1,
            }
        }
    }

    // Sign .dylib files (entitlements for libpython* only)
    for dylib_file in find_files(venv_dir, ".dylib")? {
        let use_entitlements = dylib_file.file_name()
            .map(|n| n.to_string_lossy().starts_with("libpython"))
            .unwrap_or(false);
        match sign_binary(&dylib_file, signing_identity, if use_entitlements { entitlements_path.as_ref() } else { None })? {
            Some(true) => signed_count += 1,
            Some(false) => error_count += 1,
            None => skipped_count += 1,
        }
    }

    // Sign .so files (Python extensions)
    for so_file in find_files(venv_dir, ".so")? {
        match sign_binary(&so_file, signing_identity, None)? {
            Some(true) => signed_count += 1,
            Some(false) => error_count += 1,
            None => skipped_count += 1,
        }
    }

    if error_count == 0 {
        println!("   ✅ Signed {} binaries ({} already signed)", signed_count, skipped_count);
    } else {
        println!("   ⚠️  Re-signed {} binaries, {} failed", signed_count, error_count);
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn resign_all_venv_binaries(_venv_dir: &PathBuf, _signing_identity: &str) -> Result<(), String> {
    Ok(())
}

/// Detect the macOS signing identity from the app bundle, fallback to adhoc ("-").
#[cfg(target_os = "macos")]
fn detect_signing_identity() -> String {
    let app_bundle_path = env::current_exe()
        .ok()
        .and_then(|exe| exe.parent()?.parent()?.parent().map(|p| p.to_path_buf()));

    if let Some(app_bundle) = app_bundle_path {
        if let Ok(output) = Command::new("codesign").arg("-d").arg("-vv").arg(&app_bundle).output() {
            let stderr_str = String::from_utf8_lossy(&output.stderr);
            if let Some(dev_id) = stderr_str
                .lines()
                .find(|line| line.contains("Authority=") && line.contains("Developer ID Application"))
                .and_then(|line| line.split("Authority=").nth(1).map(|s| s.trim().to_string()))
            {
                return dev_id;
            }
        }
    }
    "-".to_string()
}

fn main() -> ExitCode {
    let args = env::args().skip(1).collect::<Vec<String>>();

    // Step 1: Determine the writable data directory
    let data_dir = match get_data_dir() {
        Some(dir) => dir,
        None => {
            eprintln!("❌ Error: Unable to determine data directory");
            return ExitCode::FAILURE;
        }
    };

    println!("📂 Data directory: {:?}", data_dir);

    // Step 2: Bootstrap — ensure uv, Python, .venv, and apps_venv all exist.
    // On first run everything is created. After a partial reset (e.g., apps_venv
    // deleted), only the missing pieces are recreated.
    let needs_full_bootstrap = !venv_exists(&data_dir, ".venv");
    let needs_apps_venv = !venv_exists(&data_dir, "apps_venv");

    if needs_full_bootstrap {
        println!("📦 First run detected, bootstrapping Python environment...");
        if let Err(e) = bootstrap(&data_dir) {
            eprintln!("❌ Bootstrap failed: {}", e);
            return ExitCode::FAILURE;
        }
    } else if needs_apps_venv {
        // .venv exists but apps_venv is missing (e.g., after "Reset Apps Environment")
        println!("[bootstrap] Recreating apps_venv...");
        let package_spec = uv_wrapper::get_reachy_mini_spec();
        let apps_python_rel = if cfg!(target_os = "windows") {
            "apps_venv\\Scripts\\python.exe"
        } else {
            "apps_venv/bin/python3"
        };
        if let Err(e) = uv_wrapper::run_uv(&data_dir, &["venv", "apps_venv"]) {
            eprintln!("❌ Failed to create apps_venv: {}", e);
        } else if let Err(e) = uv_wrapper::run_uv(
            &data_dir,
            &["pip", "install", "--python", apps_python_rel, &package_spec],
        ) {
            eprintln!("❌ Failed to install packages in apps_venv: {}", e);
        }
    }

    // Step 2b: Upgrade — if the venv already existed but the expected reachy-mini
    // spec changed (e.g., app was updated), upgrade both venvs in place.
    let needs_spec_upgrade = !needs_full_bootstrap && needs_upgrade(&data_dir);
    if needs_spec_upgrade {
        println!("[upgrade] App updated — reachy-mini spec changed, upgrading venvs...");
        if let Err(e) = upgrade_venvs(&data_dir) {
            eprintln!("⚠️  Upgrade failed (will continue with existing venv): {}", e);
            // Non-fatal: the old version may still work. Don't write the marker
            // so we retry on next launch.
        }
    }

    // macOS: sign any new/unsigned binaries
    if needs_full_bootstrap || needs_apps_venv || needs_spec_upgrade {
        #[cfg(target_os = "macos")]
        {
            println!("[bootstrap] Signing Python binaries...");
            let signing_identity = detect_signing_identity();

            if needs_full_bootstrap {
                // Sign the cpython installation directory (e.g., cpython-3.12.13-macos-aarch64-none/)
                if let Ok(entries) = fs::read_dir(&data_dir) {
                    for entry in entries.flatten() {
                        let name = entry.file_name();
                        let name_str = name.to_string_lossy();
                        if name_str.starts_with("cpython-") && entry.path().is_dir() {
                            println!("[bootstrap] Signing cpython installation: {}", name_str);
                            if let Err(e) = resign_all_venv_binaries(&entry.path(), &signing_identity) {
                                eprintln!("[bootstrap] Warning: failed to re-sign binaries in {}: {}", name_str, e);
                            }
                        }
                    }
                }
            }

            // Sign venv directories (only the ones that were just created or upgraded)
            let venvs_to_sign: &[&str] = if needs_full_bootstrap || needs_spec_upgrade {
                &[".venv", "apps_venv"]
            } else {
                &["apps_venv"]
            };
            for venv_name in venvs_to_sign {
                let venv_dir = data_dir.join(venv_name);
                if venv_dir.exists() {
                    if let Err(e) = resign_all_venv_binaries(&venv_dir, &signing_identity) {
                        eprintln!("[bootstrap] Warning: failed to re-sign binaries in {}: {}", venv_name, e);
                    }
                }
            }
        }

        // Pre-warm: GStreamer registry cache + reachy_mini import in parallel
        // Without this, first launch scans 256 GStreamer plugins (2+ min)
        let venvs_to_warm: &[&str] = if needs_full_bootstrap || needs_spec_upgrade {
            &[".venv", "apps_venv"]
        } else {
            &["apps_venv"]
        };
        println!("[bootstrap] Pre-warming GStreamer and Python imports...");
        {
            let mut children = Vec::new();
            for venv_name in venvs_to_warm {
                let python_path = if cfg!(target_os = "windows") {
                    data_dir.join(venv_name).join("Scripts").join("python.exe")
                } else {
                    data_dir.join(venv_name).join("bin").join("python3")
                };
                if !python_path.exists() {
                    continue;
                }

                println!("[bootstrap] Pre-warming {}...", venv_name);
                match Command::new(&python_path)
                    .current_dir(&data_dir)
                    .env("GST_REGISTRY_FORK", "no")
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .arg("-c")
                    .arg(concat!(
                        "try:\n",
                        "    import gi; gi.require_version('Gst', '1.0'); from gi.repository import Gst; Gst.init([])\n",
                        "except Exception:\n",
                        "    pass\n",
                        "import reachy_mini\n",
                    ))
                    .spawn()
                {
                    Ok(child) => children.push((venv_name.to_string(), child)),
                    Err(e) => eprintln!("[bootstrap] Warning: failed to spawn pre-warm for {}: {}", venv_name, e),
                }
            }

            for (venv_name, mut child) in children {
                match child.wait() {
                    Ok(status) if !status.success() => {
                        eprintln!("[bootstrap] Warning: pre-warm for {} exited with {:?}", venv_name, status.code());
                    }
                    Err(e) => {
                        eprintln!("[bootstrap] Warning: pre-warm wait failed for {}: {}", venv_name, e);
                    }
                    _ => {}
                }
            }
            println!("[bootstrap] Pre-warming complete");
        }

        println!("[bootstrap] Setup complete!");
    }

    // Step 3: Build the command to launch
    // The first arg is typically a Python path (e.g., .venv/bin/python3)
    // followed by daemon arguments
    println!("🔍 Args: {:?}", args);

    let mut cmd = if !args.is_empty() && args[0].contains("python") {
        println!("🐍 Detected Python executable: {}", args[0]);

        // Convert Unix-style path to Windows-style if needed
        #[cfg(target_os = "windows")]
        let python_arg = {
            let arg = &args[0];
            if arg.contains(".venv/bin/python") || arg.contains(".venv\\bin\\python") {
                arg.replace(".venv/bin/python3", ".venv/Scripts/python.exe")
                   .replace(".venv\\bin\\python3", ".venv\\Scripts\\python.exe")
                   .replace(".venv/bin/python", ".venv/Scripts/python.exe")
                   .replace(".venv\\bin\\python", ".venv\\Scripts\\python.exe")
                   .replace("/", "\\")
            } else {
                arg.replace("/", "\\")
            }
        };

        #[cfg(not(target_os = "windows"))]
        let python_arg = args[0].clone();

        // Resolve relative to data_dir
        let python_path = data_dir.join(&python_arg);
        println!("🔍 Resolved Python path: {:?}", python_path);
        if !python_path.exists() {
            eprintln!("❌ Error: Python executable not found at {:?}", python_path);
            return ExitCode::FAILURE;
        }

        let mut c = Command::new(&python_path);
        c.current_dir(&data_dir)
         .env("UV_WORKING_DIR", &data_dir)
         .env("UV_PYTHON_INSTALL_DIR", &data_dir)
         .args(&args[1..]);
        c
    } else {
        println!("ℹ️  Using uv command execution");
        let uv_path = uv_exe_path(&data_dir);
        let mut c = Command::new(&uv_path);
        c.current_dir(&data_dir)
         .env("UV_WORKING_DIR", &data_dir)
         .env("UV_PYTHON_INSTALL_DIR", &data_dir)
         .args(&args);
        c
    };

    // Add data_dir to PATH so Python subprocesses can find uv
    let current_path = env::var("PATH").unwrap_or_default();
    let new_path = if cfg!(target_os = "windows") {
        format!("{};{}", data_dir.display(), current_path)
    } else {
        format!("{}:{}", data_dir.display(), current_path)
    };
    cmd.env("PATH", &new_path);

    // Track if this is a pip install (for macOS re-signing)
    // Determine which venv was targeted from --python arg (e.g., "apps_venv/bin/python3")
    #[cfg(target_os = "macos")]
    let is_pip_install = !args.is_empty() && args[0] == "pip" && args.len() >= 2 && args[1] == "install";
    #[cfg(target_os = "macos")]
    let pip_target_venv: Option<String> = if is_pip_install {
        args.iter()
            .position(|a| a == "--python")
            .and_then(|i| args.get(i + 1))
            .and_then(|python_path| {
                // Extract venv name from path like "apps_venv/bin/python3" or ".venv/bin/python3"
                python_path.split('/').next().or_else(|| python_path.split('\\').next())
                    .map(|s| s.to_string())
            })
    } else {
        None
    };

    // Record time before pip install so we only re-sign newly modified binaries
    println!("🚀 Launching: {:?}", cmd);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            eprintln!("❌ Error: Unable to spawn process: {}", e);
            return ExitCode::FAILURE;
        }
    };

    // Unix: signal handling with wait loop
    #[cfg(not(target_os = "windows"))]
    {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let term_now = Arc::new(AtomicBool::new(false));
        for sig in TERM_SIGNALS {
            if let Err(e) = register(*sig, Arc::clone(&term_now)) {
                eprintln!("⚠️  Warning: Unable to register handler for signal {:?}: {}", sig, e);
            }
        }

        loop {
            if term_now.load(Ordering::Relaxed) {
                eprintln!("🛑 Termination signal received, stopping child process...");
                let _ = child.kill();
                break;
            }

            match child.try_wait() {
                Ok(Some(status)) => {
                    let exit_code = status.code().unwrap_or(1);
                    if exit_code != 0 {
                        eprintln!("⚠️  Process exited with code: {}", exit_code);
                    }

                    // macOS: sign any unsigned binaries in the targeted venv after pip install
                    #[cfg(target_os = "macos")]
                    {
                        if is_pip_install && exit_code == 0 {
                            let signing_identity = detect_signing_identity();
                            let venvs_to_sign: Vec<&str> = match &pip_target_venv {
                                Some(venv) => vec![venv.as_str()],
                                None => vec![".venv", "apps_venv"], // fallback: sign both
                            };
                            for venv_name in venvs_to_sign {
                                let venv_dir = data_dir.join(venv_name);
                                if venv_dir.exists() {
                                    if let Err(e) = resign_all_venv_binaries(&venv_dir, &signing_identity) {
                                        eprintln!("⚠️  Failed to re-sign binaries in {}: {}", venv_name, e);
                                    }
                                }
                            }
                        }
                    }

                    return ExitCode::from(exit_code as u8);
                }
                Ok(None) => {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => {
                    eprintln!("❌ Error while waiting for child process: {}", e);
                    let _ = child.kill();
                    return ExitCode::FAILURE;
                }
            }
        }

        match child.wait() {
            Ok(status) => ExitCode::from(status.code().unwrap_or(1) as u8),
            Err(e) => {
                eprintln!("❌ Error during final wait: {}", e);
                ExitCode::FAILURE
            }
        }
    }

    // Windows: simple wait
    #[cfg(target_os = "windows")]
    {
        match child.wait() {
            Ok(status) => {
                let exit_code = status.code().unwrap_or(1);
                if exit_code != 0 {
                    eprintln!("⚠️  Process exited with code: {}", exit_code);
                }
                ExitCode::from(exit_code as u8)
            }
            Err(e) => {
                eprintln!("❌ Error while waiting for process: {}", e);
                ExitCode::FAILURE
            }
        }
    }
}
