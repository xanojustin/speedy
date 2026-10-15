//! U12: notifications and Dock badge for threads needing attention (R5, R6).
//!
//! [`AttentionState`] is a Tauri-free state machine fed status transitions, the visible
//! thread and app focus; it returns [`Effect`]s. [`Attention`] wraps it and performs them:
//! `UNUserNotificationCenter` notifications (whose click opens the thread), the Dock badge,
//! and the unread set sent to the UI.
//!
//! A thread "has attention" when the user isn't looking at it (it's hidden, or the app isn't
//! focused) and it entered AwaitingUser, finished a turn (Working → Idle, "unread"), or
//! Crashed. The Dock badge counts those threads. The flag clears when the user views the
//! thread (visible while focused, or `attention_mark_read`) or the thread leaves that state.
//!
//! Flapping rule: within one turn (from leaving a resting state until it returns to one),
//! entering AwaitingUser notifies at most once. Later permission prompts in the same turn
//! re-raise the badge silently. Finishing and crashing are separate events and always notify.

use std::collections::{BTreeSet, HashMap};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::claude::ThreadStatus;

/// App event emitted when a notification is clicked: payload `{ threadId }`.
pub const OPEN_THREAD_EVENT: &str = "attention-open-thread";
/// App event with the full unread set: payload `{ unread: string[] }`.
pub const UNREAD_EVENT: &str = "attention-unread";

