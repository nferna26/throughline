import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Channel } from "@tauri-apps/api/core";
import TLIcon from "../components/TLIcon";
import { useDialog } from "../hooks/useDialog";
import {
  AI_STUB_MODES,
  NOTE_TYPES,
  type AiStubMode,
  type AskHandle,
  type SettingsDto,
  type StreamEvent,
} from "../types";

interface Props {
  bookId: string;
  chapter: string | null;
  locator: string;
  selection: string;
  onClose: () => void;
}

/**
 * AI tutor panel — intentionally summoned, visually secondary.
 *
 * Shot 4: real call against a local OpenAI-compatible endpoint.
 *
 * Contract:
 * - Selection-only context. No book body. No bulk excerpts.
 * - validate_base_url runs on the Rust side and refuses non-loopback when
 *   local-only is ON — see ai_client::validate_base_url. The UI surfaces a
 *   banner whenever local-only is OFF so the user knows the call may leave
 *   the machine.
 * - Response is ephemeral by default. "Save as note" is the only path that
 *   writes a Note + flips ai_requests.wrote_to_memory to 1.
 */
export default function AiPanel({ bookId, chapter, locator, selection, onClose }: Props) {
  const [mode, setMode] = useState<AiStubMode>("explain");
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [handle, setHandle] = useState<AskHandle | null>(null);
  const [response, setResponse] = useState<string>("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Approval state
  const [approving, setApproving] = useState(false);
  const [noteBody, setNoteBody] = useState<string>("");
  const [noteType, setNoteType] = useState<string>("Reflection");

  const hasSelection = selection.trim().length >= 4;
  const channelRef = useRef<Channel<StreamEvent> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useDialog(panelRef, onClose);

  useEffect(() => {
    invoke<SettingsDto>("cmd_get_settings").then(setSettings).catch(() => {});
    return () => {
      // Drop the channel ref so a late-arriving event doesn't update unmounted state.
      channelRef.current = null;
    };
  }, []);

  async function ask() {
    if (!hasSelection || !settings) return;
    setError(null);
    setResponse("");
    setHandle(null);
    setStreaming(true);

    const ch = new Channel<StreamEvent>();
    channelRef.current = ch;
    ch.onmessage = (ev) => {
      // Guard against stale channels after unmount/reset
      if (channelRef.current !== ch) return;
      if (ev.kind === "delta") {
        setResponse((prev) => prev + ev.text);
      } else if (ev.kind === "done") {
        setStreaming(false);
      } else if (ev.kind === "error") {
        setError(ev.message);
        setStreaming(false);
      }
    };

    try {
      const h = await invoke<AskHandle>("cmd_ai_ask", {
        bookId,
        mode,
        selection,
        chapter,
        locator,
        userNote: null,
        onEvent: ch,
      });
      setHandle(h);
      setNoteBody(""); // user fills this in after seeing the response
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setStreaming(false);
    }
  }

  async function copyResponse() {
    if (!response) return;
    try { await navigator.clipboard.writeText(response); } catch { /* ignore */ }
  }

  async function approveAsNote() {
    if (!handle) return;
    if (!noteBody.trim()) return;
    setApproving(true);
    setError(null);
    try {
      await invoke("cmd_save_ai_response_as_note", {
        aiRequestId: handle.ai_request_id,
        noteType,
        body: noteBody,
        locator,
        chapterLabel: chapter,
      });
      onClose();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setApproving(false);
    }
  }

  const localOnly = settings?.ai_local_only ?? true;
  const baseUrl = settings?.ai_base_url ?? "(not configured)";
  const model = settings?.ai_model ?? "";

  return (
    <div className="tl-modal-backdrop">
      <div ref={panelRef} className="tl-modal wide" role="dialog" aria-modal="true" aria-labelledby="ai-panel-title">
        <div className="tl-modal-head">
          <span className="t" id="ai-panel-title"><TLIcon name="sparkle" size={16} /> AI tutor</span>
          <button className="tl-iconbtn" onClick={onClose} aria-label="Close AI tutor"><TLIcon name="x" size={16} /></button>
        </div>

        {localOnly ? (
          <span className="tl-localtag"><TLIcon name="shield" size={13} /> Local-only · never leaves this Mac · {baseUrl}</span>
        ) : (
          <span className="tl-localtag off"><TLIcon name="arrowRight" size={13} /> Local-only OFF · sends your passage to {baseUrl}</span>
        )}
        {!model.trim() && (
          <p className="tl-warn-text">No model id set. Open Settings → AI and type the model id loaded in your local server.</p>
        )}

        {!hasSelection ? (
          <p className="tl-warn-text">Select some text in the reader first — AI calls need a non-trivial passage to work from.</p>
        ) : (
          <>
            <label>Mode
              <select className="tl-select" value={mode} onChange={(e) => setMode(e.target.value as AiStubMode)}>
                {AI_STUB_MODES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </label>

            <div>
              <span className="tl-field-label">Selected passage ({selection.length} chars)</span>
              <div className="tl-quoted">{selection.length > 600 ? selection.slice(0, 600) + "…" : selection}</div>
            </div>

            <div className="panel-actions">
              <button className="tl-btn tl-btn-ghost" onClick={onClose}>Cancel</button>
              <button className="tl-btn tl-btn-primary" disabled={streaming || !model.trim()} onClick={ask}>
                {streaming ? "Asking…" : (handle ? "Ask again" : "Ask")}
              </button>
            </div>
          </>
        )}

        {error && <p className="tl-warn-text">{error}</p>}

        {(handle || response) && (
          <>
            <span className="tl-section-h">Response (ephemeral)</span>
            <pre className="tl-ai-answer">{response || (streaming ? "…" : "(no content yet)")}</pre>
            <p className="tl-field-label" style={{ fontWeight: 400 }}>
              Provider: {handle?.provider_host ?? "(unknown)"} · {streaming ? "streaming…" : "complete"}
            </p>

            <div className="panel-actions">
              <button className="tl-btn tl-btn-ghost" disabled={!response} onClick={copyResponse}>Copy</button>
              <button className="tl-btn tl-btn-ghost" onClick={onClose}>Discard</button>
            </div>

            <span className="tl-section-h">Save as note (opt-in)</span>
            <p className="tl-field-label" style={{ fontWeight: 400, lineHeight: 1.5 }}>
              Ephemeral until you approve. Paste/edit what's worth keeping; saving writes a Note + Markdown and flips
              <code> ai_requests.wrote_to_memory</code> to 1.
            </p>
            <label>Note type
              <select className="tl-select" value={noteType} onChange={(e) => setNoteType(e.target.value)}>
                {NOTE_TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
            <label>Body
              <textarea
                className="tl-textarea"
                value={noteBody}
                onChange={(e) => setNoteBody(e.target.value)}
                placeholder="Paste / edit the parts of the response worth keeping…"
              />
            </label>
            <div className="panel-actions">
              <button className="tl-btn tl-btn-primary" disabled={approving || !handle || !noteBody.trim()} onClick={approveAsNote}>
                {approving ? "Saving…" : "Save as note"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
