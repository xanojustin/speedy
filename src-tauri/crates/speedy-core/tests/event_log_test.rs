//! U5 / KTD5: the per-thread replay log. Cursors are `(epoch, seq)`; anything the log
//! can't answer exactly (no cursor, another epoch, evicted history) gets a snapshot.

use serde_json::{Value, json};
use speedy_core::host::log::{Cursor, EventLog, Replay};

const MB: usize = 1 << 20;

fn tick(i: u64) -> Value {
    json!({"kind": "message", "seq": 0, "raw": {"type": "tick", "i": i}})
}

fn partial(parent: Option<&str>) -> Value {
    json!({"kind": "message", "seq": 0, "raw": {"type": "stream_event", "parent_tool_use_id": parent, "event": {}}})
}

fn assistant(parent: Option<&str>) -> Value {
    json!({"kind": "message", "seq": 0, "raw": {"type": "assistant", "parent_tool_use_id": parent, "message": {}}})
}

fn seqs(replay: Replay) -> Vec<u64> {
    match replay {
        Replay::Events(events) => events.iter().map(|e| e["seq"].as_u64().unwrap()).collect(),
        Replay::Snapshot => panic!("expected events, got a snapshot"),
    }
}

fn raw_types(log: &EventLog) -> Vec<String> {
    match log.after(Some(Cursor { epoch: log.epoch(), seq: 0 })) {
        Replay::Events(events) => events.iter().map(|e| e["raw"]["type"].as_str().unwrap().to_owned()).collect(),
        Replay::Snapshot => panic!("expected events"),
    }
}

#[test]
fn a_cursor_in_the_current_epoch_replays_exactly_what_came_after_it() {
    let mut log = EventLog::new(7, 64 * MB);
    for i in 0..25 {
        let stamped = log.push(tick(i));
        assert_eq!(stamped["seq"], i + 1, "the log stamps its own seq");
    }
    assert_eq!(seqs(log.after(Some(Cursor { epoch: 7, seq: 10 }))), (11..=25).collect::<Vec<_>>());
    assert_eq!(seqs(log.after(Some(Cursor { epoch: 7, seq: 25 }))), Vec::<u64>::new());
}

#[test]
fn no_cursor_or_another_epoch_needs_a_snapshot() {
    let mut log = EventLog::new(7, 64 * MB);
    log.push(tick(0));
    assert!(matches!(log.after(None), Replay::Snapshot));
    assert!(matches!(log.after(Some(Cursor { epoch: 6, seq: 1 })), Replay::Snapshot));
}

#[test]
fn a_cursor_older_than_evicted_history_needs_a_snapshot() {
    // Each tick is ~60 bytes; a 1 KB cap keeps only the newest dozen or so.
    let mut log = EventLog::new(1, 1024);
    for i in 0..100 {
        log.push(tick(i));
    }
    assert!(matches!(log.after(Some(Cursor { epoch: 1, seq: 3 })), Replay::Snapshot));
    let kept = seqs(log.after(Some(Cursor { epoch: 1, seq: 95 })));
    assert_eq!(kept, vec![96, 97, 98, 99, 100]);
}

#[test]
fn partials_are_dropped_once_their_message_completes() {
    let mut log = EventLog::new(1, 64 * MB);
    log.push(partial(None));
    log.push(partial(Some("task-1")));
    log.push(partial(None));
    log.push(assistant(None));
    // The main agent's partials go; the subagent's stays until its own message completes.
    assert_eq!(raw_types(&log), ["stream_event", "assistant"]);
    assert_eq!(log.partials().len(), 1);
    log.push(partial(Some("task-1")));
    log.push(json!({"kind": "message", "seq": 0, "raw": {"type": "result"}}));
    assert_eq!(raw_types(&log), ["assistant", "result"], "a turn's result drops every partial");
    assert!(log.partials().is_empty());
}
