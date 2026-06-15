import { invoke } from "@tauri-apps/api/core";

type FocusOps = () => Promise<void>;
type ConsumeFocusIntent = () => Promise<boolean>;

export async function consumeUpdateRelaunchFocusIntent(): Promise<boolean> {
  return invoke<boolean>("cmd_consume_update_relaunch_focus");
}

async function focusCurrentWindow(): Promise<void> {
  await invoke("cmd_focus_main_window_after_update_relaunch");
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
