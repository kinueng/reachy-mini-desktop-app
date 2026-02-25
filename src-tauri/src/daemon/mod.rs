use std::collections::VecDeque;
use std::sync::Mutex;
use tauri::State;
use tauri_plugin_shell::process::CommandChild;

// ============================================================================
// DAEMON STATUS - Process lifecycle state machine (USB/Simulation only)
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub enum DaemonStatus {
    Idle,
    Starting,
    Running,
    Stopping,
    Crashed,
}

const VALID_DAEMON_TRANSITIONS: &[(DaemonStatus, DaemonStatus)] = &[
    (DaemonStatus::Idle, DaemonStatus::Starting),
    (DaemonStatus::Starting, DaemonStatus::Running),
    (DaemonStatus::Starting, DaemonStatus::Crashed),
    (DaemonStatus::Running, DaemonStatus::Stopping),
    (DaemonStatus::Running, DaemonStatus::Crashed),
    (DaemonStatus::Stopping, DaemonStatus::Idle),
    (DaemonStatus::Crashed, DaemonStatus::Idle),
    (DaemonStatus::Crashed, DaemonStatus::Starting),
];

pub fn is_valid_transition(from: DaemonStatus, to: DaemonStatus) -> bool {
    VALID_DAEMON_TRANSITIONS
        .iter()
        .any(|(f, t)| *f == from && *t == to)
}

/// Attempt a validated status transition. Returns the previous status on success.
/// Same-state transitions are treated as no-ops and return Ok.
pub fn transition_status(
    status_lock: &Mutex<DaemonStatus>,
    new_status: DaemonStatus,
) -> Result<DaemonStatus, String> {
    let mut status = status_lock.lock().unwrap();
    let old = *status;

    if old == new_status {
        return Ok(old);
    }

    if !is_valid_transition(old, new_status) {
        return Err(format!(
            "Invalid daemon transition: {:?} -> {:?}",
            old, new_status
        ));
    }

    *status = new_status;
    log::info!(
        "[daemon] Status transition: {:?} -> {:?}",
        old, new_status
    );
    Ok(old)
}

/// Transition + emit "daemon-status-changed" in one call.
/// Returns the previous status on success, or silently does nothing if the
/// transition is invalid (returns Err but doesn't panic).
pub fn transition_and_emit(
    state: &DaemonState,
    new_status: DaemonStatus,
    app_handle: &tauri::AppHandle,
) -> Result<DaemonStatus, String> {
    use tauri::Emitter;
    let old = transition_status(&state.status, new_status)?;
    if old != new_status {
        let _ = app_handle.emit(
            "daemon-status-changed",
            serde_json::json!({
                "previous": format!("{:?}", old),
                "current": format!("{:?}", new_status),
            }),
        );
    }
    Ok(old)
}

// ============================================================================
// STATE
// ============================================================================

pub struct DaemonState {
    pub process: Mutex<Option<CommandChild>>,
    pub logs: Mutex<VecDeque<String>>,
    pub status: Mutex<DaemonStatus>,
    /// Incremented on each spawn to distinguish old vs new daemon Terminated events
    pub generation: Mutex<u64>,
}

pub const MAX_LOGS: usize = 50;

// ============================================================================
// LOG MANAGEMENT
// ============================================================================

pub fn add_log(state: &State<DaemonState>, message: String) {
    use std::time::{SystemTime, UNIX_EPOCH};

    // Add timestamp prefix (Unix millis) for proper chronological sorting
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    // Format: "TIMESTAMP|MESSAGE" - will be parsed by frontend
    let timestamped_message = format!("{}|{}", timestamp, message);

    let mut logs = state.logs.lock().unwrap();
    logs.push_back(timestamped_message);
    if logs.len() > MAX_LOGS {
        logs.pop_front();
    }
}

// ============================================================================
// DAEMON LIFECYCLE MANAGEMENT
// ============================================================================

