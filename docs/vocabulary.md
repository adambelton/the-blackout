Canonical definitions for the load-bearing terms in this repo. The aim
is that any reader hitting an unfamiliar word in code, comments, or
docs can look here and understand what the codebase means by it.
Terms are grouped by domain rather than alphabetised — concepts
cluster, and the clusters are how the system thinks about itself.

When a term has a single canonical home in code, the pointer follows
the definition in parentheses.

---

## 1 · Product

**The Blackout.** The product. A live AI-generated football narrative
broadcast platform. Members tune in to a shared room; a moderator
transcribes radio commentary; events are detected; the engine
generates literary prose grounded in a writer's brief; that prose is
narrated aloud and accompanied by illustrations — all delivered in
sync to every member at once. Funded by membership, not advertising
(`docs/product-brief.md` Part 1).

**Kairos.** The narrative orchestration engine that powers The
Blackout. Domain-agnostic: knows nothing about football. Lives in this
monorepo at `apps/kairos/server/` as a separate process with its own
database and lifecycle. Talks to its consumer over HTTP/WS. Named
after the Greek concept of "the meaningful moment" — Kairos extracts
meaningful moments from the raw stream of inputs (Chronos)
(`docs/product-brief.md` Part 2).

**Member.** Someone who has joined The Blackout via paid membership.
Members tune into the matchroom for live broadcasts. Not "audience"
or "user" — the membership relationship is structural, not
transactional (root `CLAUDE.md` § *How we treat members*).

**Writer.** A commissioned contributor who authors the editorial
voice and per-broadcast brief. Writers work in the moderator console:
they write a brief before kickoff, drive the broadcast live (typing
moderator notes, monitoring the pipeline), and refine voice through
the content studio. Persisted as a `users.role` value
(`packages/blackout/shared/types/user.ts`).

**Admin.** Blackout staff. Has access to every moderator view plus
the pipeline inspector, radio-source catalogue, TTS voice catalogue,
and user management.

---

## 2 · Apps and the module boundary

**`apps/blackout/server`.** The Blackout's stateful Hono backend. Owns source
capture (Sportmonks events, moderator audio), audio transcription
(Deepgram), TTS, illustrations, the room conductor, and WebSocket
fan-out to every connected client. Runs on `:4000`. Football-aware.

**`apps/kairos/server`.** The Kairos engine. Stateful Hono backend with its
own database. Owns the unified feed, enrichment + curation +
generation pipeline, and the narrative WS. Runs on `:5050`.
Domain-agnostic — no football concepts allowed in this app's source.

**`apps/blackout/client`.** The Next.js frontend. Hosts every user-facing
surface — public discovery, member matchroom, writer/admin moderator
console, content studio, admin tooling. Runs on `:3000`. Talks to
`apps/blackout/server` over HTTP+WS; never to Kairos directly.

