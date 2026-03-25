use std::{env, fs, path::PathBuf, process::Command};

/// Returns the platform-specific writable data directory for the app.
///
/// - macOS: ~/Library/Application Support/com.pollen-robotics.reachy-mini/
/// - Windows: %LOCALAPPDATA%\Reachy Mini Control\
/// - Linux: $XDG_DATA_HOME/reachy-mini-control/ or ~/.local/share/reachy-mini-control/
pub fn get_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        env::var("HOME").ok().map(|home| {
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("com.pollen-robotics.reachy-mini")
        })
    }

    #[cfg(target_os = "windows")]
    {
        env::var("LOCALAPPDATA")
            .ok()
            .map(|local_app_data| PathBuf::from(local_app_data).join("Reachy Mini Control"))
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(xdg_data_home) = env::var("XDG_DATA_HOME") {
            return Some(PathBuf::from(xdg_data_home).join("reachy-mini-control"));
        }
        env::var("HOME")
            .ok()
            .map(|home| PathBuf::from(home).join(".local/share/reachy-mini-control"))
    }
}

/// Returns the path to the uv executable within the data directory.
pub fn uv_exe_path(data_dir: &PathBuf) -> PathBuf {
    if cfg!(target_os = "windows") {
        data_dir.join("uv.exe")
    } else {
        data_dir.join("uv")
    }
}

/// Returns the path to the Python executable within a venv.
pub fn python_exe_path(data_dir: &PathBuf, venv_name: &str) -> PathBuf {
    if cfg!(target_os = "windows") {
        data_dir.join(venv_name).join("Scripts").join("python.exe")
    } else {
        data_dir.join(venv_name).join("bin").join("python3")
    }
}

/// Checks if a venv exists and has a valid Python executable.
pub fn venv_exists(data_dir: &PathBuf, venv_name: &str) -> bool {
    python_exe_path(data_dir, venv_name).exists()
}

/// Download and install uv into the data directory.
pub fn download_uv(data_dir: &PathBuf) -> Result<(), String> {
    let uv_path = uv_exe_path(data_dir);
    if uv_path.exists() {
        return Ok(());
    }

    println!("[bootstrap] Downloading uv...");

    #[cfg(not(target_os = "windows"))]
    {
        let script = format!(
            "curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR='{}' UV_NO_MODIFY_PATH=1 sh",
            data_dir.display()
        );
        run_command(&script).map_err(|e| format!("Failed to download uv: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        // Download uv zip directly using curl.exe (the real curl, not PowerShell alias)
        let zip_path = data_dir.join("uv.zip");
        let download_cmd = format!(
            "curl.exe -L -o \"{}\" https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip",
            zip_path.display()
        );
        run_command(&download_cmd).map_err(|e| format!("Failed to download uv: {}", e))?;

        let extract_cmd = format!(
            "Expand-Archive -Path \"{}\" -DestinationPath \"{}\" -Force",
            zip_path.display(),
            data_dir.display()
        );
        run_command(&extract_cmd).map_err(|e| format!("Failed to extract uv: {}", e))?;

        // Clean up zip
        let _ = fs::remove_file(&zip_path);
    }

    if !uv_path.exists() {
        return Err(format!("uv not found at {:?} after download", uv_path));
    }

    println!("[bootstrap] uv downloaded successfully");
    Ok(())
}

/// Run a uv command in the data directory.
pub fn run_uv(data_dir: &PathBuf, args: &[&str]) -> Result<(), String> {
    let uv_path = uv_exe_path(data_dir);

    let status = Command::new(&uv_path)
        .current_dir(data_dir)
        .env("UV_PYTHON_INSTALL_DIR", data_dir)
        .env("UV_WORKING_DIR", data_dir)
        .args(args)
        .status()
        .map_err(|e| format!("Failed to run uv {:?}: {}", args, e))?;

    if !status.success() {
        return Err(format!(
            "uv {:?} failed with exit code: {:?}",
            args,
            status.code()
        ));
    }

    Ok(())
}

/// Determine the reachy-mini package spec from environment variables.
///
/// - REACHY_MINI_VERSION=0.9.20 → "reachy-mini==0.9.20"
/// - REACHY_MINI_SOURCE=develop → "git+https://github.com/pollen-robotics/reachy_mini.git@develop"
/// - default → "reachy-mini" (latest from PyPI)
pub fn get_reachy_mini_spec() -> String {
    if let Ok(version) = env::var("REACHY_MINI_VERSION") {
        return format!("reachy-mini=={}", version);
    }

    if let Ok(source) = env::var("REACHY_MINI_SOURCE") {
        if source != "pypi" {
            return format!(
                "git+https://github.com/pollen-robotics/reachy_mini.git@{}",
                source
            );
        }
    }

    "reachy-mini".to_string()
}

/// Bootstrap the Python environment: download uv, install Python, create venvs, install packages.
pub fn bootstrap(data_dir: &PathBuf) -> Result<(), String> {
    fs::create_dir_all(data_dir)
        .map_err(|e| format!("Failed to create data directory {:?}: {}", data_dir, e))?;

    // Step 1: Download uv
    download_uv(data_dir)?;

    // Step 2: Install Python
    println!("[bootstrap] Installing Python 3.12...");
    run_uv(data_dir, &["python", "install", "3.12"])?;

    let package_spec = get_reachy_mini_spec();

    // Step 3: Create .venv and install reachy-mini
    println!("[bootstrap] Creating .venv...");
    run_uv(data_dir, &["venv", ".venv"])?;

    println!("[bootstrap] Installing {}...", package_spec);
    let python_rel = if cfg!(target_os = "windows") {
        ".venv\\Scripts\\python.exe"
    } else {
        ".venv/bin/python3"
    };
    run_uv(
        data_dir,
        &["pip", "install", "--python", python_rel, &package_spec],
    )?;

    // Step 4: Create apps_venv and install reachy-mini
    println!("[bootstrap] Creating apps_venv...");
    run_uv(data_dir, &["venv", "apps_venv"])?;

    let apps_python_rel = if cfg!(target_os = "windows") {
        "apps_venv\\Scripts\\python.exe"
    } else {
        "apps_venv/bin/python3"
    };
    run_uv(
        data_dir,
        &["pip", "install", "--python", apps_python_rel, &package_spec],
    )?;

    println!("[bootstrap] Packages installed successfully");
    Ok(())
}

pub fn run_command(cmd: &str) -> Result<std::process::ExitStatus, std::io::Error> {
    println!("Running command: {}", cmd);

    #[cfg(target_os = "windows")]
    let status = Command::new("powershell")
        .arg("-ExecutionPolicy")
        .arg("ByPass")
        .arg("-c")
        .arg(cmd)
        .status()?;

    #[cfg(not(target_os = "windows"))]
    let status = Command::new("sh").arg("-c").arg(cmd).status()?;

    if !status.success() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("Command failed with exit code: {:?}", status.code()),
        ));
    }

    Ok(status)
}
