//! CORE-1094: in-app "Send feedback" → the relay's POST /v1/feedback → one Linear issue.
//!
//! LOCAL-ONLY EXEMPTION (see CLAUDE.md invariant 2b). Feedback is a NEW egress path that is
//! DELIBERATELY allowed in ALL modes, including local-only. It is safe to exempt because it
//! is user-initiated (fires only on a Send tap), fully previewed (the panel shows the exact
//! values first), and provably carries ONLY the typed message + 3 diagnostics + an optional
//! reply email. It NEVER carries reading content, book metadata, identity, or the license
//! token, and it does NOT relax the reading/tutor gate: `cmd_send_feedback` builds its own
//! allowlisted payload and posts on a separate path that never calls `validate_base_url`, so
//! the local-only refusal that guards the tutor/reading path is untouched.

use serde::Serialize;
use tauri::State;

use crate::db::DbState;
use crate::error::AppError;
use crate::settings;

/// Message length cap, mirrored by the relay (`MAX_MESSAGE_CHARS`) and the app textarea.
pub const FEEDBACK_MAX_MESSAGE_CHARS: usize = 6000;

/// Reader-facing transport-failure copy. reqwest's Display text (DNS/TLS/socket) is plumbing
/// and must never reach the panel; and the ONE real failure is losing the reader's words, so
/// the copy reassures that the message is preserved. No em dashes (house style).
const FEEDBACK_FAILED_MSG: &str = "Couldn't send just now. Your message is safe below.";

/// The 3 diagnostics that accompany a feedback message. Sourced entirely in Rust so the
/// preview the panel shows is byte-identical to what actually leaves the Mac.
#[derive(Serialize, Clone, Debug)]
pub struct FeedbackDiagnostics {
    pub app_version: String,
    pub macos_version: String,
    /// The reader-facing tutor mode: included | own_key | local (mirrors Settings' modeForProvider).
    pub mode: String,
}

/// Map the chosen provider to the reader-facing tutor mode. Mirrors the frontend's
/// `modeForProvider` (Settings.tsx) so the previewed and sent mode agree.
pub fn feedback_mode(provider: settings::AiProvider) -> &'static str {
    match provider {
        settings::AiProvider::Company => "included",
        settings::AiProvider::Local => "local",
        // anthropic | openai | codex | none → the reader is on their own key
        _ => "own_key",
    }
}

/// The macOS product version (e.g. "15.5") via `sw_vers`, the smallest reliable Rust call.
/// Best-effort: an unexpected environment yields "unknown", never a panic or an error.
fn macos_product_version() -> String {
    std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// The 3 diagnostics, computed once so the preview and the sent payload are identical.
pub fn feedback_diagnostics(conn: &rusqlite::Connection) -> FeedbackDiagnostics {
    FeedbackDiagnostics {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        macos_version: macos_product_version(),
        mode: feedback_mode(settings::get_ai_provider(conn)).to_string(),
    }
}

/// Build the ALLOWLISTED feedback payload — the ONLY thing that leaves the Mac. It takes ONLY
/// the message, an optional reply email, and the 3 diagnostics, so reading content, book
/// metadata, identity, and the license token CANNOT enter it by construction. A blank email
/// is sent as "" (the relay omits it from the issue). Rejects empty / over-length messages.
pub fn build_feedback_payload(
    message: &str,
    email: Option<&str>,
    diag: &FeedbackDiagnostics,
) -> Result<serde_json::Value, AppError> {
    let msg = message.trim();
    if msg.is_empty() {
        return Err(AppError::validation("Write a message first."));
    }
    if msg.chars().count() > FEEDBACK_MAX_MESSAGE_CHARS {
        return Err(AppError::validation(
            "That message is too long to send. Please shorten it.",
        ));
    }
    let email = email.map(str::trim).filter(|e| !e.is_empty()).unwrap_or("");
    Ok(serde_json::json!({
        "message": msg,
        "app_version": diag.app_version,
        "macos_version": diag.macos_version,
        "mode": diag.mode,
        "email": email,
    }))
}

fn feedback_http() -> Result<reqwest::Client, AppError> {
    // R8-3: never follow a redirect — a 307/308 would re-send the reader's
    // typed message (and email, if given) to an arbitrary Location host.
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| AppError::ai(format!("http client: {e}")))
}

/// The exact 3 diagnostics the panel previews (and that `cmd_send_feedback` will send).
#[tauri::command]
pub fn cmd_feedback_diagnostics(state: State<DbState>) -> Result<FeedbackDiagnostics, AppError> {
    let conn = state.lock()?;
    Ok(feedback_diagnostics(&conn))
}

