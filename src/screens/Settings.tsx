import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import ModelSelect from "../components/ModelSelect";
import CodexLogin from "../components/CodexLogin";
import FeedbackPanel from "../components/FeedbackPanel";
import { isTutorEnabled, setTutorEnabled } from "../tutorConsent";
import { useDialog } from "../hooks/useDialog";
import {
  adjustFontSize,
  applyLineSpacing,
  applyTypeface,
  clampFontSize,
  getCachedThemePref,
  normalizeLineSpacing,
  normalizeThemePref,
  normalizeTypeface,
  readFontSize,
  setThemePref,
  FONT_SIZE_EVENT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  THEME_PREF_EVENT,
  type LineSpacing,
  type ThemePref,
  type Typeface,
} from "../appearance";
import {
  AI_PROVIDERS,
  aiProviderLabel,
  type AiRequest,
  type BackupEntry,
  type BackupStatus,
  type CompanyCredits,
  CompanyStatus,
  type ConnTestResult,
  type LibraryExportResult,
  type SettingsDto,
} from "../types";
import "../tl-settings.css";

/* ── Icons (Lucide-style, 20-grid, currentColor) — the redesigned Settings is
   text-first (the rail carries no icons), but a few controls keep their glyphs:
   the folder chip, the export arrow, the fallback segmented, and the audit log. */
function Icon({ d, size = 16, className }: { d: string; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={d} />
    </svg>
  );
}
const ICON = {
  key: "M8.5 8.5a3 3 0 1 0-3 3 3 3 0 0 0 3-3zM8.5 8.5l4 4 1.5-1.5 1.5 1.5 1.5-1.5-3-3z",
  monitor: "M3 4.5h14v9.5H3zM7 17h6M10 14v3",
  up: "M10 15V5M6 9l4-4 4 4",
  trash: "M4 6h12M8 6V4.5h4V6M6 6l.6 9.5h6.8L15 6",
  folder:
    "M3 6.5C3 5.7 3.7 5 4.5 5H8l1.5 1.5h6c.8 0 1.5.7 1.5 1.5v6c0 .8-.7 1.5-1.5 1.5h-11C3.7 15.5 3 14.8 3 14z",
  warn: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM10 6.5v4.5M10 13.4v.1",
  caretUp: "M5 12l5-5 5 5",
  caretDown: "M5 8l5 5 5-5",
} as const;

/* ── Plain lens labels (FT-12): never show an internal id like
   "section_briefing". Maps every backend lens/mode value to a short,
   sentence-case reader word. Falls back to the raw value only if a new mode
   is added before this map is updated (still no hostname/ids leak). */
