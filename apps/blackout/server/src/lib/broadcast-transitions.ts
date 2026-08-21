import type { BroadcastStatus } from "@blackout/shared";

export interface TransitionError {
  message: string;
  statusCode: 422;
}

/**
 * Guards the `complete → archived` transition. Archiving excludes a
 * broadcast from the public replays surface. Only valid from `complete`
 * — the broadcast must have finished a full run before it can be
 * curated out.
 */
export function validateArchive(status: BroadcastStatus): TransitionError | null {
  if (status !== "complete") {
    return { message: "Only completed broadcasts can be archived", statusCode: 422 };
  }
  return null;
}

/**
 * Guards the delete operation. Deleting a live broadcast would pull the
 * room out from under active members; every other status is safe to
 * remove.
 */
export function validateDelete(status: BroadcastStatus): TransitionError | null {
  if (status === "live") {
    return { message: "Cannot delete a live broadcast", statusCode: 422 };
  }
  return null;
}
