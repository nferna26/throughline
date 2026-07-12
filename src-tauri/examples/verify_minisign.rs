// REL-008: the release pipeline's REFERENCE updater-signature verifier.
//
// This is deliberately the SAME code path the shipped app trusts:
// tauri-plugin-updater 2.10.1 → minisign_verify::PublicKey::verify(data, sig,
// allow_legacy = true), with the pubkey and signature strings base64-decoded
// to their minisign documents first (updater.rs::verify_signature). The
// release workflow runs this binary over the built payload before anything
// publishes, and the JS verifier (scripts/verify-release-assets.mjs) mirrors
// these semantics for the hermetic frontend tests + post-publish checks — the
// workflow runs BOTH on every release, so the two can never drift silently.
//
// Usage:
//   cargo run --example verify_minisign -- \
//     --payload <file> --sig <file.sig> --pubkey-from-tauri-conf <tauri.conf.json>
//
// Exits 0 iff the key id matches AND the primary signature verifies over the
// payload (Blake2b-512 prehashed for alg "ED") AND the global signature
// verifies over signature‖trusted-comment.

use std::path::PathBuf;

use base64::Engine as _;
use minisign_verify::{PublicKey, Signature};

use throughline_lib::bin_guardrail;

fn base64_to_string(b64: &str) -> anyhow::Result<String> {
    let decoded = base64::engine::general_purpose::STANDARD.decode(b64.trim())?;
    Ok(std::str::from_utf8(&decoded)?.to_string())
}

/// The updater's OUTER encoding, exactly (updater.rs::verify_signature):
/// pubkey and signature are strict base64 of their minisign documents. A raw
/// document is REJECTED — the shipped updater would reject it too, so
/// accepting it here would make this "reference" verifier pass inputs the app
/// cannot consume (R4).
fn to_document(text: &str) -> anyhow::Result<String> {
    let trimmed = text.trim();
    if trimmed.starts_with("untrusted comment:") {
        anyhow::bail!(
            "got a RAW minisign document where the updater expects base64 of the document"
        );
    }
    let decoded = base64_to_string(trimmed)?;
    if !decoded.trim_start().starts_with("untrusted comment:") {
        anyhow::bail!("not a minisign document (missing untrusted comment)");
    }
    Ok(decoded)
}

/// The exact verification the updater performs, callable from tests: strict
/// base64 outer unwrap on both inputs, then
/// `PublicKey::verify(payload, sig, allow_legacy = true)`.
fn verify_updater_exact(payload: &[u8], sig_text: &str, pubkey_text: &str) -> anyhow::Result<()> {
    let public_key = PublicKey::decode(&to_document(pubkey_text)?)
        .map_err(|e| anyhow::anyhow!("public key decode failed: {e}"))?;
    let signature = Signature::decode(&to_document(sig_text)?)
        .map_err(|e| anyhow::anyhow!("signature decode failed: {e}"))?;
    // allow_legacy = true — the exact call tauri-plugin-updater makes.
    public_key
        .verify(payload, &signature, true)
        .map_err(|e| anyhow::anyhow!("SIGNATURE VERIFICATION FAILED: {e}"))
}

fn main() -> anyhow::Result<()> {
    // Guardrail: examples never touch the user's real data dir. This tool does
    // no DB/filesystem work beyond reading its arguments, but the isolation
    // contract applies to every example uniformly.
    let _isolated = bin_guardrail::init_isolated_data_dir("verify_minisign");

    let mut payload_path: Option<PathBuf> = None;
    let mut sig_path: Option<PathBuf> = None;
    let mut conf_path: Option<PathBuf> = None;
    let mut pubkey_b64: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--payload" => payload_path = args.next().map(PathBuf::from),
            "--sig" => sig_path = args.next().map(PathBuf::from),
            "--pubkey-from-tauri-conf" => conf_path = args.next().map(PathBuf::from),
            "--pubkey" => pubkey_b64 = args.next(),
            other => anyhow::bail!("unknown argument: {other}"),
        }
    }
    let payload_path = payload_path.ok_or_else(|| anyhow::anyhow!("--payload is required"))?;
    let sig_path = sig_path.ok_or_else(|| anyhow::anyhow!("--sig is required"))?;
    let pubkey_text = if let Some(b64) = pubkey_b64 {
        b64
    } else {
        let conf_path = conf_path
            .ok_or_else(|| anyhow::anyhow!("--pubkey or --pubkey-from-tauri-conf is required"))?;
        let conf: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&conf_path)?)?;
        conf.pointer("/plugins/updater/pubkey")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("no plugins.updater.pubkey in {conf_path:?}"))?
            .to_string()
    };

    let sig_text = std::fs::read_to_string(&sig_path)?;
    let payload = std::fs::read(&payload_path)?;
    verify_updater_exact(&payload, &sig_text, &pubkey_text)?;

    println!("✓ minisign signature verified over {} bytes", payload.len());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    // The minisign-verify crate's own canonical vector, framed EXACTLY as the
    // updater consumes it (base64 of each document).
    const PUB_DOC: &str =
        "untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
    const SIG_DOC: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==\n";

    fn b64(s: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(s)
    }

    #[test]
    fn canonical_vector_verifies_through_the_updater_exact_path() {
        verify_updater_exact(b"test", &b64(SIG_DOC), &b64(PUB_DOC)).expect("canonical vector");
    }

    /// The review regression: a `!` inserted into an otherwise-valid
    /// global-signature line must FAIL the Rust reference verifier (the
    /// crate's strict decoder rejects the invalid character; a permissive
    /// decoder would silently skip it).
    #[test]
    fn bang_inserted_into_global_signature_line_fails() {
        let mut lines: Vec<String> = SIG_DOC.trim_end().split('\n').map(String::from).collect();
        let g = lines[3].clone();
        lines[3] = format!("{}!{}", &g[..10], &g[10..]);
        let mutated = format!("{}\n", lines.join("\n"));
        let err = verify_updater_exact(b"test", &b64(&mutated), &b64(PUB_DOC))
            .expect_err("`!` in the global-signature line must fail");
        assert!(
            format!("{err:#}").contains("signature decode failed"),
            "rejected at decode, got: {err:#}"
        );
    }

    /// Raw documents are what the SIGNER emits, not what the UPDATER consumes:
    /// the reference verifier must reject them like the app would.
    #[test]
    fn raw_documents_are_rejected() {
        let err = verify_updater_exact(b"test", SIG_DOC, &b64(PUB_DOC))
            .expect_err("raw signature document must be rejected");
        assert!(format!("{err:#}").contains("RAW minisign document"));
        let err = verify_updater_exact(b"test", &b64(SIG_DOC), PUB_DOC)
            .expect_err("raw pubkey document must be rejected");
        assert!(format!("{err:#}").contains("RAW minisign document"));
    }

    #[test]
    fn changed_trusted_comment_fails_the_global_signature() {
        let mutated = SIG_DOC.replace("file:test", "file:evil");
        verify_updater_exact(b"test", &b64(&mutated), &b64(PUB_DOC))
            .expect_err("a changed trusted comment must fail");
    }
}
