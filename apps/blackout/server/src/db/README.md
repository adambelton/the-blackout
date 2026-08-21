# db/ — Postgres persistence (Blackout side)

Drizzle-ORM over `postgres-js`, the Blackout's own Postgres database (separate from Kairos's). Holds the broadcast records, the synthesised-audio artefacts (and their per-passage canonical bundles), the illustrations, and the radio-source and TTS-voice catalogues. Asset *bytes* don't live here — they go to the `StorageProvider` (normally the `blackout-dev` R2 bucket during development; see [`../lib/README.md`](../lib/README.md) § storage), addressed by the keys stored on the rows. The Better Auth tables (user/session/account) live in this same database but are owned by `@blackout/auth`'s schema, not this module.

## What's here

- **`schema.ts`** — the table definitions + the `broadcast_status` pgEnum.
- **`client.ts`** — `db` (the Drizzle instance) + the postgres connection. `DATABASE_URL` required.
- **`migrate.ts`** — the programmatic migrator (run by Fly `release_command`, the `predev` hook, the test harness). Idempotent. Exports `runMigrations()` for the `00-migration-smoke.test.ts` to drive a fresh-DB application in-test.
- **`check.ts`** — the post-migrate drift detector. Same shape as Kairos's: asserts every table defined in `schema.ts` exists, every applied-migration row's hash matches its journal entry by sha256, cursor count equals journal count. Wired into `predev` + `pretest` (after `migrate`); PR #45 wires it into Fly's `release_command` too. Fails non-zero with a `pnpm db:reset` pointer. See the [`migrations` skill](../../../../../.claude/skills/migrations/SKILL.md) § Detection.
- **`reset.ts`** — the single sanctioned drift-recovery path: DROP SCHEMA `public` + `drizzle`, recreate, run `migrate`, run `seed`. **Local-only**, gated on a loopback hostname + "blackout" in the DB name — refuses on Neon hostnames.
- **`seed.ts`** — seeds the radio-source catalogue (and any other platform content) for local dev.

## The tables