const LENS_LABEL: Record<string, string> = {
  explain: "Explain",
  historical: "Historical context",
  vocabulary: "Define",
  socratic: "Ask questions",
  durable_note: "Saved note",
  prepare_next: "Prepare next reading",
  section_briefing: "Section briefing",
  define: "Define",
  context: "Context",
};
function lensLabel(mode: string): string {
  return LENS_LABEL[mode] ?? mode.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** The trailing folder name of a path, for reader-facing copy — never the
 *  full path. Returns "" when there's nothing meaningful to show. */
function folderDisplayName(path: string | null | undefined): string {
  const trimmed = (path ?? "").replace(/[/\\]+$/, "");
  const name = trimmed.split(/[/\\]/).pop();
  return name && name.length ? name : "";
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "today at 9:12" / "yesterday at 9:12" / "Jun 30 at 9:12" — the Files pane's
 *  last-backup line and the restore picker's row labels. Exported for tests. */
export function fmtBackupWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (day(d) === day(now)) return `today at ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day(d) === day(yesterday)) return `yesterday at ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
}

/** The stored model id for a provider, from a settings DTO. */
function modelForProvider(s: SettingsDto, prov: string): string {
  switch (prov) {
    case "openai": return s.ai_model_openai;
    case "anthropic": return s.ai_model_anthropic;
    case "codex": return s.ai_model_codex;
    default: return s.ai_model;
  }
}

/** The three conceptual modes the reader sees, mapped to the real provider enum. */
type Mode = "included" | "own_key" | "local";
function modeForProvider(prov: string): Mode {
  if (prov === "company") return "included";
  if (prov === "local") return "local";
  return "own_key"; // anthropic | openai | codex
}

const KEY_PROVIDERS = AI_PROVIDERS.filter((p) => p.id === "anthropic" || p.id === "openai" || p.id === "codex");

/** The rail's seven destinations, in design order. */
type Section = "reading" | "appearance" | "assistant" | "privacy" | "files" | "shortcuts" | "feedback";
const SECTIONS: Array<{ id: Exclude<Section, "feedback">; label: string }> = [
  { id: "reading", label: "Reading" },
  { id: "appearance", label: "Appearance" },
  { id: "assistant", label: "Assistant" },
  { id: "privacy", label: "Privacy" },
  { id: "files", label: "Files" },
  { id: "shortcuts", label: "Shortcuts" },
];

/** Shared modal shell for the Settings sheets (provider setup, audit, restore).
 *  Escape closes; focus is trapped; clicking the scrim closes. */
function SettingsSheet({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDialog(ref, onClose);
  return (
    <div className="tl-scrim" onClick={onClose}>
      <div
        className="set-sheet"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export default function Settings() {
  const [dto, setDto] = useState<SettingsDto | null>(null);

  // ── Rail navigation. "feedback" is a destination like any other; Cancel and
  // Close return to the pane the reader was on before (spec).
  const [active, setActive] = useState<Section>("reading");
  const prevSection = useRef<Exclude<Section, "feedback">>("reading");
  function goTo(section: Section) {
    if (section !== "feedback") prevSection.current = section;
    setActive(section);
  }
  function onRailKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>("button.set-rail-item"),
    );
    if (items.length === 0) return;
    e.preventDefault();
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home" || idx === -1
        ? 0
        : e.key === "End"
          ? items.length - 1
          : (idx + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
    items[next].focus();
  }

  // App version for the rail footer (the About decision: a quiet version line).
  // Sourced from the same Rust diagnostics the feedback preview shows.
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    invoke<{ app_version: string }>("cmd_feedback_diagnostics")
      .then((d) => setAppVersion(d?.app_version ?? null))
      .catch(() => setAppVersion(null));
  }, []);

  // ── Reading pace — the global sitting size the first-journey pace step sets,
  // also editable here. Reading terms only on screen; the minutes are the
  // backstage mapping (10 / 25 / 60), never a timer.
  const [paceMinutes, setPaceMinutes] = useState<number | null>(null);
  useEffect(() => {
    invoke<{ minutes: number; chosen: boolean }>("cmd_get_reading_pace")
      .then((p) => setPaceMinutes(p?.minutes ?? null))
      .catch(() => setPaceMinutes(null));
  }, []);
  async function changePace(minutes: number) {
    setPaceMinutes(minutes); // optimistic; the backend clamps + persists
    try {
      const p = await invoke<{ minutes: number; chosen: boolean }>("cmd_set_reading_pace", { minutes });
      setPaceMinutes(p.minutes);
    } catch {
      /* leave the optimistic value; a later read reconciles */
    }
  }

  // ── Appearance ──
  const [themePref, setThemePrefLocal] = useState<ThemePref>(getCachedThemePref);
  useEffect(() => {
    const onPref = (e: Event) => {
      const p = normalizeThemePref((e as CustomEvent).detail);
      if (p) setThemePrefLocal(p);
    };
    window.addEventListener(THEME_PREF_EVENT, onPref);
    return () => window.removeEventListener(THEME_PREF_EVENT, onPref);
  }, []);
  const [fontSize, setFontSize] = useState<number>(readFontSize);
  useEffect(() => {
    const onSize = (e: Event) => setFontSize(clampFontSize(Number((e as CustomEvent).detail)));
    window.addEventListener(FONT_SIZE_EVENT, onSize);
    return () => window.removeEventListener(FONT_SIZE_EVENT, onSize);
  }, []);
  const typeface: Typeface = normalizeTypeface(dto?.reading_typeface);
  const lineSpacing: LineSpacing = normalizeLineSpacing(dto?.reading_line_spacing);
  async function changeTypeface(v: string) {
    applyTypeface(normalizeTypeface(v)); // live in the reading view
    try {
      setDto(await invoke<SettingsDto>("cmd_set_appearance", { typeface: v }));
    } catch {
      /* the applied value still shows; refresh reconciles */
    }
  }
  async function changeLineSpacing(v: string) {
    applyLineSpacing(normalizeLineSpacing(v)); // live in the reading view
    try {
      setDto(await invoke<SettingsDto>("cmd_set_appearance", { lineSpacing: v }));
    } catch {
      /* as above */
    }
  }

  // ── Files ──
  const [savingExport, setSavingExport] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [exportingLib, setExportingLib] = useState(false);
  const [libExportMsg, setLibExportMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Automatic backups + restore (built on the launch-time rolling backup).
  const [backup, setBackup] = useState<BackupStatus | null>(null);
  useEffect(() => {
    invoke<BackupStatus>("cmd_backup_status")
      .then(setBackup)
      .catch(() => setBackup(null));
  }, []);
  async function toggleBackups() {
    if (!backup) return;
    try {
      setBackup(await invoke<BackupStatus>("cmd_set_backups_enabled", { enabled: !backup.enabled }));
    } catch {
      /* leave the switch; the status read reconciles */
    }
  }
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [backupsList, setBackupsList] = useState<BackupEntry[] | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupEntry | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);
  function openRestore() {
    setRestoreOpen(true);
    setRestoreTarget(null);
    setRestoreMsg(null);
    setBackupsList(null);
    invoke<BackupEntry[]>("cmd_list_backups")
      .then(setBackupsList)
      .catch(() => setBackupsList([]));
  }
  async function doRestore() {
    if (!restoreTarget || restoring) return;
    setRestoring(true);
    setRestoreMsg(null);
    try {
      await invoke("cmd_restore_backup", { id: restoreTarget.id });
      setRestoreMsg("Library restored. Reopening…");
      // Every screen's state is stale once the library underneath changed.
      window.setTimeout(() => window.location.reload(), 600);
    } catch (e: any) {
      setRestoreMsg(String(e?.message ?? e));
      setRestoring(false);
    }
  }

  // ── Assistant: allowance meter + company status + activation door ──
  const [credits, setCredits] = useState<CompanyCredits | null>(null);
  const [companyStatus, setCompanyStatus] = useState<CompanyStatus | null>(null);
  const [codeDraft, setCodeDraft] = useState("");
  const [activating, setActivating] = useState(false);
  const [activateMsg, setActivateMsg] = useState<string | null>(null);

  // BYO / on-this-Mac controls (draft, inside the setup sheet)
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [savingAi, setSavingAi] = useState(false);
  const [aiMsg, setAiMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [conn, setConn] = useState<ConnTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  // providerDraft is the FALLBACK provider chosen inside the sheet
  // (anthropic | openai | codex | local). Defaults to anthropic for "own key".
  const [providerDraft, setProviderDraft] = useState<string>("anthropic");
  const [keyDraft, setKeyDraft] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  // The deep provider setup opens as a sheet from the "Answers come from" row.
  // NOTHING switches until "Use this" commits inside it — selecting a fallback
  // option in the row only opens its controls (the curious-click guard).
  const [sourceSheet, setSourceSheet] = useState<null | { target: "own_key" | "local" }>(null);

  // Tutor consent (localStorage, shared with the in-margin card)
  const [tutorOn, setTutorOn] = useState(isTutorEnabled);

  // ── Privacy: audit (reframed history) — shown in a sheet from the pane row
  const [requests, setRequests] = useState<AiRequest[] | null>(null);
  const [retentionDraft, setRetentionDraft] = useState<number>(90);
  const [forgetMsg, setForgetMsg] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);

  const provider = dto?.ai_provider ?? "";
  const mode: Mode = modeForProvider(provider);
  const needsKey = providerDraft === "openai" || providerDraft === "anthropic";
  // A saved key already in the Keychain for the drafted key-provider.
  const keyPresent =
    providerDraft === "openai"
      ? !!dto?.ai_key_present_openai
      : providerDraft === "anthropic"
        ? !!dto?.ai_key_present_anthropic
        : false;
  // "Use this" may only commit a fallback that will actually answer: local and
  // Codex (own sign-in) are always committable; a key-provider needs a key
  // typed or already saved.
  const canCommitFallback =
    providerDraft === "local" ||
    providerDraft === "codex" ||
    keyDraft.trim().length > 0 ||
    keyPresent;

  async function refresh() {
    const s = await invoke<SettingsDto>("cmd_get_settings");
    if (!s) return; // outside Tauri (harness) the read can come back empty
    setDto(s);
    setBaseUrlDraft(s.ai_base_url);
    setRetentionDraft(s.ai_requests_retention_days);
    const storedTheme = normalizeThemePref(s.ui_theme);
    if (storedTheme) setThemePrefLocal(storedTheme);
    // Seed the fallback draft from the saved provider when it's a fallback one;
    // otherwise leave the reader's last in-sheet choice intact.
    if (s.ai_provider && s.ai_provider !== "company" && s.ai_provider !== "none") {
      setProviderDraft(s.ai_provider);
      setModelDraft(modelForProvider(s, s.ai_provider));
    } else {
      setModelDraft(modelForProvider(s, providerDraft));
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Real allowance, only meaningful in the included (company) mode.
  useEffect(() => {
    if (provider !== "company") {
      setCredits(null);
      return;
    }
    let alive = true;
    invoke<CompanyCredits>("cmd_company_credits")
      .then((c) => alive && setCredits(c))
      .catch(() => alive && setCredits(null));
    return () => {
      alive = false;
    };
  }, [provider]);

  // Company status is a persisted-flag read (no network, no Keychain) and the
  // activation door must exist from ANY mode — a failed deep link can land
  // here while the reader is on local or their own key.
  useEffect(() => {
    let alive = true;
    invoke<CompanyStatus>("cmd_company_status")
      .then((st) => alive && setCompanyStatus(st))
      .catch(() => alive && setCompanyStatus(null));
    return () => {
      alive = false;
    };
  }, []);

  // Audit list.
  useEffect(() => {
    let alive = true;
    invoke<AiRequest[]>("cmd_list_ai_requests")
      .then((r) => alive && setRequests(r))
      .catch(() => alive && setRequests([]));
    return () => {
      alive = false;
    };
  }, []);

  // A company activation elsewhere (e.g. a throughline://activate deep link)
  // should refresh the settings and the allowance meter even while Settings is
  // already open — App dispatches `tl-company-activated` for exactly this.
  useEffect(() => {
    const onActivated = () => {
      refresh();
      invoke<CompanyCredits>("cmd_company_credits")
        .then(setCredits)
        .catch(() => setCredits(null));
      invoke<CompanyStatus>("cmd_company_status")
        .then(setCompanyStatus)
        .catch(() => setCompanyStatus(null));
    };
    window.addEventListener("tl-company-activated", onActivated);
    return () => window.removeEventListener("tl-company-activated", onActivated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Detect local models while the setup sheet shows the local mode (debounced).
  useEffect(() => {
    if (!sourceSheet || providerDraft !== "local") return;
    const h = setTimeout(() => refreshModels(baseUrlDraft), 250);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceSheet, providerDraft, baseUrlDraft]);

  async function refreshModels(baseUrl: string) {
    setLoadingModels(true);
    try {
      setModels(await invoke<string[]>("cmd_list_ai_models", { provider: "local", baseUrl }));
    } catch {
      setModels(null);
    } finally {
      setLoadingModels(false);
    }
  }

  async function pickAndSaveFolder() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    setSavingExport(true);
    setExportMsg(null);
    try {
      const s = await invoke<SettingsDto>("cmd_set_export_path", { path: picked });
      setDto(s);
      setExportMsg({ kind: "ok", text: "Export folder updated." });
    } catch (e: any) {
      setExportMsg({ kind: "err", text: String(e?.message ?? e) });
    } finally {
      setSavingExport(false);
    }
  }

  // Export the whole library to clean Markdown — one literature note per book.
  // Names the folder, never a raw path; every error says what happened + what to do.
  async function exportLibrary() {
    setExportingLib(true);
    setLibExportMsg(null);
    try {
      const r = await invoke<LibraryExportResult>("cmd_export_library");
      const folder = folderDisplayName(r.root) || exportFolderName;
      setLibExportMsg({
        kind: "ok",
        text:
          r.exported === 0
            ? `No books to export yet — add a book first, then export to your ${folder} folder.`
            : `Exported ${r.exported} book${r.exported === 1 ? "" : "s"} to your ${folder} folder.`,
      });
    } catch (e: any) {
      setLibExportMsg({
        kind: "err",
        text: `Couldn't export your library: ${String(e?.message ?? e)}. Your books are unchanged — try again, or pick a different export folder above.`,
      });
    } finally {
      setExportingLib(false);
    }
  }

  function toggleTutor() {
    const next = !tutorOn;
    setTutorEnabled(next);
    setTutorOn(next);
  }

  // Session names (AI phrases) on/off — persisted; off = zero phrase calls.
  async function togglePhrases() {
    if (!dto) return;
    try {
      const s = await invoke<SettingsDto>("cmd_set_ai_settings", { aiPhrases: !dto.ai_phrases });
      setDto(s);
    } catch {
      /* leave the switch where it was — settings refresh will reconcile */
    }
  }

  // Enter an activation code right here (the same cmd the deep link uses).
  async function activateWithCode() {
    const token = codeDraft.trim();
    if (!token) return;
    setActivating(true);
    setActivateMsg(null);
    try {
      await invoke("cmd_activate_company", { activationToken: token });
      setCodeDraft("");
      // The same event the deep link fires — refreshes this screen in place.
      window.dispatchEvent(new Event("tl-company-activated"));
    } catch (e: any) {
      setActivateMsg(String(e?.message ?? e));
    } finally {
      setActivating(false);
    }
  }

  // ── "Answers come from" mode switching ──────────────────────
  async function selectIncluded(): Promise<boolean> {
    setAiMsg(null);
    setConn(null);
    try {
      const s = await invoke<SettingsDto>("cmd_set_ai_settings", {
        provider: "company",
        model: modelForProvider(dto!, "company"),
      });
      setDto(s);
      return true;
    } catch (e: any) {
      setAiMsg({ kind: "err", text: String(e?.message ?? e) });
      return false;
    }
  }

  function onFallbackProvider(prov: string) {
    setProviderDraft(prov);
    setConn(null);
    setKeyDraft("");
    if (dto) setModelDraft(modelForProvider(dto, prov));
  }

  /** Open the deep setup sheet seeded to a fallback family. Nothing switches
   *  here — committing happens inside via "Use this". */
  function openSourceSheet(target: "own_key" | "local") {
    setAiMsg(null);
    setConn(null);
    if (target === "local") {
      onFallbackProvider("local");
    } else if (providerDraft === "local") {
      onFallbackProvider("anthropic");
    }
    setSourceSheet({ target });
  }

  /** The "Answers come from" select. "Throughline AI" commits directly (it is
   *  zero-setup); a fallback option opens its setup sheet instead. */
  function onSourceChange(v: string) {
    if (v === "included") {
      void selectIncluded();
      return;
    }
    if (v === "own_key" || v === "local") openSourceSheet(v);
  }

  async function saveFallback(targetProvider: string): Promise<boolean> {
    setSavingAi(true);
    setAiMsg(null);
    try {
      const needs = targetProvider === "openai" || targetProvider === "anthropic";
      if (needs && keyDraft.trim()) {
        await invoke<SettingsDto>("cmd_set_ai_key", { provider: targetProvider, key: keyDraft.trim() });
        setKeyDraft("");
      }
      const args: Record<string, unknown> = { provider: targetProvider, model: modelDraft };
      if (targetProvider === "local") args.baseUrl = baseUrlDraft;
      const s = await invoke<SettingsDto>("cmd_set_ai_settings", args);
      setDto(s);
      setAiMsg({ kind: "ok", text: "Saved." });
      return true;
    } catch (e: any) {
      setAiMsg({ kind: "err", text: String(e?.message ?? e) });
      return false;
    } finally {
      setSavingAi(false);
    }
  }

  async function clearKey() {
    try {
      const s = await invoke<SettingsDto>("cmd_clear_ai_key", { provider: providerDraft });
      setDto(s);
      setAiMsg({ kind: "ok", text: "Key removed." });
    } catch (e: any) {
      setAiMsg({ kind: "err", text: String(e?.message ?? e) });
    }
  }

  async function testConnection() {
    setTesting(true);
    setConn(null);
    try {
      const r = await invoke<ConnTestResult>("cmd_test_ai_connection", {
        provider: providerDraft,
        key: needsKey && keyDraft.trim() ? keyDraft.trim() : undefined,
        baseUrl: baseUrlDraft,
      });
      setConn(r);
      if (r.reachable && providerDraft === "local") refreshModels(baseUrlDraft);
    } catch (e: any) {
      setConn({ reachable: false, first_model_id: null, message: String(e?.message ?? e) });
    } finally {
      setTesting(false);
    }
  }

  // ── Audit (retention + forget) ────────────────────────────────────
  async function saveRetention(next: number) {
    const n = Math.max(0, next);
    setRetentionDraft(n);
    try {
      await invoke<SettingsDto>("cmd_set_ai_settings", { retentionDays: n });
      await refresh();
    } catch {
      /* keep the optimistic value; refresh restores truth */
    }
  }

  async function forgetNow() {
    setForgetting(true);
    setForgetMsg(null);
    try {
      const removed = await invoke<number>("cmd_forget_ai_history");
      setRequests(await invoke<AiRequest[]>("cmd_list_ai_requests"));
      setForgetMsg(
        removed === 0
          ? "Nothing to forget — nothing is past the window."
          : `Forgot ${removed} entr${removed === 1 ? "y" : "ies"} past the window. Anything saved as a note was kept.`,
      );
    } catch (e: any) {
      setForgetMsg(String(e?.message ?? e));
    } finally {
      setForgetting(false);
    }
  }

  // ── Allowance derivation: a qualitative on/low signal ONLY. The fraction stays
  //    internal; no number, percent, or bar is ever rendered (the no-counter rule).
  const allowance = useMemo(() => {
    if (!credits || credits.status !== "active") return null;
    const frac = Math.max(0, Math.min(1, credits.remaining_fraction));
    return { low: frac <= 0.33 };
  }, [credits]);

  // ── Audit grouping (by book) for the expanded list ─────────────────
  const grouped = useMemo(() => {
    const sent = (requests ?? []).filter((r) => r.provider != null);
    const groups = new Map<string, AiRequest[]>();
    for (const r of sent) {
      const title = r.book_title ?? "A removed book";
      if (!groups.has(title)) groups.set(title, []);
      groups.get(title)!.push(r);
    }
    const sentCount = sent.length;
    const localOnly = (requests ?? []).length - sentCount;
    return { groups: Array.from(groups.entries()), sentCount, localOnly };
  }, [requests]);

  const exportFolderName = useMemo(
    () => folderDisplayName(dto?.export_path) || "Reading",
    [dto?.export_path],
  );

  // The select's face: a pending sheet target shows optimistically; cancelling
  // the sheet snaps it back to the real committed mode.
  const sourceValue: Mode = sourceSheet ? (sourceSheet.target as Mode) : mode;

  const lastBackupLine = backup
    ? backup.last_backup_at
      ? `last backup ${fmtBackupWhen(backup.last_backup_at)}`
      : "no backup yet"
    : "";

  /* ═══════════════════════════ PANES ═══════════════════════════ */

  const readingPane = (
    <>
      <h3 className="set-pane-title">Reading</h3>
      <div className="set-rows">
        <div className="set-row">
          <div className="set-row-label">
            A good sitting <span className="set-row-detail">· sizes each day's reading, no timer</span>
          </div>
          <select
            className="select"
            aria-label="Reading pace"
            value={String([10, 25, 60].includes(paceMinutes ?? 25) ? (paceMinutes ?? 25) : 25)}
            onChange={(e) => void changePace(Number(e.target.value))}
            disabled={paceMinutes == null}
          >
            {/* The app's three sitting sizes keep their long-standing names
                (they match the first-journey pace step) — see the redesign
                notes for the deviation from the handoff's option copy. */}
            <option value="10">A few pages</option>
            <option value="25">A chapter</option>
            <option value="60">A long read</option>
          </select>
        </div>
        <div className="set-row">
          <div className="set-row-label">
            Quoting <span className="set-row-detail">· short quotes for private study, never a block</span>
          </div>
          <span className="set-row-status">Always on</span>
        </div>
      </div>
    </>
  );

  const appearancePane = (
    <>
      <h3 className="set-pane-title">Appearance</h3>
      <div className="set-rows">
        <div className="set-row">
          <div className="set-row-label">Theme</div>
          <div className="set-seg" role="group" aria-label="Theme">
            {(["light", "dark", "auto"] as const).map((t) => (
              <button
                key={t}
                type="button"
                className="set-seg-opt"
                aria-pressed={themePref === t}
                onClick={() => setThemePref(t)}
              >
                {t === "light" ? "Light" : t === "dark" ? "Dark" : "Auto"}
              </button>
            ))}
          </div>
        </div>
        <div className="set-row">
          <div className="set-row-label">Typeface</div>
          <select
            className="select"
            aria-label="Typeface"
            value={typeface}
            onChange={(e) => void changeTypeface(e.target.value)}
          >
            <option value="newsreader">Newsreader</option>
            <option value="iowan">Iowan Old Style</option>
            <option value="charter">Charter</option>
          </select>
        </div>
        <div className="set-row">
          <div className="set-row-label">Text size</div>
          <div className="set-stepper">
            <button
              type="button"
              aria-label="Smaller text"
              disabled={fontSize <= FONT_SIZE_MIN}
              onClick={() => setFontSize(adjustFontSize(-1))}
            >
              −
            </button>
            <span className="set-stepper-val">{fontSize} pt</span>
            <button
              type="button"
              aria-label="Larger text"
              disabled={fontSize >= FONT_SIZE_MAX}
              onClick={() => setFontSize(adjustFontSize(+1))}
            >
              +
            </button>
          </div>
        </div>
        <div className="set-row">
          <div className="set-row-label">Line spacing</div>
          <select
            className="select"
            aria-label="Line spacing"
            value={lineSpacing}
            onChange={(e) => void changeLineSpacing(e.target.value)}
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
            <option value="open">Open</option>
          </select>
        </div>
      </div>
    </>
  );

  const assistantPane = (
    <>
      <h3 className="set-pane-title">Assistant</h3>
      <div className="set-rows">
        <div className="set-row">
          <div className="set-row-label">
            Tutor in the margin{" "}
            <span className="set-row-detail">· Explain, Context, or Define beside the text</span>
          </div>
          <button
            className="toggle"
            role="switch"
            aria-checked={tutorOn}
            aria-label="Tutor in the margin"
            onClick={toggleTutor}
          />
        </div>
        <div className="set-row">
          <div className="set-row-label">
            Session names <span className="set-row-detail">· only a chapter's opening lines are sent</span>
          </div>
          <button
            className="toggle"
            role="switch"
            aria-checked={dto?.ai_phrases ?? true}
            aria-label="Session names"
            onClick={togglePhrases}
          />
        </div>
        <div className="set-row">
          <div className="set-row-label">Answers come from</div>
          <div className="set-row-controls">
            {mode !== "included" && (
              <button type="button" className="btn btn-small" onClick={() => openSourceSheet(mode)}>
                Set up
              </button>
            )}
            <select
              className="select"
              aria-label="Answers come from"
              value={sourceValue}
              onChange={(e) => onSourceChange(e.target.value)}
            >
              <option value="included">Throughline AI</option>
              <option value="own_key">Your own AI</option>
              <option value="local">On this Mac only</option>
            </select>
          </div>
        </div>
        {mode === "included" && companyStatus?.has_license && (
          <div className="set-row">
            <div className="set-row-label">Included tutoring</div>
            <span className="set-row-status" role="status">
              {allowance ? (allowance.low ? "Running low" : "On · plenty remaining") : "On"}
            </span>
          </div>
        )}
      </div>
      {mode === "included" && allowance?.low && (
        <p className="set-note">
          Your included tutoring is running low. When it runs out, the tutor keeps working with your
          own API key or a local model, free.
        </p>
      )}
      {aiMsg && !sourceSheet && (
        <p className={`set-msg ${aiMsg.kind}`}>{aiMsg.text}</p>
      )}
      {/* Activation door — renders from EVERY mode (a failed throughline://activate
          can land here while the reader is on local or their own key). */}
      {companyStatus && !companyStatus.has_license && (
        <div className="set-activation">
          <span className="field-label">Already bought Throughline AI?</span>
          <p className="field-desc">Enter your activation code; the email receipt carries it.</p>
          <div className="field-row">
            <input
              className="input"
              value={codeDraft}
              onChange={(e) => setCodeDraft(e.target.value)}
              placeholder="XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              aria-label="Activation code"
            />
            <button
              type="button"
              className="btn"
              disabled={activating || !codeDraft.trim()}
              onClick={activateWithCode}
            >
              {activating ? "Activating…" : "Activate"}
            </button>
          </div>
          {activateMsg && <p className="byo-warn" role="alert">{activateMsg}</p>}
        </div>
      )}
      {mode === "included" && companyStatus?.has_license && (
        <p className="company-active" role="status">Throughline AI is active.</p>
      )}
    </>
  );

  const privacyPane = (
    <>
      <h3 className="set-pane-title">Privacy</h3>
      <div className="set-rows">
        <div className="set-row set-row-stack">
          <div className="set-row-top">
            <div className="set-row-label">Everything stays on this Mac</div>
            <span className="set-row-always">Always</span>
          </div>
          <p className="set-row-explain">
            Books never leave this computer. When you ask about a passage, only that passage is
            sent, never the whole book. Nothing is saved unless you keep it as a note.
          </p>
          {/* Mode-aware honesty (kept from the trust card): what "sent" means
              right now, in the reader's own configuration. */}
          <p className="set-row-explain">
            {mode === "local" ? (
              <>
                You're using <b>On this Mac only</b>, so nothing is sent. Every answer is worked
                out here and stays on this Mac.
              </>
            ) : mode === "own_key" ? (
              <>
                You're using <b>your own {aiProviderLabel(provider)}</b>, so the passages you ask
                about are sent there to be answered.
              </>
            ) : (
              <>
                You're using the <b>included assistant</b>, so the passages you ask about are sent
                to be answered.
              </>
            )}
          </p>
        </div>
        <div className="set-row">
          <div className="set-row-label">What's left this Mac</div>
          <button type="button" className="set-link" onClick={() => setAuditOpen(true)}>
            {grouped.sentCount} passage{grouped.sentCount === 1 ? "" : "s"} · Show what was sent
          </button>
        </div>
      </div>
    </>
  );

  const filesPane = (
    <>
      <h3 className="set-pane-title">Files</h3>
      <div className="set-rows">
        <div className="set-row">
          <div className="set-row-label">
            Export folder <span className="set-row-detail">· notes and exported books</span>
          </div>
          <button
            type="button"
            className="path-chip"
            disabled={savingExport}
            onClick={pickAndSaveFolder}
            aria-label="Change export folder"
          >
            <Icon d={ICON.folder} size={15} />
            <span className="name">{exportFolderName}</span>
          </button>
        </div>
        {exportMsg && <p className={`set-msg ${exportMsg.kind}`}>{exportMsg.text}</p>}
        <div className="set-row">
          <div className="set-row-label">
            Export your library{" "}
            <span className="set-row-detail">· clean Markdown, your edits are kept</span>
          </div>
          <button
            type="button"
            className="btn btn-accent btn-small"
            disabled={exportingLib}
            onClick={exportLibrary}
          >
            <Icon d={ICON.up} size={15} />
            {exportingLib ? "Exporting…" : "Export"}
          </button>
        </div>
        {libExportMsg && <p className={`set-msg ${libExportMsg.kind}`}>{libExportMsg.text}</p>}
        <div className="set-row">
          <div className="set-row-label">
            Automatic backups{" "}
            {lastBackupLine && <span className="set-row-detail">· {lastBackupLine}</span>}
          </div>
          <button
            className="toggle"
            role="switch"
            aria-checked={backup?.enabled ?? true}
            aria-label="Automatic backups"
            disabled={!backup}
            onClick={toggleBackups}
          />
        </div>
        <div className="set-row">
          <div className="set-row-label">Restore from backup</div>
          <button type="button" className="btn btn-small" onClick={openRestore}>
            Choose a backup
          </button>
        </div>
      </div>
    </>
  );

  const SHORTCUTS: Array<[string, string]> = [
    ["Ask about the selection", "⌘ E"],
    ["Add a note", "⌘ N"],
    ["Search your library", "⌘ K"],
    ["Bigger or smaller text", "⌘ + / ⌘ −"],
    ["Toggle theme", "⌘ ⇧ L"],
    ["Settings", "⌘ ,"],
  ];
  const shortcutsPane = (
    <>
      <h3 className="set-pane-title">Shortcuts</h3>
      <div className="set-rows">
        {SHORTCUTS.map(([what, keys]) => (
          <div className="set-row set-row-tight" key={what}>
            <span className="set-shortcut-what">{what}</span>
            <kbd className="set-kbd">{keys}</kbd>
          </div>
        ))}
      </div>
    </>
  );

  /* ═══════════════════════════ SHEETS ═══════════════════════════ */

  const sourceSheetEl = sourceSheet && (
    <SettingsSheet label="Answers come from" onClose={() => setSourceSheet(null)}>
      <h3 className="set-sheet-title">Answers come from</h3>
      <p className="set-sheet-sub">
        Choose who answers your questions. Nothing switches until you tap “Use this”.
      </p>

      {/* Two fallback families: own key · on this Mac only */}
      <div className="segmented" role="group" aria-label="Use your own AI">
        <button
          type="button"
          className="seg"
          aria-pressed={providerDraft !== "local"}
          onClick={() =>
            onFallbackProvider(providerDraft === "local" ? "anthropic" : providerDraft)
          }
        >
          <Icon d={ICON.key} size={18} />
          Your own key
        </button>
        <button
          type="button"
          className="seg"
          aria-pressed={providerDraft === "local"}
          onClick={() => onFallbackProvider("local")}
        >
          <Icon d={ICON.monitor} size={18} />
          On this Mac only
        </button>
      </div>

      {providerDraft !== "local" && (
        <>
          <div className="field">
            <span className="field-label">Which service</span>
            <select
              className="select"
              aria-label="Which service"
              value={providerDraft}
              onChange={(e) => onFallbackProvider(e.target.value)}
            >
              {KEY_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>

          {needsKey && (
            <>
              <div className="field">
                <span className="field-label">{aiProviderLabel(providerDraft)} key</span>
                <p className="field-desc">
                  {keyPresent
                    ? "A key is saved in your Keychain. Enter a new one to replace it, or remove it."
                    : "Stored in your macOS Keychain — never written to disk or exports."}
                </p>
                <div className="field-row">
                  <input
                    className="input"
                    type="password"
                    value={keyDraft}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={providerDraft === "openai" ? "sk-…" : "sk-ant-…"}
                    aria-label={`${aiProviderLabel(providerDraft)} key`}
                  />
                  {keyPresent ? (
                    <button type="button" className="btn" onClick={clearKey}>Remove</button>
                  ) : null}
                </div>
                {!keyPresent && (
                  <p className="byo-warn">
                    <Icon d={ICON.warn} size={15} />
                    <span>Add a key to start answering. Until then, the included assistant keeps working.</span>
                  </p>
                )}
              </div>

              <div className="field">
                <span className="field-label">Model</span>
                <p className="field-desc">The chip shows the going rate for heavier vs. lighter models.</p>
                <ModelSelect provider={providerDraft} value={modelDraft} onChange={setModelDraft} />
              </div>
            </>
          )}

          {providerDraft === "codex" && (
            <div className="field">
              <span className="field-label">ChatGPT sign-in</span>
              <p className="field-desc">
                Sign in once with your ChatGPT account — no key needed. Stored in your Keychain.
              </p>
              <CodexLogin
                present={!!dto?.ai_codex_creds_present}
                onComplete={refresh}
                onSignedOut={refresh}
              />
            </div>
          )}
        </>
      )}

      {providerDraft === "local" && (
        <>
          <div className="field">
            <span className="field-label">Server address</span>
            <p className="field-desc">
              Where your local model listens on this Mac (LM Studio's default works as-is).
            </p>
            <input
              className="input"
              type="text"
              value={baseUrlDraft}
              onChange={(e) => setBaseUrlDraft(e.target.value)}
              spellCheck={false}
              placeholder="http://localhost:1234/v1"
              aria-label="Server address"
            />
          </div>
          <div className="field">
            <span className="field-label">Model</span>
            <p className="field-desc">Pick a detected one or type it.</p>
            <div className="field-row">
              <select
                className="select"
                aria-label="Local model"
                value={models?.includes(modelDraft) ? modelDraft : ""}
                onChange={(e) => { if (e.target.value) setModelDraft(e.target.value); }}
                disabled={!models || models.length === 0}
              >
                <option value="">
                  {loadingModels ? "Loading…" : models && models.length > 0 ? "Pick a detected model…" : "No models detected"}
                </option>
                {(models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <input
                className="input"
                type="text"
                value={modelDraft}
                onChange={(e) => setModelDraft(e.target.value)}
                spellCheck={false}
                placeholder="e.g. qwen2.5-7b-instruct"
                aria-label="Local model name"
              />
            </div>
          </div>
        </>
      )}

      {/* Test + commit for the chosen fallback */}
      <div className="field-row">
        <button type="button" className="btn" disabled={testing} onClick={testConnection}>
          {testing ? "Testing…" : "Test"}
        </button>
        <button
          type="button"
          className="btn btn-accent"
          disabled={savingAi || !canCommitFallback}
          onClick={() => {
            void saveFallback(providerDraft).then((ok) => {
              if (ok) setSourceSheet(null);
            });
          }}
        >
          {savingAi ? "Saving…" : "Use this"}
        </button>
        {mode !== "included" && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              void selectIncluded().then((ok) => {
                if (ok) setSourceSheet(null);
              });
            }}
          >
            Back to included assistant
          </button>
        )}
      </div>
      {(aiMsg || conn) && (
        <p className={`set-msg ${conn ? (conn.reachable ? "ok" : "err") : aiMsg?.kind}`}>
          {conn ? conn.message : aiMsg?.text}
        </p>
      )}
    </SettingsSheet>
  );

  const auditSheetEl = auditOpen && (
    <SettingsSheet label="What's left this Mac" onClose={() => setAuditOpen(false)}>
      <h3 className="set-sheet-title">What's left this Mac</h3>
      <p className="set-sheet-sub">
        {grouped.sentCount === 0
          ? "Nothing has been sent. When you ask about a passage, the single passage you selected is recorded here."
          : `${grouped.sentCount} passage${grouped.sentCount === 1 ? " was" : "s were"} sent to answer your questions. Each was a single passage you selected — never a whole book.`}
      </p>

      {grouped.sentCount > 0 && (
        <div className="log">
          <div className="log-head">
            <span>What you asked</span>
            <span>Left this Mac</span>
          </div>
          {grouped.groups.map(([title, rows]) => (
            <div key={title}>
              <div className="log-group">
                {title} <span className="ct">· {rows.length}</span>
              </div>
              {rows.map((r) => (
                <div className="log-row" key={r.id}>
                  <span className="log-what">
                    {lensLabel(r.mode)} <span className="when">· {fmtWhen(r.created_at)}</span>
                    {r.wrote_to_memory ? <span className="saved"> · saved as note</span> : null}
                  </span>
                  <span className="log-sent">
                    <Icon d={ICON.up} size={14} /> Sent to assistant
                  </span>
                </div>
              ))}
            </div>
          ))}
          {grouped.localOnly > 0 && (
            <p className="log-more">
              {grouped.localOnly} more never left this Mac — previews you didn't send.
            </p>
          )}
        </div>
      )}

      <div className="audit-controls">
        <span className="retain">
          Keep this list for
          <span className="stepper">
            <span className="num">{retentionDraft}</span>
            <span className="arrows">
              <button type="button" aria-label="Keep longer" onClick={() => saveRetention(retentionDraft + 30)}>
                <Icon d={ICON.caretUp} size={11} />
              </button>
              <button type="button" aria-label="Keep shorter" onClick={() => saveRetention(Math.max(0, retentionDraft - 30))}>
                <Icon d={ICON.caretDown} size={11} />
              </button>
            </span>
          </span>
          days
        </span>
        <button type="button" className="btn" disabled={forgetting} onClick={forgetNow}>
          <Icon d={ICON.trash} size={15} /> {forgetting ? "Forgetting…" : "Forget now"}
        </button>
      </div>
      {forgetMsg && <p className="set-msg ok">{forgetMsg}</p>}
    </SettingsSheet>
  );

  const restoreSheetEl = restoreOpen && (
    <SettingsSheet
      label="Restore from backup"
      onClose={() => {
        if (!restoring) setRestoreOpen(false);
      }}
    >
      <h3 className="set-sheet-title">Restore from backup</h3>
      <p className="set-sheet-sub">
        Your library goes back to how it was when the backup was made. Today's copy is kept safe
        first, so nothing is lost.
      </p>
      {backupsList === null ? (
        <p className="set-sheet-sub">Looking for backups…</p>
      ) : backupsList.length === 0 ? (
        <p className="set-sheet-sub">
          No backups yet. Turn on Automatic backups and one is made right away.
        </p>
      ) : (
        <div className="set-backups" role="radiogroup" aria-label="Choose a backup">
          {backupsList.map((b) => (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={restoreTarget?.id === b.id}
              className={restoreTarget?.id === b.id ? "set-backup-row selected" : "set-backup-row"}
              onClick={() => setRestoreTarget(b)}
            >
              From {fmtBackupWhen(b.taken_at)}
            </button>
          ))}
        </div>
      )}
      {restoreMsg && <p className="set-msg ok" role="status">{restoreMsg}</p>}
      <div className="field-row set-sheet-foot">
        <button type="button" className="btn" disabled={restoring} onClick={() => setRestoreOpen(false)}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-accent"
          disabled={!restoreTarget || restoring}
          onClick={() => void doRestore()}
        >
          {restoring ? "Restoring…" : "Restore"}
        </button>
      </div>
    </SettingsSheet>
  );

  /* ═══════════════════════════ FRAME ═══════════════════════════ */

  return (
    <div className="tl-settings2 set-window">
      <nav className="set-rail" aria-label="Settings sections" onKeyDown={onRailKeyDown}>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={active === s.id ? "set-rail-item active" : "set-rail-item"}
            aria-current={active === s.id ? "page" : undefined}
            onClick={() => goTo(s.id)}
          >
            {s.label}
          </button>
        ))}
        <div className="set-rail-divider" role="presentation" />
        <button
          type="button"
          className={active === "feedback" ? "set-rail-item active" : "set-rail-item"}
          aria-current={active === "feedback" ? "page" : undefined}
          onClick={() => goTo("feedback")}
        >
          Send feedback
        </button>
        <div className="set-rail-foot">
          <p>
            No accounts. No tracking.
            <br />
            Your reading is yours.
          </p>
          {appVersion && <p className="set-rail-version">Throughline {appVersion}</p>}
        </div>
      </nav>

      <div className="set-pane">
        {active === "reading" && readingPane}
        {active === "appearance" && appearancePane}
        {active === "assistant" && assistantPane}
        {active === "privacy" && privacyPane}
        {active === "files" && filesPane}
        {active === "shortcuts" && shortcutsPane}
        {active === "feedback" && (
          <FeedbackPanel mode={mode} onClose={() => setActive(prevSection.current)} />
        )}
      </div>

      {sourceSheetEl}
      {auditSheetEl}
      {restoreSheetEl}
    </div>
  );
}
