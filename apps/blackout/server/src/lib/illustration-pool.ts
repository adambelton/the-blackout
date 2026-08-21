/**
 * Blackout-side illustration record access.
 *
 * Kairos is the authoritative home of the pool — it holds prompt,
 * tags, and the `consumer_metadata.illustrationId` pointer that
 * Blackout stashes at accept time. Blackout owns the image bytes and
 * rich metadata (model, contentType, imageKey, etc) in
 * `broadcast_illustrations`.
 *
 * This module covers Blackout-side row access only:
 * - Insert a newly generated image (staging or runtime)
 * - Look up a row by id (for the conductor's pool-hit resolver and
 *   the studio's URL-resolution helper)
 * - Delete a row + list them per-broadcast for UI
 *
 * Pool acceptance flow routes through Kairos; see
 * `apps/blackout/server/src/routes/broadcasts.ts` for the orchestration.
 */
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  broadcastDiscardedPrompts,
  broadcastIllustrations,
} from "../db/schema.js";

export interface IllustrationRow {
  id: string;
  broadcastId: string;
  narrativeId: string | null;
  prompt: string;
  imageKey: string;
  contentType: string;
  model: string;
  generatedAt: string;
  generationMs: number;
}

type Row = typeof broadcastIllustrations.$inferSelect;

function fromRow(row: Row): IllustrationRow {
  return {
    id: row.id,
    broadcastId: row.broadcastId,
    narrativeId: row.narrativeId,
    prompt: row.prompt,
    imageKey: row.imageKey,
    contentType: row.contentType,
    model: row.model,
    generatedAt: row.generatedAt.toISOString(),
    generationMs: row.generationMs,
  };
}

export async function insertIllustration(input: {
  broadcastId: string;
  narrativeId?: string | null;
  prompt: string;
  imageKey: string;
  contentType: string;
  model: string;
  generationMs: number;
}): Promise<IllustrationRow> {
  const [row] = await db
    .insert(broadcastIllustrations)
    .values({
      broadcastId: input.broadcastId,
      narrativeId: input.narrativeId ?? null,
      prompt: input.prompt,
      imageKey: input.imageKey,
      contentType: input.contentType,
      model: input.model,
      generationMs: input.generationMs,
    })
    .returning();
  return fromRow(row);
}

export async function getIllustration(
  id: string,
): Promise<IllustrationRow | null> {
  const [row] = await db
    .select()
    .from(broadcastIllustrations)
    .where(eq(broadcastIllustrations.id, id))
    .limit(1);
  return row ? fromRow(row) : null;
}

export async function deleteIllustration(
  id: string,
): Promise<IllustrationRow | null> {
  const [row] = await db
    .delete(broadcastIllustrations)
    .where(eq(broadcastIllustrations.id, id))
    .returning();
  return row ? fromRow(row) : null;
}

// ---------------------------------------------------------------------------
// Discarded prompts — fed into the prompt-suggester's next batch call
// as negative directional context. Lives on the Blackout side because
// prompt suggestion is a football-specific writer-prep tool, not a
// runtime orchestration concern.
// ---------------------------------------------------------------------------

export async function recordDiscardedPrompt(
  broadcastId: string,
  prompt: string,
): Promise<void> {
  const trimmed = prompt.trim();
  if (!trimmed) return;
  await db
    .insert(broadcastDiscardedPrompts)
    .values({ broadcastId, prompt: trimmed });
}

export async function listDiscardedPrompts(
  broadcastId: string,
): Promise<string[]> {
  const rows = await db
    .select({ prompt: broadcastDiscardedPrompts.prompt })
    .from(broadcastDiscardedPrompts)
    .where(eq(broadcastDiscardedPrompts.broadcastId, broadcastId))
    .orderBy(desc(broadcastDiscardedPrompts.createdAt));
  return rows.map((r) => r.prompt);
}
