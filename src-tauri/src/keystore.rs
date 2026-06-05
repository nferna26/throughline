//! Secure at-rest storage for cloud AI provider API keys.
//!
//! Keys live ONLY in the macOS Keychain (OS-encrypted, ACL-bound to the signed
//! app) — never in the DB, a file, the repo, or any export. The command layer
//! exposes only `has_key(provider)` booleans; the raw secret is read solely at
//! request time to set one Authorization header and is never logged or returned
//! to the frontend.
//!
//! Under `#[cfg(test)]` the Keychain is replaced by an in-process map so CI is
//! hermetic (no real credentials, no ACL prompt).

// Keychain *service* name — a deliberate org-scoped (Trainable LLC) namespace,
// intentionally distinct from the app bundle identifier (`com.throughline.app`
// in tauri.conf.json). v0.2.0 shipped with this exact string, so renaming it to
// match the bundle id would strand every existing user's stored API keys behind
// an unreachable service. It MUST stay stable to keep saved keys readable.
#[cfg_attr(test, allow(dead_code))] // real-Keychain const; tests use an in-process map
const SERVICE: &str = "com.trainable.throughline";

/// Keychain account name for a provider's key, or None for providers that need
/// no stored key (local, codex, none).
fn account_for(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("ai_key_openai"),
        "anthropic" => Some("ai_key_anthropic"),
        _ => None,
    }
}

/// Store (or replace) a provider's API key.
pub fn set_key(provider: &str, secret: &str) -> anyhow::Result<()> {
    let account = account_for(provider)
        .ok_or_else(|| anyhow::anyhow!("provider '{provider}' does not use a stored key"))?;
    backend::set(account, secret)
}

/// Read a provider's API key (request-time only; never log the result).
pub fn get_key(provider: &str) -> Option<String> {
    backend::get(account_for(provider)?)
}

/// Delete a provider's stored key (idempotent).
pub fn clear_key(provider: &str) -> anyhow::Result<()> {
    match account_for(provider) {
        Some(account) => backend::delete(account),
        None => Ok(()),
    }
}

/// Whether a provider has a key stored. Goes through the cached `get` so a
/// presence check shares the at-most-one-per-session Keychain read with the
/// request-time fetch instead of triggering its own macOS prompt. (The UI no
/// longer calls this on launch — it reads a persisted flag — but request-time
/// resolution and the one-time flag seed still do.)
pub fn has_key(provider: &str) -> bool {
    get_key(provider).is_some()
}

// ── Codex (ChatGPT-login) credentials, app-owned ──
// Stored as a JSON blob (access_token + refresh_token + account_id) so an
// app-owned device login is independent of the Codex CLI's ~/.codex/auth.json.
const CODEX_ACCOUNT: &str = "ai_codex_creds";

pub fn set_codex_creds(json: &str) -> anyhow::Result<()> {
    backend::set(CODEX_ACCOUNT, json)
}
pub fn get_codex_creds() -> Option<String> {
    backend::get(CODEX_ACCOUNT)
}
pub fn clear_codex_creds() -> anyhow::Result<()> {
    backend::delete(CODEX_ACCOUNT)
}
pub fn has_codex_creds() -> bool {
    get_codex_creds().is_some()
}

#[cfg(not(test))]
mod backend {
    use super::SERVICE;
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    // Per-session memory cache. macOS prompts the user on EVERY read of a
    // Keychain item the running binary isn't ACL-authorized for (and dev
    // rebuilds re-arm that prompt by changing the signature). Caching the value
    // after the first read collapses N prompts per launch to one. The cache
    // holds the plaintext secret in process memory only — never on disk — and is
    // kept in sync by set/delete; it dies with the process.
    fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
        static C: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
        C.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub fn set(account: &str, secret: &str) -> anyhow::Result<()> {
        keyring::Entry::new(SERVICE, account)?.set_password(secret)?;
        cache()
            .lock()
            .unwrap()
            .insert(account.to_string(), Some(secret.to_string()));
        Ok(())
    }

    pub fn get(account: &str) -> Option<String> {
        if let Some(hit) = cache().lock().unwrap().get(account) {
            return hit.clone();
        }
        // Miss: read once (this is the only call that can prompt), then cache the
        // result — present OR absent — so we never read this item again.
        let val = keyring::Entry::new(SERVICE, account)
            .ok()
            .and_then(|e| e.get_password().ok());
        cache()
            .lock()
            .unwrap()
            .insert(account.to_string(), val.clone());
        val
    }

    pub fn delete(account: &str) -> anyhow::Result<()> {
        let entry = keyring::Entry::new(SERVICE, account)?;
        let result = match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        };
        cache().lock().unwrap().insert(account.to_string(), None);
        result
    }
}

#[cfg(test)]
mod backend {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    fn store() -> &'static Mutex<HashMap<String, String>> {
        static STORE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
        STORE.get_or_init(|| Mutex::new(HashMap::new()))
    }
    pub fn set(account: &str, secret: &str) -> anyhow::Result<()> {
        store()
            .lock()
            .unwrap()
            .insert(account.to_string(), secret.to_string());
        Ok(())
    }
    pub fn get(account: &str) -> Option<String> {
        store().lock().unwrap().get(account).cloned()
    }
    pub fn delete(account: &str) -> anyhow::Result<()> {
        store().lock().unwrap().remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_get_clear_round_trip_and_has_key() {
        // Unknown provider has no key and cannot store one.
        assert!(!has_key("local"));
        assert!(set_key("local", "x").is_err());

        assert!(!has_key("openai"));
        set_key("openai", "sk-test-123").unwrap();
        assert!(has_key("openai"));
        assert_eq!(get_key("openai").as_deref(), Some("sk-test-123"));

        // Providers are isolated.
        assert!(!has_key("anthropic"));

        clear_key("openai").unwrap();
        assert!(!has_key("openai"));
        assert!(get_key("openai").is_none());
        // Clearing again is a no-op.
        clear_key("openai").unwrap();
    }
}