/// Kill processes listening on a specific port
#[cfg(not(target_os = "windows"))]
pub fn kill_processes_on_port(port: u16, signal: Option<&str>) {
    use std::process::Command;

    let output = Command::new("lsof").arg(format!("-ti:{}", port)).output();

    if let Ok(output) = output {
        let pids = String::from_utf8_lossy(&output.stdout);
        for pid in pids.lines() {
            let pid = pid.trim();
            if !pid.is_empty() {
                let mut cmd = Command::new("kill");
                if let Some(sig) = signal {
                    cmd.arg(sig);
                }
                cmd.arg(pid);
                let _ = cmd.output();
            }
        }
    }
}

/// Clean up all daemon processes running on the system (via port 8000)
pub fn cleanup_system_daemons() {
    #[cfg(not(target_os = "windows"))]
    {
        use std::process::Command;

        // Method 1: Kill via port 8000 (more reliable)
        // Try SIGTERM first (graceful shutdown)
        kill_processes_on_port(8000, None);
        std::thread::sleep(std::time::Duration::from_millis(500));

        // Force kill if still there
        kill_processes_on_port(8000, Some("-9"));

        // Method 2: Kill by process name (fallback)
        let _ = Command::new("pkill")
            .arg("-9")
            .arg("-f")
            .arg("reachy_mini.daemon.app.main")
            .output();

        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    #[cfg(target_os = "windows")]
    {
        log::info!("Cleaning up system daemons on Windows...");
        use std::process::Command;

        // Windows: Use netstat and taskkill to find and kill processes on port 8000
        let output = Command::new("netstat").args(&["-ano"]).output();

        if let Ok(output) = output {
            let output_str = String::from_utf8_lossy(&output.stdout);
            let mut pids = Vec::new();
            for line in output_str.lines() {
                if line.contains(":8000") && line.contains("LISTENING") {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    let pid = parts.last().unwrap().to_string();
                    if pid != "0" && !pids.contains(&pid) {
                        pids.push(pid);
                    }
                }
            }
            for pid_str in pids {
                log::info!("Killing process with PID: {}", pid_str);
                let _ = Command::new("taskkill")
                    .args(&["/PID", &pid_str, "/F"])
                    .output();
            }
        }
    }
}

/// Kill daemon completely (local sidecar process + system)
pub fn kill_daemon(state: &State<DaemonState>) {
    // Clear the stored process reference
    // Note: CommandChild doesn't expose kill() method, so we rely on cleanup_system_daemons()
    // which kills processes via port 8000 (more reliable)
    let mut process_lock = state.process.lock().unwrap();
    process_lock.take();
    drop(process_lock);

    // Clean up system processes (kills via port 8000 and process name)
    cleanup_system_daemons();
}

// ============================================================================
// SIDECAR MANAGEMENT
// ============================================================================

/// Macro helper to spawn sidecar monitoring task
/// Avoids duplication while working around private Receiver type.
/// For daemon sidecars (prefix=None), automatically handles DaemonStatus
/// transitions on process termination using a generation counter to avoid
/// stale events from old daemon instances.
#[macro_export]
macro_rules! spawn_sidecar_monitor {
    ($rx:ident, $app_handle:ident, $prefix:expr, $generation:expr) => {{
        let prefix = $prefix;
        let app_handle_clone = $app_handle.clone();
        let captured_generation: u64 = $generation;
        tauri::async_runtime::spawn(async move {
            use tauri::Emitter;
            use tauri::Manager;
            use tauri_plugin_shell::process::CommandEvent;

            if let Some(ref p) = prefix {
                log::info!("[tauri] Starting sidecar output monitoring ({})...", p);
            } else {
                log::info!(
                    "[tauri] Starting sidecar output monitoring (gen {})...",
                    captured_generation
                );
            }

            while let Some(event) = $rx.recv().await {
                match event {
                    CommandEvent::Stdout(line_bytes) => {
                        let line = String::from_utf8_lossy(&line_bytes);
                        let prefixed_line = prefix
                            .as_ref()
                            .map(|p| format!("[{}] {}", p, line))
                            .unwrap_or_else(|| line.to_string());
                        log::info!("Sidecar stdout: {}", prefixed_line);
                        let _ = app_handle_clone.emit("sidecar-stdout", prefixed_line.clone());
                    }
                    CommandEvent::Stderr(line_bytes) => {
                        let line = String::from_utf8_lossy(&line_bytes);
                        let prefixed_line = prefix
                            .as_ref()
                            .map(|p| format!("[{}] {}", p, line))
                            .unwrap_or_else(|| line.to_string());
                        log::warn!("Sidecar stderr: {}", prefixed_line);
                        let _ = app_handle_clone.emit("sidecar-stderr", prefixed_line.clone());
                    }
                    CommandEvent::Terminated(status) => {
                        if let Some(ref p) = prefix {
                            log::info!(
                                "[tauri] [{}] Process terminated with status: {:?}",
                                p, status
                            );
                        } else {
                            log::info!(
                                "[tauri] Sidecar process terminated with status: {:?}",
                                status
                            );

                            let daemon_state =
                                app_handle_clone.state::<crate::daemon::DaemonState>();
                            let current_gen =
                                *daemon_state.generation.lock().unwrap();

                            if captured_generation == current_gen {
                                daemon_state.process.lock().unwrap().take();

                                let current_status =
                                    *daemon_state.status.lock().unwrap();
                                let target = match current_status {
                                    crate::daemon::DaemonStatus::Stopping => {
                                        crate::daemon::DaemonStatus::Idle
                                    }
                                    crate::daemon::DaemonStatus::Running
                                    | crate::daemon::DaemonStatus::Starting => {
                                        crate::daemon::DaemonStatus::Crashed
                                    }
                                    _ => current_status,
                                };

                                if target != current_status {
                                    let _ = crate::daemon::transition_and_emit(
                                        &daemon_state,
                                        target,
                                        &app_handle_clone,
                                    );
                                }
                            } else {
                                log::info!(
                                    "[daemon] Ignoring terminated event for old daemon (gen {} vs current {})",
                                    captured_generation, current_gen
                                );
                            }

                            let status_str = format!("{:?}", status);
                            let _ =
                                app_handle_clone.emit("sidecar-terminated", status_str);
                        }
                    }
                    _ => {}
                }
            }
        });
    }};
}

/// Spawn and monitor the embedded daemon sidecar
///
/// # Arguments
/// * `app_handle` - Tauri app handle
/// * `state` - Daemon state
/// * `sim_mode` - If true, launch daemon in simulation mode (mockup-sim) with --mockup-sim flag
pub fn spawn_and_monitor_sidecar(
    app_handle: tauri::AppHandle,
    state: &State<DaemonState>,
    sim_mode: bool,
) -> Result<(), String> {
    use crate::python::build_daemon_args;
    use tauri_plugin_shell::ShellExt;

    // Check if a sidecar process already exists
    let process_lock = state.process.lock().unwrap();
    if process_lock.is_some() {
        log::info!("[tauri] Sidecar is already running. Skipping spawn.");
        return Ok(());
    }
    drop(process_lock);

    let daemon_args = build_daemon_args(sim_mode)?;

    if sim_mode {
        log::info!("[tauri] Launching daemon in simulation mode (mockup-sim)");
    }

    let daemon_args_refs: Vec<&str> = daemon_args.iter().map(|s| s.as_str()).collect();

    let sidecar_command = app_handle
        .shell()
        .sidecar("uv-trampoline")
        .map_err(|e| e.to_string())?
        .args(daemon_args_refs);

    let (mut rx, child) = sidecar_command.spawn().map_err(|e| e.to_string())?;

    // Bump generation so old Terminated handlers become stale
    let generation = {
        let mut gen = state.generation.lock().unwrap();
        *gen += 1;
        *gen
    };

    let mut process_lock = state.process.lock().unwrap();
    *process_lock = Some(child);
    drop(process_lock);

    // Spawn async task to monitor sidecar output
    crate::spawn_sidecar_monitor!(rx, app_handle, None::<String>, generation);

    Ok(())
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn status_mutex(initial: DaemonStatus) -> Mutex<DaemonStatus> {
        Mutex::new(initial)
    }

    // ========================================================================
    // Transition table: exhaustive valid/invalid
    // ========================================================================

    #[test]
    fn every_valid_transition_is_accepted() {
        for (from, to) in VALID_DAEMON_TRANSITIONS.iter() {
            assert!(
                is_valid_transition(*from, *to),
                "{:?} -> {:?} should be valid",
                from,
                to
            );
        }
    }

    #[test]
    fn all_unlisted_transitions_are_rejected() {
        let all = [
            DaemonStatus::Idle,
            DaemonStatus::Starting,
            DaemonStatus::Running,
            DaemonStatus::Stopping,
            DaemonStatus::Crashed,
        ];
        for from in all.iter() {
            for to in all.iter() {
                if from == to {
                    continue;
                }
                let is_listed = VALID_DAEMON_TRANSITIONS
                    .iter()
                    .any(|(f, t)| f == from && t == to);
                if is_listed {
                    continue;
                }
                assert!(
                    !is_valid_transition(*from, *to),
                    "{:?} -> {:?} should be invalid",
                    from,
                    to
                );
            }
        }
    }

    // ========================================================================
    // transition_status: mutex behavior
    // ========================================================================

    #[test]
    fn transition_returns_previous_status() {
        let lock = status_mutex(DaemonStatus::Idle);
        let prev = transition_status(&lock, DaemonStatus::Starting).unwrap();
        assert_eq!(prev, DaemonStatus::Idle);
        assert_eq!(*lock.lock().unwrap(), DaemonStatus::Starting);
    }

    #[test]
    fn invalid_transition_leaves_state_unchanged() {
        let lock = status_mutex(DaemonStatus::Idle);
        let result = transition_status(&lock, DaemonStatus::Running);
        assert!(result.is_err());
        assert_eq!(*lock.lock().unwrap(), DaemonStatus::Idle);
    }

    #[test]
    fn same_state_is_noop_and_returns_ok() {
        let lock = status_mutex(DaemonStatus::Running);
        let prev = transition_status(&lock, DaemonStatus::Running).unwrap();
        assert_eq!(prev, DaemonStatus::Running);
    }

    // ========================================================================
    // Real lifecycle scenarios
    // ========================================================================

    #[test]
    fn clean_start_stop_cycle() {
        let lock = status_mutex(DaemonStatus::Idle);
        transition_status(&lock, DaemonStatus::Starting).unwrap();
        transition_status(&lock, DaemonStatus::Running).unwrap();
        transition_status(&lock, DaemonStatus::Stopping).unwrap();
        transition_status(&lock, DaemonStatus::Idle).unwrap();
        assert_eq!(*lock.lock().unwrap(), DaemonStatus::Idle);
    }

    #[test]
    fn crash_during_startup_then_restart() {
        let lock = status_mutex(DaemonStatus::Idle);
        transition_status(&lock, DaemonStatus::Starting).unwrap();
        transition_status(&lock, DaemonStatus::Crashed).unwrap();
        // Restart directly from Crashed
        transition_status(&lock, DaemonStatus::Starting).unwrap();
        transition_status(&lock, DaemonStatus::Running).unwrap();
        assert_eq!(*lock.lock().unwrap(), DaemonStatus::Running);
    }

    #[test]
    fn crash_while_running_then_go_idle() {
        let lock = status_mutex(DaemonStatus::Idle);
        transition_status(&lock, DaemonStatus::Starting).unwrap();
        transition_status(&lock, DaemonStatus::Running).unwrap();
        transition_status(&lock, DaemonStatus::Crashed).unwrap();
        // User chooses to go back to idle (disconnect)
        transition_status(&lock, DaemonStatus::Idle).unwrap();
        assert_eq!(*lock.lock().unwrap(), DaemonStatus::Idle);
    }

    #[test]
    fn stopping_is_a_dead_end_except_idle() {
        let lock = status_mutex(DaemonStatus::Stopping);
        assert!(transition_status(&lock, DaemonStatus::Starting).is_err());
        assert!(transition_status(&lock, DaemonStatus::Running).is_err());
        assert!(transition_status(&lock, DaemonStatus::Crashed).is_err());
        assert!(transition_status(&lock, DaemonStatus::Idle).is_ok());
    }

    // ========================================================================
    // Generation counter: prevents stale Terminated handlers
    // ========================================================================

    #[test]
    fn generation_counter_starts_at_zero() {
        let state = DaemonState {
            process: Mutex::new(None),
            logs: Mutex::new(VecDeque::new()),
            status: Mutex::new(DaemonStatus::Idle),
            generation: Mutex::new(0),
        };
        assert_eq!(*state.generation.lock().unwrap(), 0);
    }

    #[test]
    fn generation_counter_increments_prevent_stale_handlers() {
        let state = DaemonState {
            process: Mutex::new(None),
            logs: Mutex::new(VecDeque::new()),
            status: Mutex::new(DaemonStatus::Running),
            generation: Mutex::new(1),
        };

        // Simulate daemon restart: new generation
        {
            let mut gen = state.generation.lock().unwrap();
            *gen += 1;
        }
        *state.status.lock().unwrap() = DaemonStatus::Running;

        // Old handler (gen=1) tries to crash the new daemon (gen=2)
        let old_gen = 1u64;
        let current_gen = *state.generation.lock().unwrap();
        assert_ne!(old_gen, current_gen);

        // The handler should NOT transition because generations don't match
        if old_gen == current_gen {
            // This path should NOT execute
            let _ = transition_status(&state.status, DaemonStatus::Crashed);
        }

        assert_eq!(*state.status.lock().unwrap(), DaemonStatus::Running);
    }

    #[test]
    fn current_generation_handler_can_transition() {
        let state = DaemonState {
            process: Mutex::new(None),
            logs: Mutex::new(VecDeque::new()),
            status: Mutex::new(DaemonStatus::Running),
            generation: Mutex::new(3),
        };

        let captured_gen = 3u64;
        let current_gen = *state.generation.lock().unwrap();
        assert_eq!(captured_gen, current_gen);

        // Current-gen handler should be allowed to crash
        let _ = transition_status(&state.status, DaemonStatus::Crashed);
        assert_eq!(*state.status.lock().unwrap(), DaemonStatus::Crashed);
    }

    // ========================================================================
    // Race: stop vs terminated event
    // ========================================================================

    #[test]
    fn stop_then_terminated_converge_to_idle() {
        let lock = status_mutex(DaemonStatus::Running);

        // stop_daemon transitions Running -> Stopping
        transition_status(&lock, DaemonStatus::Stopping).unwrap();

        // Terminated handler sees Stopping -> transitions to Idle
        transition_status(&lock, DaemonStatus::Idle).unwrap();
        assert_eq!(*lock.lock().unwrap(), DaemonStatus::Idle);

        // stop_daemon's second transition (Stopping -> Idle) is now a no-op
        let result = transition_status(&lock, DaemonStatus::Idle);
        assert!(result.is_ok());
        assert_eq!(*lock.lock().unwrap(), DaemonStatus::Idle);
    }

    #[test]
    fn double_stop_is_harmless() {
        let lock = status_mutex(DaemonStatus::Running);
        transition_status(&lock, DaemonStatus::Stopping).unwrap();

        // Second stop attempt: Stopping -> Stopping (same state = no-op)
        let result = transition_status(&lock, DaemonStatus::Stopping);
        assert!(result.is_ok());
        assert_eq!(*lock.lock().unwrap(), DaemonStatus::Stopping);
    }

    #[test]
    fn rapid_restart_increments_generation() {
        let state = DaemonState {
            process: Mutex::new(None),
            logs: Mutex::new(VecDeque::new()),
            status: Mutex::new(DaemonStatus::Idle),
            generation: Mutex::new(0),
        };

        for i in 1..=5 {
            {
                let mut gen = state.generation.lock().unwrap();
                *gen += 1;
            }
            assert_eq!(*state.generation.lock().unwrap(), i);
        }
    }
}
