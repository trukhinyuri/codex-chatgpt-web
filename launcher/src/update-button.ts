import type { UpdateState } from "./types";

type UpdateCopy = Record<"updating" | "updateReady" | "updateReadyHint" | "updatePreparing" | "updatePreparingHint" | "updateWaitingTasks" | "updateInstallingSoon", string>;

/**
 * The update button says what the pending update is doing. It stays clickable while the update builds
 * or waits for an idle Codex: a click installs it 30 s after Codex's tasks finish (or, from the dialog
 * the launcher shows while tasks run, at once).
 */
export function updateButtonState(update: UpdateState, copy: UpdateCopy): { label: string | null; title?: string; disabled: boolean } {
  if (update.status === "downloading") {
    const label = update.step && update.steps
      ? copy.updatePreparing.replace("{step}", String(update.step)).replace("{steps}", String(update.steps))
      : copy.updating;
    return { label, title: copy.updatePreparingHint, disabled: false };
  }
  if (update.status === "installing") {
    if (update.waitingForIdle !== true) return { label: copy.updating, disabled: true };
    if (update.requested !== true) return { label: copy.updateReady, title: copy.updateReadyHint, disabled: false };
    if ((update.activeTurns ?? 0) > 0) {
      return { label: copy.updateWaitingTasks.replace("{count}", String(update.activeTurns)), title: copy.updateReadyHint, disabled: false };
    }
    return { label: copy.updateInstallingSoon, disabled: true };
  }
  return { label: null, disabled: false };
}
