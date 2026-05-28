//! Tauri command surface.
//!
//! Each submodule owns a cohesive group of commands and the row-shaped DB
//! helpers it relies on. `db_helpers` holds the cross-cutting hydration +
//! insert helpers used by more than one command module.
//!
//! Registration with Tauri happens in `crate::run()` via the
//! `tauri::generate_handler!` macro referencing `commands::<module>::<fn>`.

pub mod ai;
pub mod books;
pub mod db_helpers;
pub mod notes;
pub mod sessions;
pub mod settings_cmds;
