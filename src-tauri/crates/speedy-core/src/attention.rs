//! U12: notifications and Dock badge for threads needing attention (R5, R6).
//!
//! [`AttentionState`] is a Tauri-free state machine fed status transitions, the visible
//! thread and app focus; it returns [`Effect`]s. The app's `Attention` wraps it and performs them:
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
//!
//! Settings: notifications can be turned off (the badge and unread set still update), and an
//! attention sound plays whenever a thread needs attention (finished, needs input, crashed;
//! same once-per-turn rule for input), whether or not it's on screen.

use std::collections::{BTreeSet, HashMap};

use serde::Serialize;

use crate::claude::ThreadStatus;

/// App event emitted when a notification is clicked: payload `{ threadId }`.
pub const OPEN_THREAD_EVENT: &str = "attention-open-thread";
/// App event with the full unread set: payload `{ unread: string[] }`.
pub const UNREAD_EVENT: &str = "attention-unread";

const FALLBACK_TITLE: &str = "Claude thread";

/// The macOS system sounds (/System/Library/Sounds) offered as completion sounds.
pub const SOUNDS: &[&str] = &[
    "Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi",
    "Submarine", "Tink",
];

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
    /// A system sound name from [`SOUNDS`].
    PlaySound(String),
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
    /// Notifications are on unless the user turned them off.
    notifications_off: bool,
    completion_sound: Option<String>,
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

    /// The user's notification settings; unknown sound names are treated as silent.
    pub fn set_prefs(&mut self, notifications: bool, sound: Option<String>) {
        self.notifications_off = !notifications;
        self.completion_sound = sound.filter(|s| SOUNDS.contains(&s.as_str()));
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
        let (flag, body) = match (from, to) {
            (_, ThreadStatus::AwaitingUser) => {
                (Flag::Awaiting, (!std::mem::replace(&mut t.awaiting_notified, true)).then_some("Needs your input"))
            }
            (ThreadStatus::Working, ThreadStatus::Idle) => (Flag::Unread, Some("Finished")),
            (_, ThreadStatus::Crashed) => (Flag::Crashed, Some("Claude crashed. Open the thread to retry.")),
            _ => return self.recompute(Vec::new()),
        };
        let mut fx = Vec::new();
        // The sound plays even for the thread on screen; flags and notifications are for unseen ones.
        if let (Some(_), Some(sound)) = (body, &self.completion_sound) {
            fx.push(Effect::PlaySound(sound.clone()));
        }
        if !seen {
            t.flag = Some(flag);
            if let Some(body) = body.filter(|_| !self.notifications_off) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use ThreadStatus::*;

    fn notifies(fx: &[Effect]) -> bool {
        fx.iter().any(|e| matches!(e, Effect::Notify(_)))
    }

    fn sound(fx: &[Effect]) -> Option<&str> {
        fx.iter().find_map(|e| match e {
            Effect::PlaySound(s) => Some(s.as_str()),
            _ => None,
        })
    }

    #[test]
    fn finishing_notifies_hidden_threads_by_default_without_sound() {
        let mut s = AttentionState::default();
        let fx = s.on_status("a", Working, Idle);
        assert!(notifies(&fx));
        assert_eq!(sound(&fx), None);
    }

    #[test]
    fn notifications_off_still_badges() {
        let mut s = AttentionState::default();
        s.set_prefs(false, None);
        let fx = s.on_status("a", Working, Idle);
        assert!(!notifies(&fx));
        assert!(fx.contains(&Effect::SetBadge(1)));
        assert!(!notifies(&s.on_status("b", Working, AwaitingUser)));
    }

    #[test]
    fn attention_sound_plays_whenever_a_thread_needs_attention_even_when_visible() {
        let mut s = AttentionState::default();
        s.set_prefs(true, Some("Glass".into()));
        s.set_visible(Some("a".into()));
        s.set_app_focused(true);
        let fx = s.on_status("a", Working, Idle);
        assert_eq!(sound(&fx), Some("Glass"));
        assert!(!notifies(&fx));
        assert_eq!(sound(&s.on_status("a", Idle, Working)), None);
        assert_eq!(sound(&s.on_status("a", Working, AwaitingUser)), Some("Glass"));
        // A second prompt in the same turn stays quiet, like the notification.
        assert_eq!(sound(&s.on_status("a", AwaitingUser, Working)), None);
        assert_eq!(sound(&s.on_status("a", Working, AwaitingUser)), None);
        assert_eq!(sound(&s.on_status("a", AwaitingUser, Crashed)), Some("Glass"));
    }

    #[test]
    fn repeat_prompts_in_one_turn_still_badge_silently() {
        let mut s = AttentionState::default();
        assert!(notifies(&s.on_status("a", Working, AwaitingUser)));
        s.mark_read("a");
        let fx = s.on_status("a", Working, AwaitingUser);
        assert!(!notifies(&fx));
        assert!(fx.contains(&Effect::SetBadge(1)));
    }

    #[test]
    fn unknown_sounds_are_ignored() {
        let mut s = AttentionState::default();
        s.set_prefs(true, Some("../../evil".into()));
        assert_eq!(sound(&s.on_status("a", Working, Idle)), None);
    }
}
