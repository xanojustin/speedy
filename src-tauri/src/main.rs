// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ssh runs this binary as its SSH_ASKPASS helper to ask the app for a passphrase.
    if let Some(code) = speedy_lib::hosts::askpass::helper_main() {
        std::process::exit(code);
    }
    speedy_lib::run()
}