| Table | What it holds |
|---|---|
| `broadcasts` | The broadcast record: `homeTeam`/`awayTeam`/`competition`/`matchDate`, `status` (`draft`→`scheduled`→`live`→`complete`→`archived`; `archived` is an admin curation decision — completed fine, excluded from `/replays`), `fixtureId` (Sportmonks), `radioSourceId` (FK, RESTRICT — catalogue cleanup can't detach an in-use source), `ttsVoiceId` (FK, RESTRICT; new broadcasts inherit the catalogue default), `ttsEnabled` (the pipeline-wide TTS kill switch — null/false suppresses audio across all surfaces; default-null so new broadcasts don't burn credits during testing), `moderatorId`, `kairosBroadcastId` (the link to the Kairos-side broadcast — populated by `linkBroadcastToKairos`), `matchBrief`, timestamps. |
| `broadcast_narrations` | One row per Kairos narrative that goes through TTS: `narrativeId` (Kairos's generation id), `text`, `wordCount`, `audioKey` (storage-provider key — `broadcasts/<id>/narrations/<narrativeId>.mp3`), `durationMs` (measured from the MP3 headers), `voiceId`/`provider`, `synthesizedAt`, `playbackStartedAt` (set by the conductor when this clip becomes the currently-playing one — late joiners seek to `serverNow − playbackStartedAt`; null until playback begins), `batchEntryIds` + `covers` (Kairos's batch + the entries the prose explicitly cites — for the matchroom reveal contract: a canonical event card stays hidden only while a narration that *covers* it is mid-flight; visible by default — the opt-out reveal), `revealedCanonical` + `revealingCanonical` (the per-passage canonical-state bundle, Design A — `revealedCanonical` = visible state at audio-start, `revealingCanonical` = the deltas this passage reveals during audio; written together; both NULL on rows predating the bundle contract → consumers fall back to the legacy reveal path). |
| `broadcast_illustrations` | The illustration bytes per passage (one image per passage, 2026-04-23 design): `narrativeId` (Kairos's generation id — same id the matchroom gets on the `illustration` cue, so the Blackout can re-resolve on rehydration without a Kairos round-trip; *null* on pool rows — studio-prepared images aren't tied to a narrative; pool membership is authoritatively on the Kairos side via `content_pool_items`, which stashes the `illustrationId` onto `consumer_metadata` so Kairos can thread it back at selection time), `prompt`, `imageKey` (storage key — `broadcasts/<id>/illustrations/<id>.webp`), `contentType`, `model`, `generationMs`. |
| `broadcast_discarded_prompts` | Illustration prompts the writer rejected during studio prep — fed back into the suggestion call as negative context. (Accepted prompts are derivable from `broadcast_illustrations` so they don't need a separate ledger; only rejections need a home.) |
| `radio_sources` | The radio-stream catalogue: `name`, `streamUrl` (canonical playback URL), `urlPattern` (substring matcher for legacy/free-text URLs), `defaultOffsetSeconds` (the seed for the effective-offset calibration), `transcode` (pipe through ffmpeg before Deepgram — needed for MPEG-TS HLS with HE-AAC, e.g. BBC syndication feeds, which Deepgram's byte sniffer can't parse), `lastObservedOffsetSeconds` / `lastObservedAt` / `observationCount` (updated from live-match calibration samples via `recordObservation`). |
| `tts_voices` | The admin-curated TTS-voice catalogue: `provider`, `providerVoiceId`, `name`/`description`, `speed` (override), `isDefault` (the voice stamped onto new broadcasts when none chosen — unique-where-true). Writers pick from this list; admins manage it. |
| `notify_signups` | Legacy table retained so existing databases and migration history remain valid. The concept site no longer exposes a signup route or collects notification addresses. |

(The Better Auth `user` / `session` / `account` / `verification` tables are in this database too — see `@blackout/auth`'s schema, [`packages/README.md`](../../../../../packages/README.md).)

## How it fits

`client.ts`'s `db` is imported wherever a query happens — `lib/broadcasts.ts` / `tts-voices.ts` / `radio-sources.ts` / `users.ts` (the repos), `lib/broadcast-view.ts` / `moderator-view.ts` (the bootstrap views read `broadcast_narrations`), `conductor/RoomConductor.ts` / `synthesiser.ts` (write narrations + illustrations + `playbackStartedAt`; read for recovery), and `routes/studio.ts` / `inspector.ts` (direct queries). `migrate.ts` / `seed.ts` are standalone entry points. Migration discipline — generate structural DDL with `pnpm db:generate`, commit the SQL + `meta/_journal.json` + `meta/<idx>_snapshot.json` together, never hand-write structural DDL, never mix `db:push` and `db:migrate` — is the [root CLAUDE.md](../../../../../CLAUDE.md)'s / the [`migrations` skill](../../../../../.claude/skills/migrations/SKILL.md)'s, applied here unchanged.

**Working looks like:** `[migrate] … done.` on startup; `broadcast_narrations` rows accumulating one-per-narrative with non-null `revealedCanonical`/`revealingCanonical` (the bundle written at synthesis time), `playbackStartedAt` set when the clip plays; `broadcast_illustrations` rows for generated images (null `narrativeId` for pool images); the conductor's `recoverRunningCanonical` able to rebuild bundle state from these rows on a restart.

## Open work

- **Bundle backfill** — rows predating the Design-A bundle contract have NULL `revealedCanonical`/`revealingCanonical`; consumers fall back to the legacy reveal path (covers + batchEntryIds + server-derived score) for those. A backfill (the Liverpool W broadcast specifically) is a Sub-piece-1c item; until then those broadcasts' conductor recovery starts with empty running state on restart (acceptable — they were testing data, not matchroom-served).
- Nothing structural pending on the schema itself.

## See also

- [`../../README.md`](../../README.md) — the backend as a service; the broadcast lifecycle; the persistence + assets section.
- [`../conductor/README.md`](../conductor/README.md) — writes `broadcast_narrations` (+ the bundle) and `broadcast_illustrations`; reads them for recovery.
- [`../lib/README.md`](../lib/README.md) — the repos (`broadcasts` / `tts-voices` / `radio-sources` / `users`), the view builders, the storage abstraction (where the bytes go).
- [root `CLAUDE.md` § Migration discipline](../../../../../CLAUDE.md), [`.claude/skills/migrations/SKILL.md`](../../../../../.claude/skills/migrations/SKILL.md).
- [`packages/README.md`](../../../../../packages/README.md) — `@blackout/auth`'s schema (the user/session/account tables in this same database).
