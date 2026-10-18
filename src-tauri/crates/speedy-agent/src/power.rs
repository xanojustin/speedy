//! U7: keeps the host awake while any thread is working (KTD8), with the same in-process
//! IOKit assertion `caffeinate -i` takes. A prompt waiting for the user, an idle thread, or
//! a stopped one lets the host sleep as usual.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use speedy_core::claude::ThreadStatus;
use tokio::sync::mpsc::UnboundedReceiver;

pub trait PowerBackend: Send {
    fn hold(&mut self);
    fn release(&mut self);
}

/// Follows host events and holds `backend` while at least one thread is Working.
pub async fn hold_awake_while_working(
    initial: HashMap<String, ThreadStatus>,
    mut events: UnboundedReceiver<Arc<Value>>,
    mut backend: impl PowerBackend,
) {
    let mut working: std::collections::HashSet<String> =
        initial.into_iter().filter(|(_, s)| *s == ThreadStatus::Working).map(|(id, _)| id).collect();
    let mut held = false;
    loop {
        if !working.is_empty() && !held {
            backend.hold();
            held = true;
        } else if working.is_empty() && held {
            backend.release();
            held = false;
        }
        let Some(event) = events.recv().await else { break };
        let id = event["id"].as_str().unwrap_or_default().to_owned();
        match event["kind"].as_str() {
            Some("thread_status") if event["status"] == "working" => {
                working.insert(id);
            }
            Some("thread_status") | Some("thread_removed") => {
                working.remove(&id);
            }
            _ => {}
        }
    }
    if held {
        backend.release();
    }
}

/// `PreventUserIdleSystemSleep` through IOKit.
#[derive(Default)]
pub struct IdleSleepAssertion {
    #[cfg(target_os = "macos")]
    id: Option<u32>,
}

#[cfg(target_os = "macos")]
mod iokit {
    use std::ffi::{c_char, c_void};

    pub type CFStringRef = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        pub fn CFStringCreateWithCString(alloc: *const c_void, s: *const c_char, encoding: u32) -> CFStringRef;
        pub fn CFRelease(cf: *const c_void);
    }
    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        pub fn IOPMAssertionCreateWithName(kind: CFStringRef, level: u32, name: CFStringRef, id: *mut u32) -> i32;
        pub fn IOPMAssertionRelease(id: u32) -> i32;
    }
    pub const UTF8: u32 = 0x0800_0100;
    pub const LEVEL_ON: u32 = 255;
}

#[cfg(target_os = "macos")]
impl PowerBackend for IdleSleepAssertion {
    fn hold(&mut self) {
        use iokit::*;
        unsafe {
            let kind = CFStringCreateWithCString(std::ptr::null(), c"PreventUserIdleSystemSleep".as_ptr(), UTF8);
            let name = CFStringCreateWithCString(std::ptr::null(), c"Speedy: a Claude thread is working".as_ptr(), UTF8);
            let mut id = 0u32;
            if IOPMAssertionCreateWithName(kind, LEVEL_ON, name, &mut id) == 0 {
                self.id = Some(id);
            } else {
                log::warn!("couldn't take the idle-sleep assertion");
            }
            CFRelease(kind);
            CFRelease(name);
        }
    }

    fn release(&mut self) {
        if let Some(id) = self.id.take() {
            unsafe { iokit::IOPMAssertionRelease(id) };
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl PowerBackend for IdleSleepAssertion {
    fn hold(&mut self) {}
    fn release(&mut self) {}
}