const FALLBACK_TITLE: &str = "Claude thread";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenThread {
    pub thread_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreadSet {
    pub unread: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification {
    pub thread_id: String,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    Notify(Notification),
    /// Threads needing attention; 0 clears the badge.
    SetBadge(usize),
    /// The finished-unread thread ids, sorted.
    EmitUnread(Vec<String>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Flag {
    Awaiting,
    Unread,
    Crashed,
}

#[derive(Debug, Default)]
struct ThreadAttention {
    flag: Option<Flag>,
    /// Set once the turn has posted its "needs your input" notification.
    awaiting_notified: bool,
}

#[derive(Debug, Default)]
pub struct AttentionState {
    visible: Option<String>,
    /// Starts unfocused, so nothing is missed before the first focus event.
    focused: bool,
    titles: HashMap<String, String>,
    threads: HashMap<String, ThreadAttention>,
    last_badge: usize,
    last_unread: Vec<String>,
}

fn is_resting(s: ThreadStatus) -> bool {
    !matches!(s, ThreadStatus::Starting | ThreadStatus::Working | ThreadStatus::AwaitingUser)
}

impl AttentionState {
    /// Thread titles reported by the UI (used when the caller doesn't pass one).
    pub fn set_titles(&mut self, titles: HashMap<String, String>) {
        self.titles = titles;
    }

    fn seen(&self, thread_id: &str) -> bool {
        self.focused && self.visible.as_deref() == Some(thread_id)
    }

    fn title_for(&self, thread_id: &str, title: &str) -> String {
        if !title.is_empty() {
            return title.to_string();
        }
        match self.titles.get(thread_id) {
            Some(t) if !t.is_empty() => t.clone(),
            _ => FALLBACK_TITLE.to_string(),
        }
    }

    pub fn on_status(&mut self, thread_id: &str, from: ThreadStatus, to: ThreadStatus) -> Vec<Effect> {
        self.on_status_titled(thread_id, "", from, to)
    }

    pub fn on_status_titled(&mut self, thread_id: &str, title: &str, from: ThreadStatus, to: ThreadStatus) -> Vec<Effect> {
        let seen = self.seen(thread_id);
        let title = self.title_for(thread_id, title);
        let t = self.threads.entry(thread_id.to_string()).or_default();
        if is_resting(from) && !is_resting(to) {
            t.awaiting_notified = false;
        }
        // Any transition leaves whatever state the previous flag was about.
        t.flag = None;
        let mut fx = Vec::new();
        if !seen {
            let body = match (from, to) {
                (_, ThreadStatus::AwaitingUser) => {
                    t.flag = Some(Flag::Awaiting);
                    (!std::mem::replace(&mut t.awaiting_notified, true)).then_some("Needs your input")
                }
                (ThreadStatus::Working, ThreadStatus::Idle) => {
                    t.flag = Some(Flag::Unread);
                    Some("Finished")
                }
                (_, ThreadStatus::Crashed) => {
                    t.flag = Some(Flag::Crashed);
                    Some("Claude crashed. Open the thread to retry.")
                }
                _ => None,
            };
            if let Some(body) = body {
                fx.push(Effect::Notify(Notification { thread_id: thread_id.to_string(), title, body: body.into() }));
            }
        }
        self.recompute(fx)
    }

    pub fn set_visible(&mut self, thread_id: Option<String>) -> Vec<Effect> {
        self.visible = thread_id;
        self.clear_seen()
    }

    pub fn set_app_focused(&mut self, focused: bool) -> Vec<Effect> {
        self.focused = focused;
        self.clear_seen()
    }

    pub fn mark_read(&mut self, thread_id: &str) -> Vec<Effect> {
        if let Some(t) = self.threads.get_mut(thread_id) {
            t.flag = None;
        }
        self.recompute(Vec::new())
    }

    fn clear_seen(&mut self) -> Vec<Effect> {
        if let Some(id) = self.visible.clone().filter(|id| self.seen(id)) {
            return self.mark_read(&id);
        }
        Vec::new()
    }

    fn recompute(&mut self, mut fx: Vec<Effect>) -> Vec<Effect> {
        let badge = self.threads.values().filter(|t| t.flag.is_some()).count();
        let unread: Vec<String> = self
            .threads
            .iter()
            .filter(|(_, t)| t.flag == Some(Flag::Unread))
            .map(|(id, _)| id.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        if badge != self.last_badge {
            self.last_badge = badge;
            fx.push(Effect::SetBadge(badge));
        }
        if unread != self.last_unread {
            self.last_unread = unread.clone();
            fx.push(Effect::EmitUnread(unread));
        }
        fx
    }
}

/// Applies [`AttentionState`] effects to the real app.
pub struct Attention {
    app: AppHandle,
    state: Mutex<AttentionState>,
    notifier: Option<platform::Notifier>,
}

impl Attention {
    pub fn new(app: AppHandle) -> Self {
        let notifier = platform::Notifier::install(app.clone());
        Attention { app, state: Mutex::new(AttentionState::default()), notifier }
    }

    /// Called by the session actor on every status transition.
    pub fn on_status(&self, thread_id: &str, thread_title: &str, from: ThreadStatus, to: ThreadStatus) {
        let fx = self.state.lock().on_status_titled(thread_id, thread_title, from, to);
        self.apply(fx);
    }

    pub fn set_app_focused(&self, focused: bool) {
        let fx = self.state.lock().set_app_focused(focused);
        self.apply(fx);
    }

    pub fn set_visible(&self, thread_id: Option<String>) {
        let fx = self.state.lock().set_visible(thread_id);
        self.apply(fx);
    }

    pub fn mark_read(&self, thread_id: &str) {
        let fx = self.state.lock().mark_read(thread_id);
        self.apply(fx);
    }

    pub fn set_titles(&self, titles: HashMap<String, String>) {
        self.state.lock().set_titles(titles);
    }

    fn apply(&self, effects: Vec<Effect>) {
        for e in effects {
            match e {
                Effect::Notify(n) => match &self.notifier {
                    Some(notifier) => notifier.post(&n),
                    None => log::info!("notification skipped (not available): {} — {}", n.title, n.body),
                },
                Effect::SetBadge(count) => {
                    let Some(window) = self.app.get_webview_window("main") else { continue };
                    let count = (count > 0).then_some(count as i64);
                    if let Err(e) = window.set_badge_count(count) {
                        log::warn!("setting the Dock badge failed: {e}");
                    }
                }
                Effect::EmitUnread(unread) => {
                    if let Err(e) = self.app.emit(UNREAD_EVENT, UnreadSet { unread }) {
                        log::warn!("emitting {UNREAD_EVENT} failed: {e}");
                    }
                }
            }
        }
    }
}

/// Shows and focuses the main window and tells the UI to open the thread.
fn open_thread(app: &AppHandle, thread_id: String) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Err(e) = app.emit(OPEN_THREAD_EVENT, OpenThread { thread_id }) {
        log::warn!("emitting {OPEN_THREAD_EVENT} failed: {e}");
    }
}

#[cfg(target_os = "macos")]
mod platform {
    //! `UNUserNotificationCenter`: it only works from a bundled .app (it raises an
    //! Objective-C exception otherwise), so the bundle is checked first.

    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{AllocAnyThread, DefinedClass, define_class, msg_send};
    use objc2_foundation::{NSBundle, NSDictionary, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions,
        UNNotificationRequest, UNNotificationResponse, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use tauri::AppHandle;

    use super::Notification;

    const THREAD_ID_KEY: &str = "threadId";

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "SpeedyNotificationDelegate"]
        #[ivars = AppHandle]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            /// Show banners while the app is active (we only post for threads not on screen).
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                handler: &DynBlock<dyn Fn()>,
            ) {
                let info = response.notification().request().content().userInfo();
                // SAFETY: we only ever put NSString keys in userInfo.
                let info: &NSDictionary<NSString, AnyObject> = unsafe { &*((&*info) as *const NSDictionary as *const _) };
                let id = info
                    .objectForKey(&NSString::from_str(THREAD_ID_KEY))
                    .and_then(|v| v.downcast::<NSString>().ok())
                    .map(|s| s.to_string());
                match id {
                    Some(id) => super::open_thread(self.ivars(), id),
                    None => log::warn!("notification response without a thread id"),
                }
                handler.call(());
            }
        }
    );

    impl Delegate {
        fn new(app: AppHandle) -> Retained<Self> {
            let this = Self::alloc().set_ivars(app);
            unsafe { msg_send![super(this), init] }
        }
    }

    pub struct Notifier {
        center: Retained<UNUserNotificationCenter>,
        _delegate: Retained<Delegate>,
    }

    // SAFETY: UNUserNotificationCenter is documented thread-safe; the delegate is only
    // retained here to keep it alive (the center holds it weakly).
    unsafe impl Send for Notifier {}
    unsafe impl Sync for Notifier {}

    fn is_bundled_app() -> bool {
        let bundle = NSBundle::mainBundle();
        bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
    }

    impl Notifier {
        /// Sets the click delegate and requests authorization once. None when not bundled.
        pub fn install(app: AppHandle) -> Option<Notifier> {
            if !is_bundled_app() {
                log::info!("notifications unavailable: not running from a bundled .app");
                return None;
            }
            let center = UNUserNotificationCenter::currentNotificationCenter();
            let delegate = Delegate::new(app);
            center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            let done = RcBlock::new(|granted: Bool, err: *mut NSError| {
                if let Some(err) = unsafe { err.as_ref() } {
                    log::warn!("notification authorization failed: {}", err.localizedDescription());
                } else if !granted.as_bool() {
                    log::info!("notifications not authorized by the user");
                }
            });
            center.requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                &done,
            );
            Some(Notifier { center, _delegate: delegate })
        }

        pub fn post(&self, n: &Notification) {
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(&n.title));
            content.setBody(&NSString::from_str(&n.body));
            content.setThreadIdentifier(&NSString::from_str(&n.thread_id));
            let key = NSString::from_str(THREAD_ID_KEY);
            let value = NSString::from_str(&n.thread_id);
            let info = NSDictionary::<NSString, NSString>::from_slices(&[&*key], &[&*value]);
            // SAFETY: userInfo must be a property-list dictionary; NSString→NSString is.
            unsafe { content.setUserInfo(&*((&*info) as *const NSDictionary<NSString, NSString> as *const NSDictionary)) };
            let id = NSString::from_str(&uuid::Uuid::new_v4().to_string());
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);
            let done = RcBlock::new(|err: *mut NSError| {
                if let Some(err) = unsafe { err.as_ref() } {
                    log::warn!("posting a notification failed: {}", err.localizedDescription());
                }
            });
            self.center.addNotificationRequest_withCompletionHandler(&request, Some(&done));
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use tauri::AppHandle;

    use super::Notification;

    pub struct Notifier;

    impl Notifier {
        pub fn install(_app: AppHandle) -> Option<Notifier> {
            log::info!("notifications unavailable on this platform");
            None
        }

        pub fn post(&self, _n: &Notification) {}
    }
}

/// The thread currently visible in the UI (None when nothing is selected).
#[tauri::command]
pub fn attention_set_visible(ctx: tauri::State<'_, crate::AppCtx>, thread_id: Option<String>) {
    ctx.attention.set_visible(thread_id);
}

#[tauri::command]
pub fn attention_mark_read(ctx: tauri::State<'_, crate::AppCtx>, thread_id: String) {
    ctx.attention.mark_read(&thread_id);
}

/// Thread id → title, so notifications can name the thread.
#[tauri::command]
pub fn attention_set_titles(ctx: tauri::State<'_, crate::AppCtx>, titles: HashMap<String, String>) {
    ctx.attention.set_titles(titles);
}
