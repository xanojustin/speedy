//! U11: which aliases may reach ssh and scp as a destination.

use speedy_lib::hosts::ssh::valid_alias;

#[test]
fn aliases_that_ssh_or_scp_could_misread_are_refused_even_when_configured() {
    let ok = |a: &str| valid_alias(a, &[a.to_string()]);
    assert!(ok("mac-mini"));
    assert!(ok("user@box"), "a user@ prefix is still a single destination");
    assert!(ok("box.tail1234.ts.net"));
    assert!(ok("mini-"), "only a leading dash reads as an option");
    assert!(!ok("-v"));
    assert!(!ok("a/b"), "scp would read it as a path");
    assert!(!ok("box:22"));
    assert!(!ok("tab\there"));
    assert!(!ok("line\nbreak"));
    assert!(!ok("nul\0byte"));
    assert!(!ok("\u{a0}nbsp"), "unicode whitespace too");
}

#[test]
fn an_alias_must_match_a_configured_one_exactly() {
    let configured = vec!["Mac-Mini".to_string()];
    assert!(valid_alias("Mac-Mini", &configured));
    assert!(!valid_alias("mac-mini", &configured), "ssh config host names are case-sensitive");
    assert!(!valid_alias("Mac-Min", &configured));
    assert!(!valid_alias("Mac-Mini", &[]));
}
