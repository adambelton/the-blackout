import type { Broadcast } from "./broadcast.js";

/**
 * Prerequisites for a draft → scheduled transition. Single source of
 * truth for both the server (which 422s on missing prereqs) and the
 * moderator UI (which surfaces the same blocker list to the operator
 * before they hit Schedule). Drift between the two used to cost a
 * round-trip + a confusing error toast.
 *
 * Returns an empty array when the broadcast is ready to schedule.
 */
export function collectScheduleBlockers(b: Broadcast): string[] {
  const blockers: string[] = [];
  if (!b.matchBrief?.trim()) blockers.push("match brief is empty");
  if (b.fixtureId == null) blockers.push("fixture not set");
  if (!b.radioSourceId) blockers.push("radio source not set");
  if (b.ttsEnabled === true && !b.ttsVoiceId) blockers.push("TTS is enabled but no voice is selected");
  return blockers;
}
