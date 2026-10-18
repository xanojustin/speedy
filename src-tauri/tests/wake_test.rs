//! U11: on wake every host starts over rather than waiting on a master that may hang (KTD14).

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use speedy_lib::hosts::HostRegistry;
use speedy_lib::hosts::connection::Connector;

/// A connector whose connects all hang, as through a master that survived sleep.
fn hanging(calls: Arc<AtomicUsize>) -> Connector {
    Arc::new(move || {
        calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            std::future::pending::<()>().await;
            Err("unreachable".to_owned())
        })
    })
}

#[tokio::test(start_paused = true)]
async fn waking_reconnects_every_host_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let registry = HostRegistry::new_in(dir.path().to_path_buf());
    let (a, b) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    registry.add("a", hanging(a.clone()), Arc::new(|_, _, _| {}));
    registry.add("b", hanging(b.clone()), Arc::new(|_, _, _| {}));
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!((a.load(Ordering::SeqCst), b.load(Ordering::SeqCst)), (1, 1), "both stuck connecting");

    registry.woke().await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!((a.load(Ordering::SeqCst), b.load(Ordering::SeqCst)), (2, 2), "each abandoned its stuck connect for a fresh one");
}

#[tokio::test(start_paused = true)]
async fn a_removed_host_is_not_reconnected_on_wake() {
    let dir = tempfile::tempdir().unwrap();
    let registry = HostRegistry::new_in(dir.path().to_path_buf());
    let calls = Arc::new(AtomicUsize::new(0));
    registry.add("gone", hanging(calls.clone()), Arc::new(|_, _, _| {}));
    tokio::time::sleep(Duration::from_secs(1)).await;
    registry.remove("gone").await;
    registry.woke().await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