**`packages/blackout/shared`.** TypeScript types for the Blackout side —
`apps/blackout/server` + `apps/blackout/client`. Imported as `@blackout/shared`. Kairos
does *not* consume it: the seam between Kairos and the Blackout is
the HTTP/WS wire, not shared TypeScript. A type needed on both sides
is duplicated — Kairos owns it (it's the engine), the Blackout side
mirrors it (`packages/blackout/shared/types/pipeline-cycle.ts` is that
mirror) — never shared via the package.

**Module boundary.** The HTTP/WS seam between `apps/blackout/server` and
`apps/kairos/server` — the *only* coupling between them. Dependency flows
one way: The Blackout imports the typed Kairos client
(`apps/blackout/server/src/lib/kairos.ts`); Kairos doesn't know its consumer
exists, and has no dependency on `@blackout/server` or
`@blackout/shared`. A shape needed on both sides is duplicated, not
shared via a package — Kairos owns it (it's the engine), the Blackout
side mirrors it (`pipeline-cycle.ts`). Blackout devs can edit Kairos
freely — the boundary isn't an IP wall, it's a focus rule. The rule:
Kairos doesn't learn about football and doesn't compile-couple to its
consumer.

**Domain-agnostic.** The discipline imposed on Kairos. No imports
from `@blackout/server` or `@blackout/shared`. No football concepts
in source — no "goal", no "halftime", no "Sportmonks". Kairos sees
`event` /
`moderator` / `narrative_voice` / `narrative_context` source types;
the Blackout side names sources `match_events`, `match_pressure`,
etc., but those names land as strings on Kairos's API and never as
typed identifiers in Kairos's code.

---

## 3 · Product surfaces

**Matchroom.** The member-facing surface. One per broadcast, at
`/matchroom/[broadcastId]`. Renders prose with synced narration,
illustrations, an event ribbon, and a match clock. Reveals are
audio-canonical: nothing visible until the narrator has spoken it.

**Moderator console.** The writer/admin-facing operational surface
for a live broadcast. At `/moderator/[broadcastId]`. Shows the full
feed (unfiltered), service status, calibration samples, audio
controls, and a typed-note input. The moderator is the human in the
loop: they aim a microphone at the radio, type clarifying notes,
choose voices, and watch the pipeline.

**Content studio.** The writer's editorial surface. At `/studio`.
Where briefs are drafted and refined, where voice is iterated, where
post-broadcast retros happen.

**Inspector.** The admin diagnostic surface for a broadcast's
pipeline cycles. At `/inspector/[broadcastId]`. HTTP-polled, not WS —
diagnostics must not depend on the same transport carrying live cues
(transport independence rule, `blackout-server` skill).

**Replay.** The matchroom mode for completed broadcasts. Same URL,
mode flips on `status === "complete"`. Replay walks the persisted
passage list with synthesised playback timing; same reveal contract
as live.

---

## 4 · Broadcast lifecycle

**Broadcast.** One running instance of the product — a link between
The Blackout and Kairos, a source registration, a writer, a brief, a
matchroom, and (eventually) the prose + audio + reveals it produces.
The shared key across the entire system is `broadcastId`
(`packages/blackout/shared/types/broadcast.ts::Broadcast`).

**`broadcastId` vs `kairosBroadcastId`.** The Blackout owns the
`broadcastId` (a UUID on the `broadcasts` table). Kairos owns the
`kairosBroadcastId` (a UUID on its `broadcasts` table). Linking
happens at activation; the Blackout side persists the Kairos id.

**`BroadcastStatus`.** The Blackout-side lifecycle:
`draft → scheduled → live → complete → archived`. The 5 strings live
in `packages/blackout/shared/types/broadcast.ts::BROADCAST_STATUSES`.

**`BroadcastPhase`.** The conductor's runtime phase FSM (orthogonal
to `BroadcastStatus`):
`pre_ramp → warming → live_first_half → halftime → live_second_half
 → full_time_winddown → complete`. Drives what gets pushed to Kairos
and what the matchroom UI shows. `pre_ramp` and `warming` are
operational shoulders; the live phases (`warming`,
`live_first_half`, `live_second_half`) are captured by `LIVE_PHASES`
+ `isLivePhase()`. (`packages/blackout/shared/types/broadcast.ts`).

**Activation.** The flow that flips a broadcast from `scheduled` to
`live`. Implemented in `apps/blackout/server/src/lib/kairos-bridge.ts::
activateBroadcast`: links to Kairos if needed, seeds the
`narrative_voice` + `narrative_context` entries (Kairos rejects
activation without them), flips Kairos to `active`, starts the
conductor, starts the broadcast runner.

**Completion.** The reverse — `BroadcastStatus` flips to `complete`,
runner stops, conductor tears down, Kairos goes complete. Triggered
by the conductor's auto-complete on full-time, or by an admin force.

**Replay mode.** What the matchroom does when `status === "complete"`.
Same component, same reveal contract; different data source (the
archive, not WS cues) and synthesised timing.

---

## 5 · Time

**The Blackout broadcasts a *story* about a football match.** The
factual truth of the real-life match flows IN to Kairos (subject).
The story about that match flows back OUT of Kairos, through the
Blackout server, down to the consumer (content). The Blackout server
is where the transformation happens at the seam: it reads Kairos's
subject-time data and rebrands it as content time on its outbound
shapes.

Three distinct time domains:

**Subject time.** The time of the source material going IN to Kairos.
For a football broadcast: the match minute being commentated on —
`"45+2"`, `"HT"`, `"FT"` are subject-time labels. Inputs to Kairos
carry subject time on every temporal entry. Engine vocabulary; on the
Blackout side this maps to "the match minute."

**Content time.** The time of the produced output coming OUT of
Kairos. A narrative passage's covered window, in subject-time units
(under the correctness contract). Surfaces as `contentTime` on
`NarrativeOutput`, `BroadcastViewEvent.contentTime`,
`CanonicalEvent.contentTime`, the bundle's `contentMinute`. The
consumer's view of what minute the broadcast is at.

**Broadcast time.** The wall-clock of the live event being coordinated
between Blackout + Kairos. The shared system delivery timeline.
Typically ~2 minutes behind subject time (audio-production lag).
Identifiers: `triggeredAt`, `generatedAt`, `playbackStartedAt`,
`kickoffTime`, `effectiveOffsetSeconds`.

**Kairos's job is the conversion.** Turning subject time into content
time is the engine's responsibility, not an emergent property of the
system. The unit of measurement is the **cycle**: every cycle takes a
subject-time window of input entries and produces a content-time
window of output prose. The two windows should match; per-cycle drift
between them is the correctness signal worth instrumenting.

**Where each vocabulary lives — follow the data flow:**

- **Subject vocab** lives *only* where data flows TO Kairos. The
  Kairos engine itself (`apps/kairos/server`), the Sportmonks adapter
  on the Blackout server (`apps/blackout/server/src/sources/`), the
  Kairos client's outbound wire shapes
  (`apps/blackout/server/src/lib/kairos.ts`), and the
  `KairosFeedEntry.data.subjectTime` Kairos persists. The runner's
  internal correlation ledger is also subject-side.
- **Content vocab** lives everywhere data flows FROM Kairos back to
  the consumer. The Blackout server's *outbound* types
  (`BroadcastView`, `BroadcastViewEvent`, `CanonicalEvent`,
  `ModeratorFeedEntry`, `ModeratorNarrative.covers`, the bundle's
  `contentMinute`), the entire Blackout client (matchroom, moderator
  console — never sees subject), the conductor's compose layer.
  Today's `composeContentMinute`, `lastEmittedContentMinute`,
  `currentContentMinute` are content-side.
- **Match vocab** is the Blackout-shared common name when subject
  and content collapse to the same value because the broadcast is
  *about* the match. Used in helpers shared by server + client where
  the directionality isn't meaningful: `parseMatchTime`,
  `compareEventsByMatchTime`, `MatchTimedEvent`, and the
  `packages/blackout/shared/types/match-time.ts` file itself.
- **Broadcast vocab** for the wall-clock system delivery timeline:
  `effectiveOffsetSeconds`, `broadcastTimeForSubjectMinute`,
  `playbackStartedAt`, etc.

**The transformation at the seam.** The Blackout server reads
Kairos's `subjectTime` from incoming feed entries and writes
`contentTime` on its outbound consumer-facing shapes. Look for code
that does both at once — that's the seam:

```ts
// apps/blackout/server/src/ws/moderator-feed-shape.ts (etc.)
const contentTime = typeof d.subjectTime === "string" ? d.subjectTime : undefined;
return { ..., contentTime, ... };
```

**The Blackout client never sees subject.** Subject is engine
vocabulary; the consumer is downstream of Kairos and only consumes
content. Any `subject*` identifier in `apps/blackout/client` is a
regression. (The inspector at `apps/blackout/client/app/inspector/`
is a forward-looking exception — it'll migrate to a Kairos-owned
admin app, where engine vocab is the natural fit.)

**LLM prompt text stays football-domain-flavoured.** The audience
knows it's a football broadcast; literary prose isn't the place for
"subject" or "content" vocabulary.

---

## 6 · Match-side concepts (football-specific)

**Fixture.** A scheduled match. Identified by the Sportmonks
`fixtureId` on a broadcast. Provides: kickoff time, teams, lineup
(when published), and the live event stream.

**`SubjectPhase`.** The
subject-time phase from Sportmonks's periods: `pre_match`,
`first_half`, `halftime`, `second_half`, `full_time`,
`extra_time_first`, `extra_time_halftime`, `extra_time_second`,
`penalties`. Different from `BroadcastPhase` — subject phase is the
pitch-side state of the match; broadcast phase is what the conductor's
FSM thinks. They mostly track each other but the broadcast can be
ahead (warming) or behind (winddown after the fulltime whistle).
See § Time.

**`TeamSide`.** `"home" | "away"`. The canonical type for which side
of the pitch a player or event belongs to. Defined once in
`packages/blackout/shared/types/broadcast.ts::TeamSide` — inline string-union
shadows are an audit failure.

**`MatchEvent`.** A confirmed match event from Sportmonks (goal,
card, sub, VAR). Has a `MatchEventType`, a minute, optional
`extraMinute`, a `team`, and player names. Lives in
`packages/blackout/shared/types/events.ts`.

**Phase whistle.** A synthetic event the conductor emits when
Sportmonks observes a `KICKOFF`, `HALFTIME`, `SECOND_HALF_KICKOFF`,
or `FULL_TIME` transition. Pushed to Kairos as a `match_events`
entry with a `closingPrompt` payload on the FT case (the closing-
passage trigger).

**`subjectTime`.** A string label every temporal entry carries onto
Kairos — *subject time* under § Time. Vocabulary: `"67"` (in-play
minute), `"90+3"` (stoppage), `"pre_match"` (sentinel), `"HT"` /
`"FT"` (phase labels). The Blackout's `parseMatchTime()`
(`packages/blackout/shared/types/match-time.ts`) collapses these to a sortable
number; stoppage forms get a fractional bump so `"45+2"` sorts after
`"45"`. The filename and function use `match` vocabulary because the
helper operates on the value regardless of direction (see § Time naming
convention).

**Phase + phaseSecond.** Two structured fields stamped on every
Blackout-pushed entry. `phase` is the `SubjectPhase` enum value (renames
to `SubjectPhase`); `phaseSecond` is seconds since the phase started.
Both are subject-time fields — see § Time. Together they collapse to
a *subject ordinal* (today's `subjectOrdinal`) that drives Kairos's
cycle batching.

---

## 7 · Feed entries

**Feed.** Kairos's append-only stream of source entries for a
broadcast. The substrate everything downstream feeds on — every
generation reads the feed, every reveal references an entry id from
it.

**Feed entry.** One row in the feed. Has an id, a source, structured
`data` (consumer-defined), a timestamp, a `phase` + `phaseSecond` if
the source supplies them, optional `subjectTime` and other markers.

**Source.** Where a feed entry came from. Each broadcast registers
seven sources at link time, named by the constants in
`@blackout/shared::SOURCE`. Source registration carries a `type`
(`event` / `moderator` / `narrative_voice` / `narrative_context`) and
a `canonical` flag (true means the source's entries are
auto-emphasised by curation and never evicted).

The seven Blackout sources:

- **`match_events`** (canonical event): Sportmonks events. Goals,
 cards, subs, VAR, and phase whistles. The ground-truth backbone.
- **`match_pressure`** (event, non-canonical): pressure / zone
 signals from the PressurePipeline.
- **`match_stats`** (event, non-canonical): raw Sportmonks stats
 feeding the pressure pipeline.
- **`match_action`** (event, non-canonical): distilled commentary —
 atmosphere + event_texture entries from the Haiku distiller. Raw
 transcription never reaches Kairos.
- **`moderator`** (moderator type): free-text notes typed by the
 writer.
- **`narrative_context`**: the writer's brief and the lineup roster.
 Pushed once at activation.
- **`narrative_voice`**: the product's narrator voice description.
 Pushed once at activation.

**Source type vs source name.** The TYPE is one of four enum values
(`event`, `moderator`, `narrative_voice`, `narrative_context`) —
Kairos cares about TYPE for routing rules. The NAME is the consumer-
chosen string identifier for a specific source within a broadcast
(`"match_events"`, `"match_pressure"`, etc.) — Kairos just stores it.

**`canonical`.** A source-level flag set at registration. `canonical:
true` means: every entry from this source is auto-emphasised before
any curation service runs, never evicted by the token-budget pass,
and pulls the cycle to `action_led` mode. Only `match_events` is
canonical on The Blackout.

**`subjectTime` (on entries).** Subject time on the entry — see
§ Time and § Match-side concepts.

**`parentSourceId`.** An optional field on `match_action` event_
texture entries linking them to a canonical Sportmonks event. Lets
the generator render the texture indented under its parent
(parent-child grouping in the prompt).

---

## 8 · Distillation

**Distiller.** Haiku-driven pass that converts a chunk of buffered
Deepgram lines into structured outputs (`apps/blackout/server/src/lib/
distiller.ts`). Runs every ~12 s or reactively before each canonical
event arrives. Output classes are picked per the SYSTEM prompt's
cascade (claim → texture → atmosphere; atmosphere is residual).

**`atmosphere`.** A distillation output class. Crowd / manager /
ambient mood / off-ball moment / mid-phase action with no event
endpoint. Pushed unconditionally to Kairos as `match_action` with
`kind: "atmosphere"`. Must NOT contain event verbs after the 2026-05-
10 cascade prompt.

**`event_texture`.** A distillation output class. Build-up, reaction,
or body language anchored on a specific canonical event. Held in
`pendingTextures` until the canonical arrives, then pushed as
`match_action` with `kind: "event_texture"` and a `parentSourceId`
linking to the canonical. Aged-out textures degrade to plain
atmosphere with no `eventClass` (the unverified-eventClass gate from
2026-04-26).

**`event_claim`.** A distillation output class. Internal-only signal
that commentary asserted a canonical event happened NOW. Held in
`pendingClaims` until a matching canonical arrives. On match, fires a
`latency_sample` calibration cue and is dropped (claims are signals,
not content). Distinct from REFERENCES — claims are present-tense
("he scores", "X comes on for Y"); references are past-tense ("his
goal earlier") and route to atmosphere or texture, not claim.

**Cascade.** The decision procedure the distiller's SYSTEM prompt
embeds, walked top-to-bottom (1) is this an event claim happening
now? → claim+texture; (2) is this a reference to an earlier event? →
no fresh claim, atmosphere or texture only; (3) is this build-up /
aftermath of a specific canonical event? → texture; (4) otherwise →
atmosphere. Atmosphere is residual.

**`EVENT_CLAIM_CLASSES`.** The 10 canonical event classes the
distiller can emit: `KICKOFF`, `HALFTIME`, `SECOND_HALF_KICKOFF`,
`FULL_TIME`, `GOAL`, `YELLOW_CARD`, `RED_CARD`, `SUBSTITUTION`,
`VAR_CHECK`, `PENALTY_AWARDED`. Mirror of the canonical event types
the runner correlates against.

**Pending claim, pending texture.** Held entries waiting for a
matching canonical to arrive. Live in `BroadcastRunner` arrays;
matched / aged-out by the periodic `runCorrelationPrune` sweep
(`apps/blackout/server/src/lib/event-correlation.ts`).

---

## 9 · Pipeline (Kairos)

**Pipeline.** Kairos's three-stage transformation: enrichment →
curation → generation. Triggered by `accumulation` (cadence tick) or
`external` (consumer-requested) cycles. Sequential; each stage reads
the previous stage's output (`apps/kairos/server/src/enrichment/pipeline.ts`).

**Cycle.** One pipeline run. Has a trigger reason, a chunk of feed
entries (the "batch"), and produces — through enrichment + curation +
generation — at most one passage. Persisted as a `pipeline_cycles`
row carrying its annotations and curation decisions for forensic
inspection.

**Trigger reason.** Why a cycle fired: `accumulation` (default 45 s
cadence tick) or `external` (consumer-requested for a phase boundary
or interlude). External cycles drain the entire waiting room and
carry an opaque `consumerPrompt` text (closing-passage prompt,
halftime reflection prompt, etc.).

**Batch / chunk entries.** The set of feed entries the cycle
observed since the previous cycle's trigger. Computed by
`computeBatchEntries` (apps/kairos/server/src/narrative/helpers.ts). The
generator sees curation's subset of this; reveals are scheduled
against the full batch.

**Waiting room.** The pipeline's per-broadcast buffer. Feed entries
land here keyed by subject ordinal (collapsed `phase + phaseSecond`).
At each cadence flush, entries up to `(highest observed - DELAY_s)`
are drained into a cycle. Late arrivals (entries landing after their
window's flush) are discarded with telemetry.

**Drain boundary.** The subject ordinal cutoff for a cycle's chunk.
Entries with an ordinal `≤ drainBoundaryOrdinal` are eligible.
Threaded through the engine so post-boundary entries can't leak into
the prompt as ground truth before they've actually been processed.

**Late arrival.** A feed entry that landed in the waiting room after
its subject-time window's cycle had already flushed. Tracked by
`pipeline.getLateDiscardedCount()` for telemetry.

**Subject ordinal (today's `subjectOrdinal`).** A monotonic integer
derived from `phase + phaseSecond` that orders entries chronologically
across phase boundaries. The cycle-batching key. Defined in
`apps/kairos/server/src/pipeline/subject-time.ts`.

**Closing prompt.** A `closingPrompt` string field carried on the
`FULL_TIME` synthetic match event. The pipeline's closing-pinned
cycle uses it to drive the final passage's framing. Distinct from
the conductor's own `CLOSING_PASSAGE_PROMPT` consumer-prompt — the
existence of two paths is the source of the redundant-trigger bug
identified in the 2026-05-10 broadcast debrief.

---

## 10 · Curation

**Curation.** Pipeline stage 2. Takes the enriched payload + prior
context and decides what to emphasise, what to remove, what mode to
generate in, and how compactly to render the prompt. Runs services
in tiers (`apps/kairos/server/src/curation/curator.ts`).

**Curation service.** A bounded contributor to the cycle's curation
context. Each service owns a single concern. Services run in tiers;
within a tier they run concurrently from the same prior context;
between tiers their writes merge via `mergeTierResults`.

**Tier.** A group of curation services that run concurrently. Tier
order: `[narrative_arc, narrative_gap, saturation_resolver,
context_curator]` → `[priority, pacing]` → `[conflict_resolver]` →
`[broadcast_summary]`. Configured per profile in
`event_profiles.curation_service_tiers`.

**`mergeTierResults`.** Folds tier outputs back into the prior
context: decisions shallow-merge (later overrides earlier on a
service-key collision), conflicts append by delta only,
`forceContextLed` is sticky-once-true, single-writer fields propagate
on reference inequality.

**`CurationMode`.** The pendulum: `action_led`, `enrichment_led`,
`context_led`. Action-led when something canonical is in the chunk
(emphasis exists); context-led when saturation forces a pivot to
brief-anchored material; enrichment-led otherwise. Decided in
`decideMode`.

**Decision.** A curation service's per-cycle output: `serviceName`,
`action` (one-line summary), `entriesEmphasized`, `entriesRemoved`,
optional `meta`. Stored in `CurationContext.decisions`, persisted on
`pipeline_cycles.curation`.

**`canonical_emphasis`.** The curator's baseline decision before any
service runs. Auto-emphasises every entry from a `canonical: true`
source. Renamed from `event_priority` 2026-05-10 to disambiguate from
the LLM-driven priority service.

**`forceContextLed`.** A sticky-once-true flag set by
`saturation_resolver` when every annotation is stale against the
recent window. The cycle pivots from action/enrichment-led to
context-led — the narrator leans on the brief instead of restating
stale signals.

**`relevantThreads`.** Brief-anchored threads `context_curator`
surfaces in `context_led` mode. The narrator gets a ranked list of
"alive right now" threads from the writer's brief to lean on when
the cycle's evidence is thin.

**`reconcileBudget`.** The token-ceiling enforcement pass. Drops
lowest-priority entries until the curated payload fits under
`maxContextTokens`. Canonical entries are never evicted — that's the
audit-flagged invariant the per-pillar test pins.

**Refrain.** The anti-repetition mechanic. The generator gets a
budget status note ("you've used the 'three days from Villa Park'
refrain three times — go fresh") so reused phrasings get
self-policed.

**Saturation.** The state where every annotation has been narrated
recently enough that re-using it would feel stale. The
`saturation_resolver` service triggers `forceContextLed` when this
holds.

---

## 11 · Enrichment

**Enrichment.** Pipeline stage 1. Annotates feed entries in-place
with structured insights: themes, character arcs, momentum,
patterns/echoes from the brief, narrative gaps, story-circle
positioning. Outputs an `EnrichedPayload` to curation. Each
enrichment service runs scoped to its subject; services don't read
each other's writes within a cycle.

**Enrichment service.** Like a curation service but operating on
entries rather than the whole cycle. Each service emits zero or more
`EnrichmentAnnotation`s.

**`EnrichmentAnnotation`.** A per-subject reading produced by an
enrichment service. Has a `serviceName`, a `subjectId`, a structured
`reading`, and metadata. Lives on the entry until curation acts on
it.

**Subject.** What an enrichment annotation is anchored on. Could be
an entry id, a player name, a thread label — any stable identifier
the service is reasoning about.

**`patterns_echoes`.** An enrichment annotation type matching brief
fragments to in-cycle signals. Suppressed by `context_curator` when
the brief fragment was already echoed in the recent window
(prevents the £262m-thread regression).

---

## 12 · Generation

**Generator.** Kairos's Sonnet-driven pass producing the passage's
prose (`apps/kairos/server/src/narrative/generator.ts`). Runs in parallel
with Haiku-driven imagery selection. Produces text + `covers` via the
forced `deliver_narrative` tool call.

**Generation.** One Sonnet call. Persisted as a `generations` row
with `output`, `wordCount`, `tokenUsage`, `covers`, `triggerReason`,
`contextPackage`. The unit of editorial output.

**Passage.** The prose chunk the generator emits. ~80–140 words
typically, narrated as one continuous TTS clip. Identified by
`narrativeId`. Lives in `packages/blackout/shared/types/passage.ts::Passage`.

**Narrative.** Synonymous with passage in older code. The Kairos-
side terminology is "narrative" (e.g. `narrativeId`, `narrative`
WS cue); the matchroom-side terminology since Sub-piece 4 is
"passage" (e.g. `passage_added`, `Passage` shape). Same thing, two
names mid-migration.

**`covers`.** The generator's output channel naming which feed
entries the prose explicitly references and where in the prose. Each
cover has an `entryId`, optional `charOffset` (position in the prose
text), and optional `subjectTime`. Cover entries with a `charOffset`
schedule per-event reveals during audio playback; cover entries
without one fall back to audio-end reveal.

**`charOffset`.** A character index into a passage's prose where a
cover (or phase marker) is anchored. Schedules per-entry UI reveals
mid-audio rather than batch-at-end.

**`includedEntryIds`.** The subset of `batchEntryIds` the curator
surfaced to the generator (after token-budget eviction etc.).
Persisted on `generations.context_package` for forensic inspection.

**`feedHeader`.** The prompt label at the top of the user-message
feed-context section ("Here is the latest context from the live feed"
or "Here are the new source entries since the previous passage" in
delta mode).

**Delta mode.** A generator option that switches the user message
from "rolling window of all recent entries" to "just what's new
since the previous cycle." Used when the running summary is carrying
older context.

**`runningSummary`.** The compact memory the generator carries across
cycles. Two glued blocks: a templated `Canonical state:` section
(deterministic, regenerated every cycle from canonical events) and a
narrative arc block (Haiku-produced motif/tone notes constrained
never to touch state).

**Imagery decision.** The Haiku-produced choice for a passage's
illustration: `pool` (use a pre-existing image), `generate` (call
Replicate with a prompt), or `hold` (keep the previous image). Fired
on the early `imagery_decision` WS cue so Replicate runs in parallel
with Sonnet's narrative.

**Moderator directive.** A moderator-typed entry whose content
surfaces at the top of the generator's user message as live editorial
steering, separate from the chunk feed (`collectModeratorDirectives`
in `apps/kairos/server/src/narrative/generator.ts`). Added 2026-05-10 to
fix the bug where curation could evict steering directives.

**`consumerPrompt`.** Opaque preamble text the consumer (Blackout)
splices into the generator's user message for an external cycle. Used
for halftime reflection and closing passage prompts. Kairos doesn't
interpret it — domain-agnostic by design.

**`closingPassagePending`.** A conductor flag set when full-time has
been observed but the closing passage's roundtrip hasn't landed yet.
Holds auto-complete until the closing passage either lands or the
deadline expires.

---

## 13 · Per-passage canonical bundle (Design A)

**Canonical bundle.** The matchroom contract since 2026-05-04. Every
passage carries `revealedCanonical` (the visible state at audio-
start) and `revealingCanonical` (the deltas this passage will reveal
during its audio). One canonical-state object covering score, phase,
contentMinute, events, illustration, lineup
(`packages/blackout/shared/types/canonical-state.ts`).

**`revealedCanonical`.** The matchroom state snapshot at this
passage's audio-start. Shape: `{ score, events, illustration, phase,
contentMinute, lineup }`. Late joiners read this immediately to render
the room without replaying events.

**`revealingCanonical`.** The deltas this passage will reveal during
its audio. Shape: `{ events?: RevealingMarker<CanonicalEvent>[],
phase?: RevealingMarker<BroadcastPhase>, score?: ... }`. Each marker
has a value and an optional `charOffset`.

**Marker.** A revealing-canonical entry: `{ value, charOffset? }`.
With charOffset → schedule a reveal at `(charOffset / textLength) ×
durationMs` after audio starts. Without → fallback to audio-end.

**Chain invariant.** `revealedCanonical[N+1] === apply(
revealedCanonical[N], revealingCanonical[N])`. The conductor
maintains running canonical state across passages so this holds. Both
the conductor (compose-time) and the matchroom (marker walks) must
produce identical chains for any input.

**`applyRevealingCanonical`.** The pure function that folds a
revealing into a state, dedups events by id, recomputes score from
goals, advances phase only when a marker is set
(`packages/blackout/shared/types/canonical-state.ts:158`).

**`composePassageBundle`.** The conductor-side function that builds
this passage's `revealedCanonical` + `revealingCanonical` from
covers + batchEntryIds + entryCache + last emitted contentMinute
(`apps/blackout/server/src/conductor/canonical-compose.ts`).

**`composeContentMinute`.** The
function inside `composePassageBundle` that picks the content-minute
string from the batch's earliest subject time, clamped against
`lastEmittedContentMinute` (becomes `lastEmittedContentMinute`) so the
matchroom clock can't regress on a late-arriving earlier-phase entry.
See § Time — this is the engine's subject → content conversion on
the bundle path.

**Reveal gate.** The matchroom's "audio is canonical" enforcement
mechanism. An event card stays hidden while a passage whose `covers`
reference its entry is mid-flight; on audio-end, the events fold
into the listener's revealed set. Implemented in
`apps/blackout/server/src/lib/broadcast-view-logic.ts::computeGuardedEntryIds`
on the server side.

**`batchEntryIds`.** The full set of feed entries the cycle
observed. Threaded through the legacy `play` cue. Audio-end reveal
fallback: any batch entry not explicitly anchored by a cover gets
revealed when the audio ends.

**`contentTime`.**
Earliest subject time in the cycle batch (numeric on the legacy path,
monotonic-clamped by Kairos). This is the **content-time anchor for
the cycle's output** — the subject minute the narrator begins from,
which becomes the consumer's content-clock value when audio starts.
The matchroom snapped its clock to this on the legacy path; the
bundle path uses `revealedCanonical.contentMinute` (string with
stoppage preserved) instead.

---

## 14 · Calibration / timing

**Effective offset.** The broadcast↔subject delta — seconds we
subtract from a distillation line's broadcast wall-clock to recover
the subject time the audio is describing. The runtime carrier for
Kairos's subject → content conversion on the input side (every entry
gets stamped with subject time derived this way before reaching
Kairos). Per-broadcast on `BroadcastRunner`, seeded from the radio
source's `defaultOffsetSeconds`, EWMA-updated on every matched
calibration sample
(`apps/blackout/server/src/lib/broadcast-subject-offset.ts`).

**Calibration sample.** Emitted whenever an event_claim matches a
canonical event. Carries `rawDeltaSeconds = canonicalWallClock −
claimObservedAtMs`. Three downstream effects: (1) updates effective
offset via EWMA, (2) writes `radio_sources.lastObservedOffsetSeconds`
for the latency-eval loop, (3) fires a `latency_sample` WS cue for
the moderator console.

**`rawDeltaSeconds`.** A calibration sample's signed delta:
`canonical wall-clock − claim observed wall-clock`. Negative means
canonical arrived first (audio behind canonical → grow offset);
positive means the inverse.

**`OFFSET_EWMA_ALPHA`.** The weight applied to each calibration
sample (0.3 — roughly the most recent 5–7 samples dominate). Lives
in `apps/blackout/server/src/lib/broadcast-subject-offset.ts`.

**Monotonic clamp.** The discipline applied to the emitted content
minute (today's `contentMinute` / `contentTime`) so the consumer's
content clock can't go backwards. Implemented twice: Kairos engine's
`clampMonotonicMinute` on the legacy `play` cue; the conductor's
`composeContentMinute` on the bundle path. Both are required because
both paths emit a separate content minute (the audit's parallel-
emission finding). See § Time.

**`PacingSignal`.** Kairos's three-way pacing feedback:
`slow_down`, `speed_up`, `on_track`. Computed from observed TTS WPM
against the 140–200 wpm narrator-pace target
(`apps/blackout/server/src/lib/kairos-bridge.ts::signalFor`).

**Radio offset.** A static seed value on the `radio_sources` row
(`defaultOffsetSeconds`). The starting point for the dynamic
effective offset; never read again at runtime once activation seeds
the runner's mutable state.

---

## 15 · Conductor and WS

**Room conductor.** The single authoritative orchestrator per live
broadcast. Owns the Kairos feed subscription, the synthesis queue,
the playback scheduler, the illustration coordinator, the
matchroom/moderator WS fan-out (`apps/blackout/server/src/conductor/
RoomConductor.ts`).

**`fanOut`.** The conductor's broadcast method — sends a typed
`ConductorCue` to every subscribed client. Tightened from an
`unknown`-bearing escape hatch to a strict union 2026-05-10.

**`broadcastCue`.** A narrower fan-out for runner-side cues
(currently only `latency_sample`). Distinct from `fanOut` because
the runner doesn't own the WS and shouldn't see the full cue union.

**Cue.** A WS message from server → client. Has a `type`
discriminator and per-type fields. The full union of matchroom-
bound cues is `MatchroomCue` (`packages/blackout/shared/types/passage.ts`);
the moderator console additionally sees `feed_entry`,
`latency_sample`, and the legacy playback cues.

**`MatchroomCue`.** The 8-variant union the matchroom client
consumes: `connected`, `passage_added`, `passage_audio_ready`,
`passage_started`, `passage_skipped`, `passage_updated`,
`broadcast_status_changed`, `generation_skipped`.

**`ConductorCue`.** Server-side superset — every cue `fanOut` may
emit. Includes legacy playback cues (`phase`, `narrative`, `preload`,
`play`, `illustration`) still emitted alongside bundle cues during
the Sub-piece 4 migration; the bundle cues from `MatchroomCue`; and
admin cues (`feed_entry`, `latency_sample`).

**Late joiner.** A client connecting mid-broadcast. Handled by the
`connected` cue carrying `currentPassage` (the bundle for whatever's
mid-flight) — the client renders state immediately and walks
`revealingCanonical` markers from the live audio offset, no event
replay.

**Synthesis queue.** The conductor's serial TTS pipeline. Synthesis
runs strictly sequentially per broadcast — audio order is playback
order, and parallelism risks #2 landing before #1.

**Playback scheduler.** The conductor's `setTimeout` clock. Schedules
each clip's end based on the parsed audio duration; absorbs the
inter-clip gap to prevent client-side audio tail clipping.

**`INTER_CLIP_GAP_MS`.** The 400ms cushion between consecutive
clips. Tight enough to preserve flow, loose enough to absorb
network + decode jitter.

**Subscriber.** A connected WS client (matchroom or moderator). Holds
a transform that filters which cues reach it — matchroom transform
drops admin cues, moderator transform passes nearly everything.

**Matchroom transform.** The whitelist filter for matchroom-bound
cues (`apps/blackout/server/src/ws/matchroom-transform.ts`). Drops admin cues
the audience shouldn't see (`feed_entry`, `latency_sample`,
`service_status`).

**Moderator feed.** The moderator console's view of the feed —
includes everything the matchroom drops, plus the calibration samples
and service-status pings. Shaped by `apps/blackout/server/src/ws/
moderator-feed-shape.ts`.

---

## 16 · Editorial / writer-side

**Brief.** The writer's pre-broadcast preparation. Themes,
characters, tensions, the through-line they want carried. Pushed at
activation as one or more `narrative_context` entries.

**Voice.** The narrator persona's writing style. Product-wide
default loaded from `content/voice.md` and pushed at activation as
a `narrative_voice` entry. (Per-broadcast voice overrides land later
when the writer interface for it exists.)

**Profile.** A row in `event_profiles`. Configures Kairos's
behaviour for a broadcast type — currently `sporting_event`, with
`political_debate` and others as future work. Carries the curation
service tiers, the spec inventory, and (per the prompts-as-content
work) the per-profile prompt content.

**Spec.** A row in `service_specs`. Configures one curation or
enrichment service: its prompt parts, its tool schema, runtime
parameters. Profiles reference specs by name.

**Roster.** Squad lineup for a fixture. Pulled from Sportmonks at
activation if available, appended to the brief as a name registry,
and stashed on the runner so the transcript normaliser can fix ASR
garbles.

**Author brief.** The text of the writer's `narrative_context` entry.
Includes match-time brief plus, when available, the formatted
lineup block.

**Match brief.** A simple fallback brief assembled from the broadcast
row when the writer hasn't written one — `${homeTeam} vs ${awayTeam}.
${competition}. ${date}.` Used when `Broadcast.matchBrief` is empty.

**Content studio.** The writer's editorial surface. Where briefs are
drafted, voice is iterated, and post-broadcast retros happen.

---

## 17 · Code conventions

**`@blackout/shared`.** The Blackout side's TypeScript types package
— `apps/blackout/server` + `apps/blackout/client`. Every shape those two share lives here:
WS cue unions, source name constants, type guards, status enums, the
canonical-state bundle, the consumer-side mirror of Kairos's API
output. `apps/kairos/server` does *not* depend on it — see *Module boundary*
/ *`packages/blackout/shared`*: cross-seam shapes are duplicated, not shared.

**`SOURCE`.** The typed accessor for the seven Kairos source names.
Hoisted to `@blackout/shared::SOURCE` 2026-05-10. Magic-string source
names anywhere in the codebase are an audit failure.

**`isLivePhase()`.** Predicate for the broadcast phases where audio is
in flight. `BROADCAST_PHASES` covers the FSM; `LIVE_PHASES` is the
subset that's actively narrating (warming + live first half + live
second half).

**`STORAGE_KEYS`.** Centralised localStorage keys (`apps/blackout/client/lib/
storage-keys.ts`). One-place edit if any browser-persisted slot is
renamed.

**`assertLiveBroadcastEnv()`.** Boot-time validation that
`DEEPGRAM_API_KEY` and `SPORTMONKS_API_TOKEN` are set. Called at
runner start so a smoke broadcast doesn't silently transition to
`live` and then throw on first utterance.

**`getAnthropicClient(purpose)`.** The single Anthropic client per
app (`apps/blackout/server/src/lib/anthropic.ts`). Replaces three duplicate
caches in distiller / prompt-suggester / tag-deriver. Lazy — apps
without an Anthropic-using path don't fail to boot when the API key
is missing.

**`getStorage()`.** The active storage provider — R2 or InMemory.
Configured development uses the `blackout-dev` R2 bucket. InMemory is
the auth-gated provider for tests and isolated fallback use.

**`requireAuth` / `requireRole`.** Hono middleware for the moderator/
admin auth paths. Internal-script bypass via the
`x-internal-api-secret` header.

---

## 18 · External vendors

**Sportmonks.** Source of canonical match events. HTTP API polling
for live events; lineups fetched at activation.

**Deepgram.** Audio transcription. The moderator's UK-resident
browser captures audio via Web Audio + MediaRecorder and streams
chunks over WS; the server forwards them to Deepgram.

**Anthropic.** LLM provider. Sonnet for narrative generation; Haiku
for distillation, imagery selection, and curation services.

**Replicate.** Image generation. Flux Schnell by default; the
illustration prompt is style-prepended from `content/illustration-
style.md` before submission.

**ElevenLabs / Hume / OpenAI.** TTS providers. Selected per-broadcast
via the `tts_voices` catalogue. ElevenLabs is the current default
(decision-locked in the 2026-05-03 live test).

**Better Auth.** Web-side authentication. User roles
(`writer` / `admin`) stored on the `users.role` column, set
server-side by the `user.create.before` hook.

Email/password access exists for explicitly provisioned local accounts.

**Cloudflare R2.** Object storage for narration audio + illustrations.
Development assets use the `blackout-dev` bucket; tests and isolated
fallbacks can use the in-memory provider.

**Postgres.** Two separate databases — one for `apps/blackout/server`,
one for `apps/kairos/server`. Local development uses Postgres with
Drizzle for schema + migrations.

---

## 19 · Things that aren't what they sound like

**"Moderator" isn't football-specific.** The role exists for any
broadcast type — debates have moderators, courtrooms have judges,
political events have presenters. Kairos's `moderator` source type
captures the abstract role of "person driving the broadcast." Not a
domain leak.

**"Live broadcast" vs "live phase" vs "live status".** Three
overlapping things. `BroadcastStatus === "live"` means "between
activation and completion" — covers warming, halves, halftime, and
winddown. `isLivePhase(phase)` is narrower — only the
warming/first/second-half phases where audio is in flight. "Live
broadcast" colloquially means whichever is contextually relevant.

**"Cycle" vs "passage".** A cycle is one pipeline run; it usually
produces one passage but can produce zero (skipped — empty chunk,
rate limit, etc.). Passages are persisted as `generations` rows;
skipped cycles only persist `pipeline_cycles` rows.

**"Narrative" vs "passage".** Same thing. Kairos uses "narrative"
(legacy); the matchroom side uses "passage" since the bundle
migration. Both names appear in the codebase — same object.

**`canonical: true` (source) vs `revealedCanonical` (bundle).** Two
unrelated uses of the word. Source-level `canonical` is "this
source's entries are auto-emphasised by curation"; bundle-level
`revealedCanonical` is "the matchroom-state snapshot at this
passage's audio-start."

**"Moderator" the source type vs the user role.** The source type is
how Kairos labels entries from the broadcast operator (whoever
they are). The user role is the Better Auth role for someone with
operator access on a specific broadcast. Same conceptual person,
two distinct uses of the word.

**"Content time" (old) vs "content time" (new).** Older comments and
code use "content time" loosely to mean the time of source material —
which the formalised vocabulary (§ Time) now calls *subject time*.
Under the new vocabulary, "content time" specifically means the
produced output's covered window. The code identifier swap that
moves the name `subjectTime` from input entries (where it currently
means subject time) to output narrations (where it will mean content
time) lands in a separate refactor; until it does, the field
`feed_entries.data.subjectTime` still means subject time and
`NarrativeOutput.contentTime` is the content-time anchor.

**"Match" the noun vs "match" the verb.** The fixture is a "match";
the canonical correlator "matches" claims to canonicals. The
ambiguity occasionally bites when reading code — usually the verb
is in `findCanonicalForLateArrival`, `match` as a noun in fixture
metadata.
