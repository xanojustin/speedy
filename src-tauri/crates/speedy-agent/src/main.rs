//! `speedy-agent run | proxy | install | status | version [--json] | stop` (U6, U7, U11).

use std::process::ExitCode;

use speedy_agent::logs::FileLog;
use speedy_agent::paths::AgentPaths;
use speedy_agent::{daemon, launchd};
use speedy_agent::server::{AGENT_VERSION, BUILD_SHA, BUILD_TIME};
use speedy_core::proto::{PROTOCOL_MAX, PROTOCOL_MIN};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let runtime = || tokio::runtime::Runtime::new().expect("tokio runtime");
    match args.first().map(String::as_str) {
        Some("run") => {
            let _ = log::set_logger(Box::leak(Box::new(FileLog::new()))).map(|()| log::set_max_level(log::LevelFilter::Info));
            match runtime().block_on(daemon::run(AgentPaths::from_env())) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("speedy-agent: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        // For a probe: 0 when an agent is running, `EXIT_NOT_RUNNING` when not.
        Some("status") => {
            let running = daemon::agent_running(&AgentPaths::from_env());
            ExitCode::from(if running { 0 } else { daemon::EXIT_NOT_RUNNING as u8 })
        }
        Some("proxy") => ExitCode::from(runtime().block_on(daemon::proxy(AgentPaths::from_env())) as u8),
        Some("stop") => match runtime().block_on(daemon::stop(AgentPaths::from_env())) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("speedy-agent: {e}");
                ExitCode::FAILURE
            }
        },
        // Run from the staged binary: replaces a running agent only if it's idle, then points
        // `bin/current` at this build and starts it. A busy agent keeps running on its build,
        // and `install` exits `EXIT_BUSY` so the app shows the update as pending (KTD9).
        Some("install") => {
            let paths = AgentPaths::from_env();
            match runtime().block_on(daemon::restart_if_idle(&paths)) {
                Ok(true) => {}
                Ok(false) => {
                    println!("{}", serde_json::json!({"started": null, "busy": true}));
                    return ExitCode::from(daemon::EXIT_BUSY as u8);
                }
                Err(e) => {
                    eprintln!("speedy-agent: replacing the running agent: {e}");
                    return ExitCode::FAILURE;
                }
            }
            let staged = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|d| d.to_path_buf()));
            let home = std::env::var_os("SPEEDY_AGENT_HOME").map(std::path::PathBuf::from);
            let result = staged
                .ok_or_else(|| std::io::Error::other("can't find this binary's folder"))
                .and_then(|dir| launchd::set_current(&paths, &dir))
                .and_then(|()| launchd::install(&paths, home.as_deref()));
            match result {
                Ok(how) => {
                    println!("{}", serde_json::json!({"started": how}));
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("speedy-agent: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Some("version") if args.iter().any(|a| a == "--json") => {
            println!(
                "{}",
                serde_json::json!({"version": AGENT_VERSION, "protocolMin": PROTOCOL_MIN, "protocolMax": PROTOCOL_MAX, "buildSha": BUILD_SHA, "buildTime": BUILD_TIME.parse::<u64>().unwrap_or(0)})
            );
            ExitCode::SUCCESS
        }
        Some("version") => {
            println!("speedy-agent {AGENT_VERSION} ({BUILD_SHA})");
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: speedy-agent run | proxy | install | status | version [--json] | stop");
            ExitCode::from(2)
        }
    }
}
