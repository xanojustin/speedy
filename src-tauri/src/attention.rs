//! U12: performs the core [`AttentionState`] effects in the real app: `UNUserNotificationCenter`
//! notifications (whose click opens the thread), the Dock badge, and the unread set sent to the UI.

use std::collections::HashMap;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager};

use speedy_core::attention::{AttentionState, Effect, Notification, OPEN_THREAD_EVENT, OpenThread, SOUNDS, UNREAD_EVENT, UnreadSet};
use speedy_core::claude::ThreadStatus;

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

    pub fn set_prefs(&self, notifications: bool, sound: Option<String>) {
        self.state.lock().set_prefs(notifications, sound);
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
                Effect::PlaySound(name) => platform::play_sound(&self.app, name),
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
    use objc2_app_kit::NSSound;
    use objc2_foundation::{NSBundle, NSDictionary, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions,
        UNNotificationRequest, UNNotificationResponse, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use tauri::AppHandle;

    use super::Notification;

    const THREAD_ID_KEY: &str = "threadId";

    /// Plays a system sound by name (restarting it if it's still playing).
    pub fn play_sound(app: &AppHandle, name: String) {
        let res = app.run_on_main_thread(move || match NSSound::soundNamed(&NSString::from_str(&name)) {
            Some(sound) => {
                sound.stop();
                if !sound.play() {
                    log::warn!("playing sound {name} failed");
                }
            }
            None => log::warn!("system sound {name} not found"),
        });
        if let Err(e) = res {
            log::warn!("scheduling a sound failed: {e}");
        }
    }

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

    pub fn play_sound(_app: &AppHandle, _name: String) {}

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

/// The user's notification settings (mirrors `notificationsEnabled` / `completionSound`).
#[tauri::command]
pub fn attention_set_prefs(ctx: tauri::State<'_, crate::AppCtx>, notifications: bool, sound: Option<String>) {
    ctx.attention.set_prefs(notifications, sound);
}

/// Plays one of [`SOUNDS`] (the settings preview).
#[tauri::command]
pub fn play_sound(app: AppHandle, name: String) -> Result<(), String> {
    if !SOUNDS.contains(&name.as_str()) {
        return Err(format!("unknown sound {name}"));
    }
    platform::play_sound(&app, name);
    Ok(())
}
