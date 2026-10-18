//! `speedy-agent run | proxy | install | version [--json] | stop` (U6, U7).

use std::process::ExitCode;

use speedy_agent::logs::FileLog;
use speedy_agent::paths::AgentPaths;
use speedy_agent::{daemon, launchd};
use speedy_agent::server::{AGENT_VERSION, BUILD_SHA};
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
        Some("proxy") => ExitCode::from(runtime().block_on(daemon::proxy(AgentPaths::from_env())) as u8),
        Some("stop") => match runtime().block_on(daemon::stop(AgentPaths::from_env())) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("speedy-agent: {e}");
                ExitCode::FAILURE
            }
        },
        // Run from the staged binary: points `bin/current` at it, then (re)starts the agent.
        Some("install") => {
            let paths = AgentPaths::from_env();
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
                serde_json::json!({"version": AGENT_VERSION, "protocolMin": PROTOCOL_MIN, "protocolMax": PROTOCOL_MAX, "buildSha": BUILD_SHA})
            );
            ExitCode::SUCCESS
        }
        Some("version") => {
            println!("speedy-agent {AGENT_VERSION} ({BUILD_SHA})");
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: speedy-agent run | proxy | install | version [--json] | stop");
            ExitCode::from(2)
        }
    }
}
