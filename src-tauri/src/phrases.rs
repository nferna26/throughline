//! AI session phrases — generation REMOVED (public-beta blocker PRIV-001 /
//! TRUST-002, audit 2026-07).
//!
//! The Stage 3 phrase feature generated short AI names for reading sittings by
//! sending a slice of book text to the configured provider in the BACKGROUND —
//! spawned by plan configuration and by session end, defaulted on for fresh
//! installs, and never gated by the first-cloud consent sheet. That violated
//! the app's own AI contract (AI fires only on a deliberate reader action,
//! CLAUDE.md non-negotiable 2) and the front-door privacy promise, so the
//! entire generation path was removed: no route selection, no credential
//! resolution, no wire code, no spawn.
//!
//! What remains:
//! - The `phrases` TABLE and its read path (`sittings.rs` LEFT JOINs it when
//!   serving Today) — phrases cached before the removal still display.
//! - The guard tests below, which pin "no unsolicited AI" at the source level:
//!   this module must stay free of network/spawn code, and no command or
//!   startup path may call into a phrase-generation entry point again.
//!
//! If session naming ever returns, it must be reader-initiated, disclosed, and
//! consent-gated exactly like the tutor — never rebuilt as a background job.

#[cfg(test)]
mod tests {
    /// PRIV-001 guard: the phrases module carries no generation machinery.
    /// Comment lines are stripped (prose may NAME the banned things); the
    /// banned tokens are assembled at runtime so the test's own strings can't
    /// trip it either.
    #[test]
    fn phrases_module_has_no_generation_machinery() {
        let code: String = include_str!("phrases.rs")
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for banned in [
            format!("re{}", "qwest"),
            format!("sp{}", "awn"),
            format!("fetch_{}", "batch"),
            format!("async_{}", "runtime"),
            format!("ht{}", "tp"),
        ] {
            assert!(
                !code.contains(&banned),
                "phrases.rs must not contain `{banned}` — phrase generation was removed (PRIV-001)"
            );
        }
    }

    /// PRIV-001 guard: no command or startup path reaches into this module.
    /// (`phrases` as a bare SQL table name is still fine — the cached READ
    /// path in sittings.rs is deliberately kept.)
    #[test]
    fn no_code_calls_into_the_phrases_module() {
        let sources = [
            ("lib.rs", include_str!("lib.rs")),
            ("settings.rs", include_str!("settings.rs")),
            ("sittings.rs", include_str!("sittings.rs")),
            ("commands/mod.rs", include_str!("commands/mod.rs")),
            ("commands/ai.rs", include_str!("commands/ai.rs")),
            ("commands/backups.rs", include_str!("commands/backups.rs")),
            ("commands/books.rs", include_str!("commands/books.rs")),
            (
                "commands/db_helpers.rs",
                include_str!("commands/db_helpers.rs"),
            ),
            ("commands/discover.rs", include_str!("commands/discover.rs")),
            ("commands/feedback.rs", include_str!("commands/feedback.rs")),
            ("commands/notes.rs", include_str!("commands/notes.rs")),
            ("commands/plans.rs", include_str!("commands/plans.rs")),
            ("commands/sessions.rs", include_str!("commands/sessions.rs")),
            (
                "commands/settings_cmds.rs",
                include_str!("commands/settings_cmds.rs"),
            ),
        ];
        let needle = format!("phra{}::", "ses");
        for (name, src) in sources {
            assert!(
                !src.contains(&needle),
                "{name} calls into the phrases module — unsolicited AI generation must not return (PRIV-001)"
            );
        }
    }
}
