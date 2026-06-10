// One-time localStorage rename shim (CORE-1031). Builds before the Throughline
// rename persisted UI preferences under the legacy app prefix below; current
// code reads and writes only `tl`-prefixed keys. Called once at startup
// (App.tsx, beside purgeLegacyBriefings): each legacy key is copied to its
// `tl` twin — never clobbering a value already written under the new name —
// and then removed, so an existing reader's tutor consent and reader
// preferences survive the rename.

/** The pre-rename app prefix. Used only by migration/purge code; new code
 *  never writes it. Exported for the legacy-briefing purge (sectionBriefing). */
export const LEGACY_PREFIX = "rg";

const PREFIX = "tl";

/** Every preference key the pre-rename build persisted. */
const MIGRATED_KEYS = [
  "tutorEnabled",
  "fontSize",
  "lineWidth",
  "panelOpen",
  "panelWidth",
] as const;

export function migrateLegacyLocalStorageKeys(): void {
  try {
    for (const name of MIGRATED_KEYS) {
      const legacyKey = `${LEGACY_PREFIX}.${name}`;
      const value = localStorage.getItem(legacyKey);
      if (value === null) continue;
      const key = `${PREFIX}.${name}`;
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
      localStorage.removeItem(legacyKey);
    }
  } catch {
    /* storage unavailable — then nothing persisted to migrate */
  }
}
