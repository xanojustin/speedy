//! `speedy-agent run | proxy | version [--json] | stop` (U6).

use std::io::Write;
use std::process::ExitCode;

use speedy_agent::daemon;
use speedy_agent::paths::AgentPaths;
use speedy_agent::server::{AGENT_VERSION, BUILD_SHA};
use speedy_core::proto::{PROTOCOL_MAX, PROTOCOL_MIN};

/// Logs to stderr, which launchd sends to the agent's log file.
struct StderrLog;

impl log::Log for StderrLog {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= log::Level::Info
    }
    fn log(&self, r: &log::Record) {
        if self.enabled(r.metadata()) {
            let _ = writeln!(std::io::stderr(), "{} {}: {}", r.level(), r.target(), r.args());
        }
    }
    fn flush(&self) {}
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let runtime = || tokio::runtime::Runtime::new().expect("tokio runtime");
    match args.first().map(String::as_str) {
        Some("run") => {
            let _ = log::set_logger(&StderrLog).map(|()| log::set_max_level(log::LevelFilter::Info));
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
            eprintln!("usage: speedy-agent run | proxy | version [--json] | stop");
            ExitCode::from(2)
        }
    }
}
