//! U11: when the Mac wakes, every SSH master is torn down and every host reconnects at once
//! (KTD14). A master that survived sleep often has a socket that looks open but hangs, so
//! waiting for heartbeats to notice would leave the sidebar stale for half a minute.

/// Calls `on_wake` on each wake. The observer lives for the rest of the process.
#[cfg(target_os = "macos")]
pub fn on_wake(on_wake: impl Fn() + Send + Sync + 'static) {
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
    use objc2_foundation::NSNotification;

    let block = RcBlock::new(move |_note: NonNull<NSNotification>| on_wake());
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    // SAFETY: the name is AppKit's constant, no object filter, and the main queue (None)
    // delivers on the thread that registered; the block only spawns async work.
    let observer = unsafe { center.addObserverForName_object_queue_usingBlock(Some(NSWorkspaceDidWakeNotification), None, None, &block) };
    // Kept registered until exit.
    std::mem::forget(observer);
}

#[cfg(not(target_os = "macos"))]
pub fn on_wake(_on_wake: impl Fn() + Send + Sync + 'static) {}