/// Send feedback. This is the single deliberate exemption from the local-only refusal
/// (CLAUDE.md 2b): it posts to the relay even in local-only mode, but on a separate path
/// that NEVER touches `validate_base_url` or the tutor/reading gate. All egress is built
/// here in Rust as an allowlist, so no reading content or license token can leave.
#[tauri::command]
pub async fn cmd_send_feedback(
    message: String,
    email: Option<String>,
    state: State<'_, DbState>,
) -> Result<(), AppError> {
    // Build the payload under the lock, then drop it before await. The relay
    // origin is the code constant, validated at the call site (R7-2) — never
    // a stored, reroutable value.
    let payload = {
        let conn = state.lock()?;
        let diag = feedback_diagnostics(&conn);
        build_feedback_payload(&message, email.as_deref(), &diag)?
    };
    let resp = feedback_http()?
        .post(crate::commands::ai::company_endpoint("/v1/feedback")?)
        .json(&payload)
        .send()
        .await
        .map_err(|_| AppError::ai(FEEDBACK_FAILED_MSG))?;
    if !resp.status().is_success() {
        return Err(AppError::ai(FEEDBACK_FAILED_MSG));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diag(mode: &str) -> FeedbackDiagnostics {
        FeedbackDiagnostics {
            app_version: "0.8.3".into(),
            macos_version: "15.5".into(),
            mode: mode.into(),
        }
    }

    /// (16) PRIVACY GUARD: the payload is an allowlist — EXACTLY the 5 fields, nothing else.
    /// Reading content, book title, identity, and the license token cannot enter by
    /// construction (they are not inputs), and this pins that no other key ever appears.
    #[test]
    fn feedback_payload_contains_only_the_allowlisted_fields() {
        let p = build_feedback_payload(
            "The margin overlaps at narrow widths.",
            Some("me@x.com"),
            &diag("included"),
        )
        .unwrap();
        let obj = p.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["app_version", "email", "macos_version", "message", "mode"]
        );

        // And nothing sensitive can be present, since it was never an input.
        let s = p.to_string();
        for forbidden in [
            "license",
            "lic_",
            "book",
            "passage",
            "serial",
            "device",
            "telemetry",
            "token",
        ] {
            assert!(
                !s.to_lowercase().contains(forbidden),
                "payload leaked {forbidden}: {s}"
            );
        }
    }

    #[test]
    fn blank_email_is_sent_as_empty_and_a_given_email_is_included() {
        let none = build_feedback_payload("hi", None, &diag("local")).unwrap();
        assert_eq!(none["email"], "");
        let blank = build_feedback_payload("hi", Some("   "), &diag("local")).unwrap();
        assert_eq!(blank["email"], "");
        let given = build_feedback_payload("hi", Some(" me@x.com "), &diag("local")).unwrap();
        assert_eq!(given["email"], "me@x.com");
    }

    #[test]
    fn empty_and_overlong_messages_are_rejected() {
        assert!(build_feedback_payload("   \n\t", None, &diag("included")).is_err());
        let long = "y".repeat(FEEDBACK_MAX_MESSAGE_CHARS + 1);
        assert!(build_feedback_payload(&long, None, &diag("included")).is_err());
        // Exactly at the cap is fine.
        let ok = "y".repeat(FEEDBACK_MAX_MESSAGE_CHARS);
        assert!(build_feedback_payload(&ok, None, &diag("included")).is_ok());
    }

    /// (17) Feedback works in local-only mode and STILL excludes reading content: a
    /// local-only reader maps to mode "local", the payload builds, and it carries only the
    /// allowlisted fields. cmd_send_feedback deliberately never calls validate_base_url, so
    /// the local-only refusal that guards the tutor path is untouched.
    #[test]
    fn feedback_mode_maps_provider_and_local_only_still_builds_a_clean_payload() {
        assert_eq!(feedback_mode(settings::AiProvider::Company), "included");
        assert_eq!(feedback_mode(settings::AiProvider::Local), "local");
        assert_eq!(feedback_mode(settings::AiProvider::Anthropic), "own_key");
        assert_eq!(feedback_mode(settings::AiProvider::OpenAi), "own_key");
        assert_eq!(feedback_mode(settings::AiProvider::Codex), "own_key");

        // The local-only reader's feedback still builds, still clean.
        let p = build_feedback_payload("panel overlaps", None, &diag("local")).unwrap();
        assert_eq!(p["mode"], "local");
        assert_eq!(p.as_object().unwrap().len(), 5);
    }

    /// R8-3: the feedback client NEVER follows a redirect — a 308 pointing at
    /// a second listener leaves that listener with ZERO requests (the typed
    /// message and reply email never re-send to an arbitrary Location host).
    #[test]
    fn feedback_client_never_follows_redirects() {
        use std::io::{Read, Write};
        let sink = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let sink_port = sink.local_addr().unwrap().port();
        let hit = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hit_c = hit.clone();
        std::thread::spawn(move || {
            if sink.accept().is_ok() {
                hit_c.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        });

        let redirecting = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let a_port = redirecting.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = redirecting.accept() {
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                let resp = format!(
                    "HTTP/1.1 308 Permanent Redirect\r\nLocation: http://127.0.0.1:{sink_port}/v1/feedback\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                let _ = s.write_all(resp.as_bytes());
            }
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let resp = feedback_http()
                .unwrap()
                .post(format!("http://127.0.0.1:{a_port}/v1/feedback"))
                .json(&serde_json::json!({ "message": "the reader's words" }))
                .send()
                .await
                .expect("the redirect response itself resolves");
            assert_eq!(resp.status().as_u16(), 308, "redirect NOT followed");
        });
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(
            !hit.load(std::sync::atomic::Ordering::SeqCst),
            "the redirect target must receive ZERO feedback requests"
        );
    }
}
