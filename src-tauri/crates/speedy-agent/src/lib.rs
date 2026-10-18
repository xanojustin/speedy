//! U6: the headless per-host agent (KTD1, KTD2, KTD8). It owns every thread, terminal, file
//! and git operation on its host and serves the app over a unix socket, reached directly on
//! This Mac or through `speedy-agent proxy` over SSH. The binary in `main.rs` is a thin shell
//! around [`daemon`] and [`server`].

pub mod clients;
pub mod daemon;
pub mod daemonize;
pub mod launchd;
pub mod logs;
pub mod paths;
pub mod power;
pub mod pty_ring;
pub mod server;
pub mod token;
