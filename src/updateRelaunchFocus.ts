import { invoke } from "@tauri-apps/api/core";

type FocusOps = () => Promise<void>;
type ConsumeFocusIntent = () => Promise<boolean>;

export async function consumeUpdateRelaunchFocusIntent(): Promise<boolean> {
  return invoke<boolean>("cmd_consume_update_relaunch_focus");
}

async function focusCurrentWindow(): Promise<void> {
  const [{ show: showApp }, { getCurrentWindow }] = await Promise.all([
    import("@tauri-apps/api/app"),
    import("@tauri-apps/api/window"),
  ]);
  await showApp().catch(() => {});
  const win = getCurrentWindow();
  await win.show().catch(() => {});
  await win.unminimize().catch(() => {});
  await win.setFocus();
}

export async function focusAfterUpdateRelaunchIfNeeded(
  consumeFocusIntent: ConsumeFocusIntent = consumeUpdateRelaunchFocusIntent,
  focusOps: FocusOps = focusCurrentWindow,
): Promise<boolean> {
  let shouldFocus = false;
  try {
    shouldFocus = await consumeFocusIntent();
  } catch {
    return false;
  }
  if (shouldFocus !== true) return false;

  try {
    await focusOps();
    return true;
  } catch {
    return false;
  }
}
