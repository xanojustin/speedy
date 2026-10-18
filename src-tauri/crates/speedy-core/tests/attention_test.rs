//! U12: the Tauri-free attention state machine (status transitions, visibility, focus → effects).

use speedy_core::attention::{AttentionState, Effect, Notification};
use speedy_core::claude::ThreadStatus::{self, *};

fn notifications(effects: &[Effect]) -> Vec<&Notification> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Notify(n) => Some(n),
            _ => None,
        })
        .collect()
}

fn badge(effects: &[Effect]) -> Option<usize> {
    effects.iter().rev().find_map(|e| match e {
        Effect::SetBadge(n) => Some(*n),
        _ => None,
    })
}

fn unread(effects: &[Effect]) -> Option<Vec<String>> {
    effects.iter().rev().find_map(|e| match e {
        Effect::EmitUnread(ids) => Some(ids.clone()),
        _ => None,
    })
}

/// App focused, thread `a` visible, `b` hidden; titles known.
fn focused_on_a() -> AttentionState {
    let mut s = AttentionState::default();
    s.set_titles([("a".to_string(), "Alpha".to_string()), ("b".to_string(), "Bravo".to_string())].into());
    assert!(s.set_app_focused(true).is_empty());
    assert!(s.set_visible(Some("a".into())).is_empty());
    s
}

fn run(s: &mut AttentionState, id: &str, path: &[ThreadStatus]) -> Vec<Effect> {
    path.windows(2).flat_map(|w| s.on_status(id, w[0], w[1])).collect()
}

#[test]
fn hidden_thread_awaiting_user_posts_one_notification_and_increments_badge() {
    let mut s = focused_on_a();
    let fx = run(&mut s, "b", &[Idle, Working, AwaitingUser]);
    let n = notifications(&fx);
    assert_eq!(n.len(), 1);
    assert_eq!(n[0].thread_id, "b");
    assert_eq!(n[0].title, "Bravo");
    assert_eq!(n[0].body, "Needs your input");
    assert_eq!(badge(&fx), Some(1));
    // Waiting on the user is not "finished, unread".
    assert_eq!(unread(&fx), None);
}

#[test]
fn visible_thread_awaiting_user_while_focused_posts_nothing() {
    let mut s = focused_on_a();
    let fx = run(&mut s, "a", &[Idle, Working, AwaitingUser, Working, Idle]);
    assert!(fx.is_empty(), "{fx:?}");
}

#[test]
fn visible_thread_awaiting_user_while_app_unfocused_posts_one_notification() {
    let mut s = focused_on_a();
    assert!(s.set_app_focused(false).is_empty());
    let fx = run(&mut s, "a", &[Idle, Working, AwaitingUser]);
    assert_eq!(notifications(&fx).len(), 1);
    assert_eq!(badge(&fx), Some(1));
    // Coming back to the app with that thread on screen clears it.
    let fx = s.set_app_focused(true);
    assert_eq!(badge(&fx), Some(0));
}

#[test]
fn hidden_thread_finishing_is_unread_until_viewed() {
    let mut s = focused_on_a();
    let fx = run(&mut s, "b", &[Idle, Working, Idle]);
    let n = notifications(&fx);
    assert_eq!(n.len(), 1);
    assert_eq!(n[0].body, "Finished");
    assert_eq!(badge(&fx), Some(1));
    assert_eq!(unread(&fx), Some(vec!["b".to_string()]));

    // Viewing it clears unread and the badge.
    let fx = s.set_visible(Some("b".into()));
    assert_eq!(badge(&fx), Some(0));
    assert_eq!(unread(&fx), Some(vec![]));
    // Marking it read again changes nothing.
    assert!(s.mark_read("b").is_empty());
}

#[test]
fn mark_read_clears_unread_and_decrements_badge() {
    let mut s = focused_on_a();
    run(&mut s, "b", &[Idle, Working, Idle]);
    let fx = run(&mut s, "c", &[Idle, Working, Idle]);
    assert_eq!(badge(&fx), Some(2));
    assert_eq!(unread(&fx), Some(vec!["b".to_string(), "c".to_string()]));
    let fx = s.mark_read("c");
    assert_eq!(badge(&fx), Some(1));
    assert_eq!(unread(&fx), Some(vec!["b".to_string()]));
}

#[test]
fn status_flapping_within_one_turn_posts_no_duplicates() {
    let mut s = focused_on_a();
    // Three permission prompts in one turn: one "needs input" notification.
    let fx = run(&mut s, "b", &[Idle, Working, AwaitingUser, Working, AwaitingUser, Working, AwaitingUser]);
    assert_eq!(notifications(&fx).len(), 1);
    // The badge still tracks whether it is waiting right now.
    assert_eq!(badge(&fx), Some(1));
    let fx = s.on_status("b", AwaitingUser, Working);
    assert_eq!(badge(&fx), Some(0));
    // The turn's end is its own event.
    let fx = s.on_status("b", Working, Idle);
    assert_eq!(notifications(&fx).len(), 1);
    assert_eq!(notifications(&fx)[0].body, "Finished");
    // A new turn may notify again.
    let fx = run(&mut s, "b", &[Idle, Working, AwaitingUser]);
    assert_eq!(notifications(&fx).len(), 1);
}

#[test]
fn crashed_hidden_thread_notifies_with_error_state() {
    let mut s = focused_on_a();
    let fx = run(&mut s, "b", &[Idle, Working, Crashed]);
    let n = notifications(&fx);
    assert_eq!(n.len(), 1);
    assert_eq!(n[0].thread_id, "b");
    assert!(n[0].body.contains("crashed"), "{}", n[0].body);
    assert_eq!(badge(&fx), Some(1));
    assert_eq!(unread(&fx), None);
    // Retrying (leaving Crashed) clears it.
    let fx = s.on_status("b", Crashed, Starting);
    assert_eq!(badge(&fx), Some(0));
}

#[test]
fn unknown_title_falls_back() {
    let mut s = focused_on_a();
    let fx = run(&mut s, "zz", &[Idle, Working, AwaitingUser]);
    assert_eq!(notifications(&fx)[0].title, "Claude thread");
}
