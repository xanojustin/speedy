//! Process-group signalling shared by the `claude` actors and the PTYs (KTD9).

use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(20);

/// Sends `signal` to every process in group `pgid`; errors (e.g. ESRCH) are ignored.
pub fn signal_group(pgid: i32, signal: i32) {
    // SAFETY: killpg has no memory-safety preconditions.
    unsafe {
        libc::killpg(pgid, signal);
    }
}

/// True while any process (including an unreaped zombie) remains in the group.
pub fn group_alive(pgid: i32) -> bool {
    // SAFETY: signal 0 only checks for existence.
    unsafe { libc::killpg(pgid, 0) == 0 }
}

/// Blocking wait for every group to empty, up to `grace`; SIGKILLs the survivors.
pub fn reap_groups_blocking(pgids: &[i32], grace: Duration) {
    let deadline = Instant::now() + grace;
    while pgids.iter().any(|&g| group_alive(g)) && Instant::now() < deadline {
        std::thread::sleep(POLL);
    }
    for &g in pgids {
        if group_alive(g) {
            signal_group(g, libc::SIGKILL);
        }
    }
}

/// Async variant of [`reap_groups_blocking`] for one group.
pub async fn reap_group(pgid: i32, grace: Duration) {
    let deadline = Instant::now() + grace;
    while group_alive(pgid) && Instant::now() < deadline {
        tokio::time::sleep(POLL).await;
    }
    if group_alive(pgid) {
        signal_group(pgid, libc::SIGKILL);
    }
}
