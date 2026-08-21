# Product Decisions

A running log of product and architectural decisions for The Blackout (the concept) and Kairos (the domain-agnostic engine that powers it). Each entry records what was decided, what alternatives were considered, and the reasoning. Where a decision has been validated or revised by experience, that's noted.

The Blackout section is the product-level decisions — what the experience is, who it's for, how contributors relate to it. The Kairos section is architectural, kept deliberately free of football concepts; it's where engine-level decisions live so the module boundary stays meaningful.

The trail of reasoning is intentionally preserved so another developer or reviewer can see what was assumed, what alternatives were considered, and what changed after testing. Original decision numbers remain stable because later entries refer back to them; decisions concerned only with the former operating model have been omitted from this public version.

---

## Part 1 — The Blackout

### Foundational Decisions

Made during the initial product shaping conversation (14–15 March 2026) before any code was written.

#### 1. The core concept — an alternative format, not a workaround

**Decision:** Build a platform that offers a genuinely different way to experience the game during the 3pm blackout — not a tool to circumvent the broadcast restriction.

**Context:** The 3pm blackout affects every UK football fan every weekend. The initial exploration considered many concepts: live comic books, tactical data visualisations, crowd sentiment trackers, player character arcs, and AI-rewritten commentary in literary styles. Rather than building a workaround for the missing broadcast, the decision was to create something that stands on its own as a format.

**Why this matters:** This framing shapes everything downstream — the legal posture, the cultural positioning, how it's described to users. It's not "we can't show you the game, so here's a substitute." It's "this is something broadcasting has never offered."

---

#### 2. Lead with the author experience

**Decision:** The first experience mode is a literary narration — a chosen author's voice interpreting the match in real time, delivered as a live audiobook with illustrations.

**Alternatives considered:**
- **Comic book** — strongest visual appeal and shareability. Would be the most immediately legible concept. Deferred, not rejected — it shares the same underlying pipeline and could be added as a second mode.
- **Tactical/statistical visualisation** — high appeal for stat-focused fans but narrow audience and technically demanding (needs reliable live data beyond commentary). Better as an add-on than a lead.
- **Crowd sentiment tracker** — interesting but abstract. Works better as a layer enriching another experience than a standalone thing.
- **Modular configuration** (pick your audio layer, pick your visual layer) — technically elegant but creates an incoherent combinatorial space. A settings panel, not a product.

**Why the author experience:** It's the most distinctive and culturally interesting option. Football has a strong literary culture in the UK, and the concept — a match told through a writer's voice — has a clear identity that's easy to describe. The comic book has broader immediate appeal, but the author mode makes human creative intent fundamental rather than decorative.

---

#### 3. Preset experiences, not modular configuration

**Decision:** Each experience mode is a complete, designed thing with its own identity. Not a framework where users assemble their own combination of audio and visual layers.

**Why:** Presets have stronger product identity ("The Novel" is a thing you can describe in a sentence), they're easier to design for a specific feeling, and they map cleanly onto social rooms. "You join The Hemingway Room for Liverpool vs City" is a much stronger social object than "configure your experience." One dimension of personalisation within a preset (e.g. pick the author style) gives ownership without fragmentation.

---

#### 4. Fixed author per room, announced in advance

**Decision:** The author identity is fixed per match room and announced before the game. Everyone in the room gets the same narration.

**Alternative considered:** User-selectable author per session. Rejected because the shared text is the social object — if everyone is reading different prose, the room loses coherence. The author choice being part of the room's identity ("this week's guest author") makes it an event, not a setting.

---

#### 5. One match per weekend

**Decision:** Feature a single match at a time during the prototype.

**Why:** Focus. The editorial preparation (research briefs, illustration generation, author voice calibration) is significant per match. Doing one well proves more than doing three poorly. Expansion to multiple matches is a scaling decision, not a prototype one.

---

#### 6. Self-contained audio experience — the user doesn't listen to the radio

**Decision:** The platform delivers the entire experience. Users arrive, the room is their window into the game. Narration is read aloud by a TTS narrator voice. There is no radio running alongside it.

**What this changed:** The original assumption was that users would listen to radio commentary while reading AI-generated narrative on screen. The founder clarified the vision: the experience is an audiobook, not a reading companion. This made TTS central to the prototype from day one rather than a nice-to-have.

**Why it matters:** It reframes the latency question — a pause before narration is dramatic tension, not lag. It also means the narrator voice becomes part of the platform's identity, not a utility.

---

#### 7. Club identity and research as the editorial backbone

**Decision:** Each match comes with curated research briefs covering both clubs — identity, mythology, values, key historical moments, rivalry context, player backstories. This material fills the gaps between events with narrative depth.

**The insight:** Football matches have long stretches where not much happens. In a traditional broadcast those gaps are filled with punditry. In The Blackout, those gaps become the most interesting canvas — the author draws on club history, rivalry mythology, and player arcs to produce narrative that carries meaning during the lulls. The event is the hook; the context is the substance.

**Why this is a product decision, not just a feature:** The research is what distinguishes The Blackout from a novelty AI demo. Without it, the narrative is generic prose reacting to events. With it, the AI knows these clubs, this rivalry, these players. The quality of the research directly determines the quality of the experience. This is why the editorial model matters.

---

#### 8. Player arcs and hero/villain dynamics

**Decision:** The AI tracks individual player performance across the 90 minutes and builds narrative arcs. Hero and villain dynamics emerge from club history, rivalry context, and the author's voice.

**Why:** A player facing their former club, a youth academy graduate, a player who signed for money — these carry narrative weight that the AI can surface if given the right context. It adds a character dimension to what could otherwise be event-by-event reporting.

---

#### 9. Illustrations bridge audio gaps — two modes

**Decision:** Illustrations serve two distinct timing roles:
- **Event illustrations** — reactive, dramatic, tied to what just happened (goal, red card, save)
- **Atmospheric illustrations** — contemplative, filling gaps while the next audio passage is generated (a ground at dusk, a manager on the touchline)

This creates a deliberate swing between audio and visual attention: narration plays → illustration holds → narration returns.

**Why:** Without this, the gaps between audio passages feel like dead air. With it, the pacing feels choreographed. The atmospheric illustrations turn latency into a feature.

**Additional decision:** Atmospheric illustrations can be pre-generated during the research phase. This both validates their quality and reduces live generation pressure.

---

#### 10. Illustration style direction — brand-level AI generation

**Decision:** Illustrations are AI-generated via Replicate, with a consistent visual style developed at the brand level rather than per broadcast. The illustration style is part of The Blackout's identity, not a per-match editorial decision.

**Why:** The heart of the concept is the writing — that's where human creative judgment belongs. Illustrations are supplemental: they enhance the experience but do not define it. A consistent, human-directed style gives the work a visual identity, while pregenerated atmospheric images reduce live-generation pressure. Event illustrations can still respond to classified events within that established framework.

**Revised:** The first design treated illustration and writing as parallel authorship surfaces. Live testing made the asymmetry clearer: writing determines meaning, while imagery supports timing and atmosphere. Human visual direction remains important, but per-match illustration authorship was not necessary to test the central idea.

---

### Architecture Decisions

#### 11. Client-side commentary capture by a designated moderator

**Decision:** One moderator runs commentary on their device. Audio is transcribed client-side. Only text events leave the client. No audio ever touches the platform's infrastructure.

**Alternatives considered:**
- Platform ingests the radio stream server-side. Rejected: clearest legal exposure, and architecturally unnecessary.
- Every user captures their own commentary. Rejected: unnecessary complexity; only one transcription source is needed per room.

**Why:** Legally defensive — each moderator is doing what any fan with a radio does. Culturally consistent with how reaction streams work on YouTube and Twitch. The commentary is context; the host's presence and the generated experience are the product. By the time anything from the original broadcast reaches users, it has passed through transcription, event classification, and literary generation — two or three degrees of abstraction.

**Revised in implementation:** See Step 1 retrospective below. Transcription moved server-side via The Blackout's backend (Deepgram), but the moderator still controls when it starts/stops and the audio stream URL. The legal model holds because the moderator provides the stream source, not the platform.

---

#### 12. Commentary as enrichment, events API as primary trigger

**Decision:** Use a football events API for reliable structural event detection (goals, cards, substitutions). Commentary transcription provides atmospheric context — momentum, crowd noise, colour — but is not the primary event source.

**Why:** Data APIs are more reliable for event detection than parsing commentary transcription in real time. Commentary adds texture the data can't provide (the crowd rising, a player limping, a manager's reaction), but trying to detect events from commentary alone is fragile. The hybrid model gives reliability where it matters and richness where it helps.

---

#### 13. Dedicated backend server, not Next.js API routes

**Decision:** The backend is a standalone Node.js/Hono server, not Next.js API routes.

**Why:** The presentation quality depends on a single authoritative process that knows the room's state and issues precise timing cues to all clients simultaneously. The server knows when audio ends, cues illustration fade-ins, schedules crowd audio, and triggers the next passage. This orchestration requires persistent state — what's currently playing, what's queued, where you are in the match timeline. Next.js API routes are stateless and short-lived; they can't maintain a room for 90 minutes.

If every client managed its own state independently, drift and inconsistency between users would be inevitable. The server as conductor is what makes the blended presentation feel choreographed rather than coincidental.

---

#### 14. Ably for real-time delivery — superseded for the broadcast pipeline; open question for chat

**Original decision:** Ably (not Supabase Realtime or Pusher) for broadcasting timing cues and assets to room clients.

**Original considerations:** Supabase Realtime is simpler and already in the stack for database/auth, but it's not purpose-built for high-frequency, low-latency messaging. Ably is a dedicated managed WebSocket service with connection management, reconnection, message history, and presence as first-class features. For a 90-minute match room with real users expecting synchronised experience, Ably's operational reliability was judged worth the additional service.

**Revised in implementation (2026-04-22, restated 2026-04-25):** The broadcast pipeline never shipped on Ably. The room conductor (`apps/blackout/server/src/conductor/RoomConductor.ts`) holds a single Kairos feed subscription per active broadcast and fans cues out over plain WebSocket on `/ws/matchroom` (listeners) and `/ws/moderator` (writer/admin). One audio file per passage, one server-anchored `setTimeout` clock, every connected client follows. This proved sufficient through every live test to date — synchronisation across multiple sessions held without Ably's reconnection / presence machinery.

**Where Ably might still belong — and might not:** Ably was originally scoped for matchroom chat, not for the broadcast itself. Chat was not built. Plain WebSocket may be sufficient because the conductor already maintains a connected-client set per broadcast, making a chat fan-out path comparatively small.

**Why record the revision rather than overwrite:** The reasoning that pointed at a managed real-time service for high-stakes synchronisation was sound on paper. The thing that made it unnecessary in practice was the Kairos-anchored clock + one-audio-file-per-passage shape, which removed the per-client coordination problem Ably was meant to solve. Worth keeping the trace so the same path doesn't get re-walked from a clean memory.

---

#### 15. TTS generated server-side, one audio file distributed to all clients

**Decision:** The server generates one audio file per passage and distributes it to all room clients.

**Why:** API key security (client-side would expose the key), synchronisation (server controls when all clients play), and cost control (one generation per passage, not per client).

---

#### 16. Unified web app — studio lives within the main app

**Decision:** The content studio is a role-gated section within the main Next.js app, not a separate application.

**Why:** The boundary between consumer and contributor should be permeable. A listener who loves the product should be able to take on a creative role for a future broadcast. A unified app makes this natural. Separate apps create an artificial wall between audiences that are, aspirationally, the same community.

---

#### 17. Broadcast as a first-class lifecycle object

**Decision:** A broadcast exists as a persistent object through four phases: `draft → scheduled → live → complete`. The `broadcastId` is the shared key across the entire system.

**Why:** The broadcast isn't just a room — it's a container that content gets attached to in advance (research briefs, illustrations) and generated output gets stored against afterwards. This lifecycle shapes the data model, the studio workflow, and the editorial cadence.

---

### Distribution and product operations

#### 19. Live experience on own platform, highlights distributed on social

**Decision:** The live match experience belongs in its own purpose-built interface. Post-match excerpts can be rendered into portable formats for sharing elsewhere.

**Alternative considered:** Hosting the live broadcast on YouTube with chat. Rejected because: YouTube chat is generic and chaotic (wrong social register for a literary experience), screensharing degrades the reading/listening experience, and YouTube's content ID could flag or take down a stream with live football audio mid-match.

**Why:** The live experience is the thing worth protecting. Social platforms are distribution channels for the output, not a home for the experience. The Saturday blackout slot creates a natural weekly publishing cadence.

---

#### 21. "The Blackout" as working title

**Decision:** Use "The Blackout" as the project name with awareness that it might conflict with existing names.

**Context:** Blackout Sports Limited, a Liverpool-registered company, operates a football product (Blackout Football Manager) and holds the blackout.football domain. There are also potential trademark conflicts with Fremantle Media (TV show) and Blackout Technologies Group Ltd in Classes 9 and 41.

**Recorded follow-up:** Establish whether the name is available without conflict before any future public operation.

---

#### 22. PostHog for product analytics

**Decision:** Instrument the frontend with PostHog Web Analytics and custom events from the start.

**Why:** Observability is foundational — you can't make good product decisions if you can't see what's actually happening. PostHog gives pageviews, session replay, custom event funnels, and retention analysis. EU hosting (eu.i.posthog.com) for UK data residency.

**Custom events planned:** `room_joined`, `audio_played`, `illustration_displayed`, `access_gate_hit`. These are the building blocks for understanding whether the experience works as intended.

**Boundary:** Analytics exists to evaluate whether the experience works. It is not part of the narrative or editorial pipeline.

---

### Editorial Model

#### 23. Writers provide creative authorship; AI is the delivery mechanism

**Decision:** A writer does the match-specific research, provides the voice, and moderates the broadcast. AI takes that writer's voice and research and makes it available live as the match unfolds. The creative work is the writer's; the technology handles responsive delivery.

**What this rules out:** Generic AI content with a human gloss on top. Unnamed prose. Research briefs prepared by the dev team as a stand-in for editorial.

**The local-knowledge angle:** The writer might be an emerging football writer, an established journalist, or someone with deep local knowledge of a matchday team. A lower-division or non-league match researched and moderated by someone who has stood on that terrace for thirty years is something no generic AI pipeline could produce alone. The technology makes that perspective deliverable live, in the writer's own voice, to a shared room.

**Why record this now:** This commitment shapes architectural decisions today. The pipeline is designed so that writer-authored research briefs slot in cleanly and have measurable impact on generation quality. If the AI produces equally generic output regardless of what research is loaded, the editorial model doesn't work and the whole premise fails.

---

### Step Retrospectives

#### Step 1 — Commentary transcription → server

**Original hypothesis:** Client-side Web Speech API would accurately transcribe live radio football commentary and send text chunks to the backend.

**What actually happened:** Web Speech API was never tested because the architecture changed early. Server-side transcription proved to be a better approach — the moderator provides a stream URL and the backend handles capture and transcription independently. This gives higher transcription quality and avoids reliance on the moderator's browser capabilities.

**Key implementation details:**
- Moderator console has an embedded radio player where you paste a stream URL (direct MP3 or HLS)
- Local playback and server-side transcription have independent start/stop controls
- Tested successfully with TalkSPORT (MP3) and BBC Radio 5 Live (HLS)

**What this changes:** The moderator's role shifted slightly — they provide the stream URL and control when transcription runs, rather than having their browser do the transcription. The legal framing still holds (the moderator provides the source, the platform doesn't host or redistribute audio).

---

#### Step 2 — Football events API → server

**Original hypothesis:** A football events API (Sportmonks) would provide both structured match events and real-time text commentary as dual inputs for the narrative pipeline.

**What actually happened:** Tested live against an FA Cup match on 5 April 2026. Three data sources were running simultaneously: Sportmonks structured events, Sportmonks text commentary, and server-side radio transcription.

**Structured events (Sportmonks):** Work as expected. Kickoff was detected immediately from the fixture state. A goal at minute 27 arrived within 30–60 seconds with full detail (event type, player name, team, scoreline). This latency is acceptable — the narrative generation and TTS pipeline will dominate total latency anyway. No events were missed. Event types mapped correctly.

**API commentary (Sportmonks):** Not usable for real-time. Commentary arrived in out-of-order batches (e.g. minutes 9, 11, 8, 9, 8 arriving together) with a growing delay that reached 20+ minutes behind the live match by minute 30. This is consistent across the session — the commentary endpoint is backfilled from a slower editorial pipeline, not streamed live. Research confirmed that the accessible API providers evaluated did not offer real-time text commentary; suitable feeds sat in a different enterprise market.

**Radio transcription:** The standout result. Transcription was consistently ahead of the browser audio playback due to server-side processing with minimal buffering while the browser adds jitter buffering. The goal was captured in the transcript before the tester heard it in the browser. The transcription connection dropped once during the match (no auto-reconnect logic existed); this has been fixed with automatic reconnection.

**Key limitation discovered:** Transcription strips emotional signal. The commentator screaming after a goal produces the same flat text as routine play-by-play. Kairos is designed to address this — it considers the accumulated context of events and transcription together, rather than relying on signal in any single entry.

**What this changes:**
- Sportmonks commentary polling has been removed from the pipeline. The API is used only for structured events.
- Radio transcription is confirmed as the sole real-time atmospheric context source.
- The two sources are complementary: events trigger the pipeline (30–60s latency), radio provides the commentary buffer already full of context around the moment.

---

### Decisions made during development

#### 24. Open moderator dialogue with the AI

**Decision:** The moderator has an open text channel to communicate with the AI during a live broadcast. Their messages are added to a buffer alongside the commentary buffer. When narrative generation fires, it sees both.

**Why:** This is influence, not control. The moderator might prime the AI before an event, steer the narrative toward threads they care about, or add context the transcription missed. Their input shapes the next passage without blocking the current one. If the moderator says nothing, the experience is complete. If they contribute, it's richer.

**Technical implementation:** A text input on the moderator console sends messages via the existing WebSocket connection to the server. Messages are appended to a rolling buffer alongside the commentary buffer and broadcast context. No new pipeline steps required.

---

#### 25. Superseded — author voice model (fictional archetypes then real writers)

**Status:** Superseded by decision 23 (real writers provide the voice and research).

**What was planned:** An earlier version of the plan had a three-stage trajectory — fictional football-culture character archetypes (inspired by figures like Gerrard or Henry but not impersonations) as v1 scaffolding, evolving toward real writers "at scale." The reasoning at the time was that character voices would cover the gap while the writer roster was being built.

**Why the change:** Starting with real writers makes the editorial commitment concrete. Character archetypes would have required scaffolding that the project would later remove and would have blurred the "real writer, their voice, their research" idea the concept is actually testing.

**Kept as history:** This entry is preserved because character archetypes may still have a limited future role as an optional onboarding scaffold for community contributors who have deep knowledge but are not yet confident writing in their own voice. That is a potential future feature, not the v1 default.

---

#### 26. Superseded — character voice model

**Status:** Superseded by decision 23.

**What was planned:** Original fictional character voices inspired by football figures (not impersonations), defined through a character brief prepared during the research phase. The argument was that football-native character voices would be more immediately legible to the community than literary-author styles (Hemingway, McCarthy), and would reduce legal exposure around personality/likeness rights.

**Why superseded:** The editorial model uses the writer's own voice, research, and angle. Character archetypes would sit between the writer and the work and dilute the creative-authorship commitment.

---

#### 27. Latency model — under 60 seconds, ideally around 30

**Decision:** The target latency between a real-world event and the narrator's voice arriving in the room is under 60 seconds, ideally around 30. The broadcast is presented as a contained experience — listeners are aware of the delay and encouraged to turn off the radio and match notifications.

**Why latency is a feature, not a bug:** The delay is where the value is generated. The pipeline needs time to interpret events, weave in commentary context and research, generate prose, and convert to audio. Trying to eliminate latency would mean sacrificing narrative quality. A 30-second pause after a goal, filled by an atmospheric illustration, builds anticipation rather than frustration — especially when the audience has opted into the experience knowing it's not real-time.

**Constraint this places on the moderator model:** The moderator's live contributions should not add latency. This is why the open dialogue model (Decision #24) treats moderator input as context enrichment rather than a blocking step — their notes are folded into the next generation, not gating the current one.

---

#### 28. Sportmonks as football events API provider

**Decision:** Use Sportmonks as the football events API for the prototype.

**Alternatives evaluated:**
- **API-Football Pro** — Cheapest path to PL event data. Good event structure (type, player, assist, minute). All 1,050+ leagues included at every tier. No text commentary endpoint. Largest indie developer community. Eliminated because Sportmonks offers richer data at a reasonable price delta.
- **Football-Data.org** — Free tier lacks event data entirely. Event data priced similarly to Sportmonks Starter for less data and tighter rate limits. Eliminated.
- **AllSportsAPI, Sportradar, Genius Sports, Goalserve** — Push/WebSocket options exist but are enterprise-tier. Not justified for a prototype where 10–15 second polling is sufficient.

**Why Sportmonks:**
- **Richest event data** — granular event types including VAR (goal under review, confirmed, disallowed), running score, related player, pitch coordinates. VAR drama is narratively interesting.
- **Text commentary endpoint** — human-readable event descriptions. Unique among mid-tier providers. *Note: live testing (Step 2 retrospective) revealed this is backfilled, not real-time. Commentary polling was removed from the pipeline.*
- **Generous rate limits** — 2,000 calls/entity/hour on Starter (per entity, not global). No daily cap. More generous than API-Football's 7,500/day global ceiling for live-match polling.
- **Best-in-class documentation** among mid-tier providers.

**Why Starter over Growth:** Growth adds 30 leagues vs Starter's 5. The price increase isn't justified at prototype stage. 5 leagues chosen across time zones provides sufficient coverage for testing, and other parts of the app can be built when no matches are on.

**Upgrade path:** Sportmonks Growth if the league limit becomes a real bottleneck. API-Football remains a fallback — the adapter is built as a thin wrapper so switching providers is trivial.

**Push vs polling:** All viable mid-tier providers are polling-only. This fits the architecture — the server is already the central conductor. Poll every 10–15 seconds, diff against previous state, feed new events into the pipeline.

---

#### 29. Record live test data for replay

**Decision:** Record the full match feed (events, commentary, radio transcription, moderator input) during every live test match. Store these recordings so they can be replayed against the pipeline without needing a live fixture.

**Why:** Live Premier League matches happen at fixed times, and the season ends in May. Without recorded data, development stalls whenever there are no live matches. Recorded feeds also enable reproducible testing — pipeline changes can be compared against the same input rather than relying on different live fixtures each time.

**How to apply:** Build a feed recording/replay mechanism. When testing against a live match, the MatchFeed captures everything chronologically. That recording becomes a reusable test fixture. Over summer (June–August) and during international breaks, development continues against recorded data from earlier test matches.

---

#### 30. League selection for Sportmonks Starter (5 leagues)

**Decision:** Select leagues to maximise coverage across the season and summer, prioritising English radio availability and Sportmonks API commentary coverage.

**Season selection (Aug–May):**
1. **Premier League** (8) — core product league, full API commentary + radio
2. **FA Cup** (24) — major domestic cup, API commentary confirmed, radio available
3. **Championship** (9) — English second tier, API commentary through 2026, radio available
4. **La Liga** (564) — European weekend density, API commentary since 2014, TalkSport covers it
5. **MLS** (779) — English radio native, API commentary confirmed through Aug 2026, runs through summer

**Summer swap (Jun–Aug):** Drop Championship and La Liga (off-season). Add A-League (English radio, events-only — no API commentary) and keep MLS. Recorded test data from the season covers morning development; MLS and A-League provide live validation.

**Why this mix:**
- English radio streams are only reliably available for English-speaking leagues (PL, Championship, FA Cup, MLS, A-League) and TalkSport's La Liga coverage
- API commentary coverage verified against Sportmonks data — all five season leagues confirmed
- MLS is the only league with both API commentary and English radio that runs through summer
- A-League fills the morning BST slot during summer (Australian evening matches = 8–10am UK time)
- Recorded data from the season eliminates the risk of going dark over summer while still allowing live validation

---

#### 31. Audio transcription lives in The Blackout, not Kairos

**Decision:** Deepgram audio transcription — connecting to the stream, managing the connection, producing transcript text — is handled by The Blackout's backend, not by Kairos.

**Why this changed:** The earlier design had transcription in Kairos on the basis that "interpreting signal from audio is Kairos's domain." On reflection, Kairos's domain is narrative meaning — not audio stream management. Connecting to a Deepgram WebSocket, handling reconnections, and streaming audio is infrastructure integration work that has nothing to do with narrative. It is also inherently consumer-specific — a different Kairos consumer might use AssemblyAI, Whisper, or a human typist. Kairos's contract is: accept normalised text entries via REST. The Blackout's contract is: produce those entries from whatever audio source it uses.

**What changes:** `pipeline/transcription.ts` handles Deepgram stream capture server-side. The moderator provides a stream URL. The backend connects to Deepgram and pushes resulting transcript text to Kairos as normalised feed entries. Kairos never sees the audio.

---

#### 32. Pluggable TTS provider with four implementations

**Decision:** TTS is abstracted behind a `TTSProvider` interface. Four implementations are built and maintained: ElevenLabs, OpenAI, Deepgram, and Hume Octave. The active provider is selected per broadcast via configuration.

**Providers and their roles:**
- **ElevenLabs** — production default. Highest narrative quality. Character-level timestamps via the with-timestamps API enable precise audio duration tracking for the Kairos pacing feedback loop.
- **OpenAI TTS** — current primary implementation. Simpler API, reliable, already in use. Remains the default until ElevenLabs is fully wired for production.
- **Deepgram TTS** — cost-efficient testing. Generous pricing makes it practical for high-volume pipeline development and testing where narration quality is not the focus.
- **Hume Octave** — experimental. LLM-driven, emotionally-aware narration that understands the meaning of the text it's speaking. Potentially well-suited to literary content. Worth evaluating against a real broadcast.

**Why abstract early:** Provider swapping via config rather than code change is a minimal investment now and meaningful convenience throughout development. Testing pipeline changes against Deepgram saves cost. Evaluating Hume requires no code change. Moving to ElevenLabs for production requires no code change.

---

#### 33. Kairos pacing feedback uses word count

**Decision:** Kairos reports word count with every generation. The Blackout derives its content consumption rate from its active TTS provider's words-per-minute (calculated from the voice's speed setting) and sends `slow_down`, `speed_up`, or `on_track` signals to Kairos based on the difference between content produced and content consumed.

**Why word count:** Word count is the natural unit for both editorial reasoning and consumer duration calculation. It is format-agnostic — an audio consumer and a text consumer both understand words per minute. The alternative (milliseconds) would require Kairos to understand audio duration, which it has no business knowing.

**ElevenLabs advantage:** ElevenLabs' with-timestamps API returns character-level timing data, allowing The Blackout to calculate actual audio duration from the response rather than estimating from a words-per-minute rate. This gives the most precise pacing feedback of any provider.

---

### Development values

#### 34. Keep development reasoning visible (2026-04-20)

**Decision:** Keep the reasoning behind consequential product and architecture choices visible. Record assumptions, alternatives, evidence, and revisions rather than presenting the final implementation as inevitable.

**What this means in practice:**
- The decisions log is the visible trail of reasoning. Anything affecting the experience gets recorded with the why and the alternatives considered.
- Evidence from live tests can outweigh an earlier assumption.
- A superseded decision stays in the log with an explanation instead of disappearing.
- Implementation detail lives near the code; cross-cutting reasoning lives here.

**Why record this as a decision and not just a tone choice:** Without an explicit record, retrospective explanations tend to make development look cleaner and more certain than it was. Preserving the decision trail makes the learning inspectable.

---

### Open design questions

#### D1. Commentary as colour; structured events as truth (open, noted 2026-04-20)

**Status:** Open question — logged here so we don't lose the framing. Not yet designed or implemented.

**Observation:** The first live end-to-end broadcast (Crystal Palace vs West Ham, 2026-04-20) finished 0-0. The narrative hallucinated a 1-1 scoreline. Root cause: at half-time, the generator referenced a historical H2H stat ("Glasner and Nuno have now met four times in the Premier League, and every single one has finished one-all"), and that phrase leaked into the running summary. Subsequent generations mistook the historical "one-all" for the live scoreline, and the hallucination propagated through to full time.

**Framing the direction of a fix:** Commentary is meant to supply match colour — momentum, atmosphere, crowd reaction, narrative arc hints. It shouldn't be treated as a source of truth for state-of-play facts like score, substitutions, cards, or set pieces. Those come from structured events. Commentary is valuable *and* can carry state-of-play signals, but signals of state from commentary should require corroboration from the structured event feed before the narrator can assert them.

**The design space (not yet explored):**
- A control that tags which kinds of claims (score changes, goal scorers, cards, subs, kickoff / HT / FT) require structured-event backing before the running summary is allowed to encode them.
- A generator-side constraint that prevents "score" facts from being stated unless a matching GOAL event exists in the broadcast's feed.
- A curation-side filter that flags commentary-derived factual claims for corroboration and routes the unverified ones as inferred-only context.

**Why record this now:** The pattern will recur. Commentary-as-colour is a real design property of the system, not a bug; separating fact from colour cleanly is the work.

---

#### D2. Post-match wind-down mode (open, noted 2026-04-20)

**Status:** Open question — logged for design. Not yet implemented.

**Observation:** On the Crystal Palace vs West Ham broadcast (2026-04-20), full-time did not terminate narrative generation. The curator kept firing cycles against a feed whose state no longer materially changed, producing roughly a dozen closing passages that repeatedly re-stated the final whistle. The broadcast operator had to manually mark the broadcast complete to stop the loop.

**Framing the direction of a fix:** The post-match window is narratively distinct from in-play — there are no new events, only reflection on what the match was. The curator should switch into a bounded closing mode when full-time is signalled: a single closing passage covering the match as a whole, then stop, regardless of whether the stream is still open.

**The design space (not yet explored):**
- A full-time signal on the event feed that the curator consumes to enter `wind_down` phase (analogous to the improv-depth cap but triggered by state rather than silence).
- Curator-level cap of one passage post-full-time, after which generation simply halts — the broadcast runtime keeps running (feed subscribers can still read), but the engine chooses to be quiet.
- A distinct system prompt / curation mode for wind-down that biases the generator toward closing / summary / epitaph rather than reacting to further entries.
- Whether "wind-down" is a curator concept (Kairos-side) or a consumer-side orchestration signal (Blackout stops pushing, or flips a flag) is itself the question.

**Why record this now:** Full-time happens on every live broadcast. This needs a deliberate design rather than operator intervention each week.

---

#### D3. Half-time mode (open, noted 2026-04-20)

**Status:** Open question — logged for design. Not yet implemented.

**Observation:** During the 15-minute half-time break on the Crystal Palace vs West Ham broadcast, the enrichment pipeline kept firing against a buffer that was effectively flat — same state, no new events, a near-empty commentary stream — and the curator kept driving generation off increasingly similar readings. Half-time is a break from match action, not a break from the broadcast, and the existing pipeline has no way to tell them apart.

**Framing the direction of a fix:** Half-time is narratively different from in-play. The match isn't happening; what's happening is reflection on the first half, anticipation of the second, and room for the writer's voice to explore broader material (character, rivalry, themes, crowd, match-in-context) that would feel like drag when live action is available. The curator and possibly the generator should switch into a different mode during half-time that draws more heavily on narrative_context and less on the (flat) event feed, and reduces cadence so reflection has room to breathe.

**The design space (not yet explored):**
- Phase-aware generation branching — the curator reads the current phase (`halftime`) and selects a different curation strategy: prefer patterns/themes/character enrichments, deprioritise momentum and tension, allow longer gaps between passages.
- A half-time entry mode where the generator system prompt includes "the match is paused; this is a reflection window" as explicit context.
- Cadence adjustment during halftime — flush interval lengthens, improv depth increases, or the curator gates generation entirely for the first few minutes of HT.
- Whether half-time mode is specified in the `sporting_event` profile (domain-specific, belongs in Kairos platform content) or orchestrated from the Blackout side by withholding pushes (consumer-specific, belongs on the Blackout server) is the first design call.

**Relationship to D1 and D2:** Half-time is where the 1-1 hallucination originated (historical H2H colour leaking into the summary), because commentary fills the silence when events don't. Half-time mode + commentary-as-colour are adjacent problems — fixing one without the other will leave residue of the other behind.

**Why record this now:** Every match has a half-time. Like wind-down, this needs a deliberate design rather than the pipeline pretending in-play rules apply.

---

#### D4. Pre-broadcast illustration pregeneration phase (open, noted 2026-04-25)

**Status:** Open question — logged for design. Not yet implemented. Surfaced during the 2026-04-25 documentation audit when the original decision #38 wording (`pre_ramp` as a phase of the conductor FSM) turned out to conflate two different things.

**Framing:** Three sources of illustration in a broadcast:

1. **Writer-curated pool** — atmospheric / contextual images the writer pregenerates from their match brief during studio prep. Already supported.
2. **Lineup-driven pregeneration** — once Sportmonks publishes confirmed lineups (~1hr before kickoff), Blackout pregenerates a tranche of action illustrations against likely scenarios for the named XIs. Reduces reliance on live generation when the match is most intense. **Not yet implemented.**
3. **Live generation** — Replicate calls fired by the conductor on Kairos's `imagery_decision` cue. Already supported.

The lineup-driven pregeneration runs against the broadcast while it is still `scheduled` — *before* activation, *before* the conductor's `warming` phase. It is a Blackout-side prep window, not a conductor FSM state. Kairos has no role in it (it doesn't know about lineups, scenarios, or illustration assets — those are consumer concerns).

**The design space (not yet explored):**
- What "likely scenarios" means in practice — top scorers from each XI, expected goal-scoring patterns, set-piece takers, defensive shape moments, manager touchline reactions.
- How many images to pregenerate per broadcast and how to bias the prompts so the generated set has visual variety (avoid three near-identical "striker celebrating" frames).
- Where the trigger lives — a cron-like check against scheduled broadcasts as kickoff approaches, vs an explicit studio action vs an automatic step in `activateBroadcast`.
- How the lineup-pregenerated pool interacts with Kairos's `pool` / `generate` / `hold` imagery decision — likely it joins the writer-curated pool as additional eligible items.
- The phase name itself. Worth deciding alongside the design rather than reserving a name in the FSM that may not match the eventual shape.

**Why record this now:** This was implicitly conflated with the conductor's `warming` phase in decision #38. Separating the two stops the conductor FSM accumulating concerns it shouldn't own and gives the pregeneration concept room to be designed on its own terms.

---

### Implementation decisions

#### 36. Broadcasts reference radio_sources by FK, not URL copy (2026-04-20)

**Decision:** `broadcasts.radio_stream_url` (text column) replaced with `broadcasts.radio_source_id` (uuid FK into the `radio_sources` catalogue). The URL is derived from the source at read time; no copy lives on the broadcast row.

**Why:** `radio_sources` is the canonical catalogue. It already carries per-stream offset calibration (`last_observed_offset_seconds`, updated live from latency samples) and the `transcode` flag. Copying the URL onto the broadcast meant catalogue changes wouldn't propagate to broadcasts pointing at that source — offset refinements, URL migrations when BBC reshuffles a stream, transcode toggles. The server-side transcription path was already re-resolving the source by URL on each start so the offset path worked by accident — the FK makes it intentional.

**Tradeoff deliberately taken:** historical broadcasts lose the "what URL was actually used at capture time" record. For the prototype this is fine — the transcription is captured, the audio isn't stored, and reproducibility isn't load-bearing.

---

#### 37. Pre-match research hub for writer brief preparation (2026-04-21, deferred)

**Decision:** The Blackout will provide a research hub in the content studio that surfaces match-relevant facts and historical context to the writer during brief preparation. Sources: Sportmonks-derived data (current form, recent fixtures, head-to-head, lineups, player records, set-piece statistics), generated historical context (notable encounters, recurring themes from prior matchups, individual player narratives), and any other reference material that lowers the writing-from-scratch effort.

**Why:** Anything that turns hours of raw discovery into time spent refining and personalising context improves both the brief and the writer experience. Writers see material they might not have searched for, while retaining judgment over what belongs in the story.

**Discipline:** The hub presents reference material; the writer decides what's relevant for the story they want to tell. The hub does not auto-populate the brief. The writer's editorial judgement on what matters remains the centre of the work — the hub just stops them having to do raw discovery.

**Status:** Deferred. Not in the current build. Recorded now so it doesn't evaporate between now and when the studio surface is being built out for the writer-experience pass (post-prototype).

---

#### 38. Match windows — phase FSM with silence as default (2026-04-22)

**Decision:** The matchroom experience is phase-aware. A per-broadcast finite-state machine transitions through `warming → live_first_half → halftime → live_second_half → full_time_winddown → complete`, driven by Sportmonks state signals (kickoff, halftime whistle, second-half kickoff, full-time). During quiet phases (warming, halftime, full-time winddown) no new source entries are pushed to Kairos and the matchroom shows atmospheric placeholder copy. Halftime and full-time transitions each trigger one explicit generation (first-half reflection, closing passage) before the broadcast falls silent again.

**Revised in implementation (2026-04-25):** An earlier `pre_ramp` phase was named in this decision but never landed in the conductor — what was originally lumped under that label is in fact a Blackout-side *pre-broadcast pregeneration window* (illustration prep against confirmed lineups + likely scenarios), not a state of the live conductor's FSM. It runs before activation, while the broadcast is still `scheduled`. Tracked as design open question D4. The conductor's FSM starts at `warming`.

**Why silence is the default:** During quiet periods Kairos tends to produce either repetitive content (when the pipeline saturates on pre-match chatter) or hallucinated content (when the summary drifts). The 2026-04-21 Brighton 3-0 Chelsea broadcast exposed both failure modes — passage #114 reading "full time, a draw" when the actual score was 3-0, and a 12-passage closing loop after the whistle. Silence as the baseline eliminates the class of bugs that comes from trying to fill empty stretches. Richer downtime experiences are a taste question that needs evidence from writers and listeners.

**Matchroom copy during quiet windows:** atmospheric placeholder register for the prototype (e.g. "Half-time. The stadium lights hold."). Refinement deferred to a writer's take.

---

#### 39. Covers-driven reveal gating — the audio is canonical (2026-04-22)

**Decision:** Nothing in the matchroom UI may reveal information before the narrator has spoken it. Narrative text, events, score, any future UI element (illustrations, stats) — all gated on the narrator's voice having carried them. The matchroom is a broadcast, not a live tracker with audio bolted on.

**How it's implemented:** Kairos emits a `batchEntryIds` array on every narrative payload (the full set of feed entries that fed that generation's context). The matchroom stages incoming events silently. When a narration's audio ends, all entries the narration's batch had in scope become visible at once. Within a narration, words reveal progressively as the audio plays — unrevealed words are absent, not dimmed.

**Why strict:** If listeners can see "Welbeck scores" as a score chip before the narrator says it, the broadcast is broken. The same rule applies in live and archive replay: someone catching up later must still hear events before seeing them.

**Exceptions:** The moderator console is exempt — it's the review surface, needs full pipeline visibility. Post-match outputs that are deliberately non-audio-first (a podcast feed, a published transcript, a video recap) don't need to preserve this contract — they're different surfaces with different expectations.

---

#### 40. Archive replay — same-URL mode switch with admin diagnostic fork (2026-04-22)

**Decision:** When a broadcast completes, its matchroom URL (`/matchroom/[id]`) switches to archive playback mode. Listeners experience the broadcast again with original pacing preserved, silent stretches between narrations stripped, no scrubbing, and a local-storage progress bookmark. The no-spoilers reveal contract applies unchanged in replay.

**Admin variant:** admins viewing the same archive URL get additional controls — full scrubbing, plus a **progressive rollback/rerun** capability. An admin can pick a cycle and re-run generation from that point, or re-run enrichment + curation + generation. The admin rerun **forks into a scratch broadcast** and never mutates the canonical archive. This is a diagnostic tool for investigating odd behaviour ("was this a one-off or a consistent pattern?"), not an editing surface.

**URL pattern rationale:** One URL per broadcast avoids splitting the live and replay identity. When a live broadcast ends, listeners already in the room can start the replay immediately.

**Tri-modal distribution (eventual):**

1. **Replay** — the in-browser matchroom playback. First-class; build first.
2. **Audio-only** — podcast RSS feed + downloadable per-broadcast stitched audio. Secondary; straightforward once replay is live.
3. **Transcript** — hosted externally (Substack is one option). Tertiary; manual export acceptable early, auto-posting later.

Open question under the "timing" heading: whether to support skipping forward or backward between narrations. Worth prototyping rather than deciding a priori.

---

#### 41. Automation-only sharing — no manual editing step (2026-04-22)

**Decision:** Archive distribution (result posts on socials, highlight clips, podcast episode links) must be fully automated. No human-in-the-loop editing workflow for sharing. If a sharing feature requires manual review-and-post, it's out of scope until it can be fully automated.

**Why:** The founder has explicitly declined to take on manual editing as part of the operating cadence. The cost of "something ships that shouldn't" is lower than the cost of "sharing becomes a weekly editorial chore that doesn't get done." Automated sharing accepts some quality variance in exchange for consistency.

**Load-bearing implication for the invariant system:** The invariants we log for diagnostic purposes (`goal_uncovered`, `score_phrase_without_goal`, `phantom_covers`, etc.) eventually become the automated gate that decides whether a broadcast is share-worthy. A broadcast completing with error-severity invariants on key passages should delay or suppress auto-share. The invariant system isn't just observability; it's the quality control layer the sharing automation leans on.

**Status:** No sharing surface is built. Recorded now so the invariant work and the eventual sharing work don't drift apart in design.

---

#### 42. Voice is writer-authored at broadcast level; preset library Blackout-side for writer-less broadcasts (2026-04-22)

**Decision:** Each broadcast's `narrative_voice` is authored by its writer. A writer-less experiment can use a Blackout-side preset rather than leaving voice blank or impersonating a specific person. The preset library is consumer-side editorial content, not Kairos content.

**Why:** Voice is the editorial surface where writer identity lives. Trying to impersonate a specific writer from a domain pack would be both a quality and authorship hazard. Presets support writer-less technical experiments without claiming to be anyone specific.

**Where the presets live:** Blackout. Kairos stays voice-agnostic — it receives whatever `narrative_voice` entry the consumer supplies on activation, regardless of whether that came from a fresh writer authorship, a preset selection, or anywhere else. The seam is clean.

**Implication for domain packs:** Domain packs (see K21) do not ship voice defaults. A domain pack tunes what enrichment looks for, how priority decides, what arc phases mean — it does not prescribe how the narrator sounds. Voice is always the consumer's decision.

**Generalised by the broadcast-template concept:** the Blackout-side voice-preset library is one slice of a reusable **broadcast template** that also carries the `event_profile` choice, source roster, enrichment tags, and `BroadcastConfig` — so "how the Blackout uses Kairos" is configured per mode rather than reassembled for every broadcast. A broadcast combines a template, match brief, writer-authored or preset voice, and live data. Kairos still receives only `event_profile` + `config` + `sources[]`; it does not know the consumer has templates. See [`prompts-as-content-design.md`](prompts-as-content-design.md).

---

## Part 2 — Kairos (the engine)

Kairos stays domain-agnostic. These decisions describe the engine architecture — no football concepts live here.

### Foundational Decisions

#### K1. Kairos as a separable, domain-agnostic product

**Decision:** Keep the narrative orchestration engine separable from The Blackout — its own lifecycle, own Postgres database, own HTTP/WebSocket API, no domain-specific imports. The Blackout is the first consumer, talking to Kairos over the network the same way it talks to Replicate or ElevenLabs.

**Historical note (2026-04-19):** Kairos was originally extracted into its own private repository to keep it strictly separate from The Blackout's then-open-source codebase. When The Blackout went private the separation cost (two repos, context switching, IP-leak vigilance) outweighed the benefit, and Kairos was merged back in as `apps/kairos/server`. The module boundary — not the repo boundary — now carries the separation.

**Strategic rationale:**
- **Kairos is the technical differentiator.** It is the thing that could grow beyond The Blackout and attract investment or partnership interest if The Blackout proves the concept.
- **Kairos is not about football.** It is a general-purpose engine for finding and expressing meaning in live events as they unfold. The Blackout is the first consumer — the proof that the engine works.
- **Separable on demand.** If Kairos ever needs to live in its own repo again (for licensing, multi-consumer scale, or any other reason), the module boundary makes that a `git subtree split`, not a rewrite.

The discipline this imposes: no football concepts in Kairos, no imports from `packages/shared` or `@blackout/server`, no short-circuiting the HTTP/WebSocket seam. Kairos doesn't know about rooms, Sportmonks, moderator consoles, or how the consumer fans cues to its clients. The Blackout's `apps/blackout/server` is the only place those concepts live.

---

#### K2. Three-layer architecture: infrastructure, platform content, user content

**Decision:** Kairos is built on a deliberate separation of three layers with distinct owners, purposes, and rates of change.

- **Infrastructure** — the engine mechanics: batching, enrichment pipeline, curation, generation. Plus the universal narrative service types (momentum, tension & conflict, themes, character arcs, character relationships, patterns & echoes, and all curation services). Changes through feature flags and wide release.
- **Platform content** — event profiles and service specs (enrichment + curation). Owned by Kairos. Versions independently as `experimental → active → archived`.
- **User content** — sources, narrative context, narrative voice. Configured per broadcast by the consumer. No versioning.

**Why this matters:** Infrastructure changes are breaking — they affect every broadcast. Platform content changes are additive and scoped — a new themes spec version doesn't affect momentum. User content changes are per-broadcast and don't affect the engine.

---

#### K3. Universal narrative concepts belong in the architecture

**Decision:** Character arcs, themes, tension, momentum, patterns — these are not event-type-specific concepts. They are fundamental narrative concepts. Every live event worth narrating has them. They are codified in the architecture as universal enrichment and curation service types.

**What belongs where:**
- **Architecture** — the service types themselves: what a character arc is, what momentum means narratively, how tension accumulates
- **Platform content** — how those concepts apply to a specific event type: what a character arc looks like in a football match versus an election night
- **User content** — which specific characters, themes, and tensions matter for this specific broadcast

**Why:** Making Kairos narratively literate at the architecture level — not domain-specific — is the thing that makes it generalisable. The service itself is universal; the spec shapes its application.

---

#### K4. Kairos is a live event storytelling engine — not a general narrative tool

**Decision:** Kairos is purpose-built for live events where meaning unfolds in real time. It is not a story development tool, a writing assistant, or a general-purpose content generator.

**What this rules out:** Story development mode — where a writer prompts Kairos with ideas rather than reacting to live events — was considered and rejected. The engine's founding promise is the collapse of the gap between experiencing something and understanding what it means. That collapse requires a live event. A writer prompting ideas is a different product in a crowded market.

**Why this clarity matters:** The story development use case would dilute the founding promise and pull the architecture in directions that serve it poorly. The live event constraint is a strength, not a limitation. It simplifies versioning (broadcasts are short-lived), justifies the enrichment pipeline (meaning accumulates in real time), and gives Kairos a distinctive identity worth building.

---

#### K5. Event profiles as first-class platform content

**Decision:** Kairos natively understands and explicitly supports different types of live events through event profiles. The first profile is `sporting_event`. Future profiles — `election`, `space_launch` — bring their own domain knowledge without changing the underlying architecture.

**Why profiles rather than pure genericism:** Pure domain-agnosticism would push all domain knowledge into the consumer, which defeats the purpose of Kairos owning broadcast quality. Event profiles let Kairos carry the domain knowledge that makes enrichment and curation intelligent for a given event type, while the infrastructure remains universal.

**Profile versioning:** Profiles are not versioned — they are stable groupings of service types. The content that evolves is the specs, not the profile definition. This applies to the generator-level content too: `TASK_INSTRUCTIONS` / `IMAGERY_INSTRUCTIONS` / the per-mode `formatMode` blurbs become a `generation` spec and an `imagery` spec — new `service_specs` types, versioned `experimental → active → archived` like the enrichment/curation ones — *not* a column on `event_profiles`. The profile stays content-free; it just resolves one `generation` spec and one `imagery` spec. See [`prompts-as-content-design.md`](prompts-as-content-design.md).

---

#### K6. Kairos owns its specs — consumers do not define them

**Decision:** All enrichment service specs and curation service specs are owned and maintained by Kairos. Custom consumer specs are a future consideration, not a current design goal.

**Why:** Kairos is responsible for broadcast quality and must own the tools that safeguard it. A consumer-defined spec would shift quality responsibility to the consumer. The specs are where the domain expertise lives — encoding what constitutes a significant moment in football, how character arcs develop over 90 minutes, when pacing should accelerate. That knowledge belongs in Kairos.

---

#### K7. Spec versioning: experimental → active → archived

**Decision:** Service specs use a lightweight three-state lifecycle: `experimental` (opt-in, not used by default), `active` (used by all new broadcasts), `archived` (superseded, no longer used).

**Why not more complex:** Broadcasts are short-lived. The pinning/maintenance concerns that apply to long-running software subscriptions don't apply here — by the time a spec is promoted to active, any in-progress broadcasts that started on the previous version have concluded. The lifecycle exists mainly to allow trialling new spec content against real broadcasts before it becomes the default.

**Specs are living content:** A themes spec may need updating when the landscape shifts significantly. The experimental → active path lets this content be refreshed and trialled before wide release.

---

#### K8. Broadcast as the core Kairos concept

**Decision:** The core Kairos model for a single live event is a `broadcast`. This replaces earlier terminology (`session`, `narrative`) which was either too generic or implied a longer lifecycle than Kairos manages.

**Why broadcast:** It accurately describes what Kairos produces — a live, time-bounded, authored transmission of a meaningful event. It maps naturally to the consumer's mental model (the consumer creates a broadcast; Kairos narrates it). It implies the short-lived, real-time nature of the experience.

---

### Architecture Decisions

#### K9. Kairos accepts normalised entries only — no raw audio or API connections

**Decision:** Kairos accepts pre-processed, normalised feed entries via its REST API. It does not connect directly to external data APIs, manage authentication with third-party services, or handle raw audio streams.

**Why:** Audio stream management and data API integration are consumer-specific concerns. One consumer might use Deepgram for transcription; another might use AssemblyAI, Whisper, or a human typist. Different consumers may also use entirely different structured-data providers. Kairos should not know or care. Its contract is: accept normalised text entries, build meaning from them, generate prose. Domain-specific normalisation lives in the consumer's codebase where it belongs.

---

#### K10. Word count as the output volume measurement

**Decision:** Kairos reports word count with every generation. This is the unit consumers use to manage pacing feedback.

**Why word count over alternatives:**
- **Character count** — billed by some TTS providers but a poor proxy for duration (one long word ≈ several short words in speaking time)
- **Token count** — useful for LLM cost tracking, meaningless as a time proxy
- **Milliseconds** — would require Kairos to understand audio duration, which it has no business knowing
- **Word count** — natural unit for editorial reasoning, calculable from text, maps cleanly to words-per-minute rate for any output format

**Consumer responsibility:** The consumer configures `target_words_per_minute` from their output format and tracks consumption against that rate. Kairos receives `slow_down`, `speed_up`, or `on_track` signals and adjusts batch cadence and generation length accordingly.

---

#### K11. Services activate implicitly from source enrichment tags

**Decision:** Enrichment services activate based on the tags on a broadcast's event sources, not from an explicit service list in the broadcast config. If a tag appears in any source, the corresponding service activates.

**Why:** An explicit service list would be redundant with the source tags and create a configuration surface where mismatches could occur. Source tags are the canonical definition of which services are needed — the registry derives the active set from them. Simpler, less error-prone, and the right separation of concerns.

---

#### K12. Narrative context and narrative voice as required ambient sources

**Decision:** Every broadcast requires exactly one `narrative_context` source and one `narrative_voice` source. These are not optional. Kairos will not activate a broadcast without them.

**Why required:** A broadcast without narrative context cannot produce meaningful enrichment — the enrichment services have no background from which to surface relevant material. A broadcast without narrative voice cannot produce meaningful generation — the generator has no creative direction. These are not optional enrichments; they are prerequisites for the pipeline to function as intended.

**Why ambient rather than tagged:** Context and voice are not routed to specific services — they are available to all of them. Tagging would require the consumer to correctly tag every service on every broadcast, which is error-prone. Ambient routing is automatic and correct by definition.

---

#### K13. Infrastructure versioned via feature flags, not a formal system

**Decision:** Infrastructure changes — how the pipeline works, how the curator fires, how the generator assembles its prompt — are deployed through standard engineering practice: feature flags during development, then wide release. No formal version management system.

**Why:** Infrastructure changes affect all broadcasts universally. The appropriate mechanism is controlled deployment and testing, not consumer-facing version selection. Exposing infrastructure versions to consumers would imply they can choose which version of the engine to run, which is not a supported concept — Kairos owns broadcast quality and that requires controlling the infrastructure uniformly.

---

#### K14. Three-state per-subject enrichment model (2026-04-20)

**Decision:** Each enrichment service tracks an unbounded set of subjects. Each subject carries three independent states: `expressed` (what the audience has been told — advances on DELIVERED_WITH_EMPHASIS), `unexpressed` (the service's running truth, rebuilt each cycle from the new chunk plus prior state), and `acknowledged` (snapshot at the time of a light surfacing — suppresses repeat annotations when nothing has changed since the last ack).

**Why per-subject rather than per-service:** Character Arcs and Character Relationships fundamentally need multiple subjects — one per actor, one per pair. The previous single-state-per-service model was collapsing them into whatever the LLM picked as "most prominent." Making the pattern universal across all six services keeps the curator's logic uniform (it iterates annotations, not services) and lets each service self-constrain to one subject when the domain calls for it.

**Why the three-state shape:** The gap between what the audience knows and what's currently true is the signal curation cares about. The acknowledged snapshot prevents the service from re-reporting the same reading cycle after cycle when nothing has materially changed but the curator has briefly surfaced it.

**Feedback semantics are per-subject:** A service emitting three annotations in one cycle can receive three different outcomes (emphasised for one, acknowledged for another, ignored for a third). `ConflictResolution.winner` and `loser` are `{ serviceName, subjectId }` pairs.

---

#### K15. Hard-coded domain-agnostic services for v1 (2026-04-20)

**Decision:** For the first implementation, the six enrichment service concepts are hard-coded in the service code — not driven by platform-content specs. The service knows what momentum *is* as a narrative primitive; the LLM interprets what that looks like in the consumer's content.

**Why:** Specs (Phase 5) are a meaningful body of work. Hard-coding the concept framing in code lets the pattern prove itself before we invest in the versioning surface around it. The code stays domain-agnostic — the LLM does the domain interpretation at runtime based on the content it sees.

**Future path:** Phase 5 moves the concept framing out of the service code into versioned spec content, enabling different event profiles to tune the framing per domain. The interface stays identical; only the framing text moves.

---

#### K16. Dedicated enrichment max_tokens separate from utility (2026-04-20)

**Decision:** `ENRICHMENT_MAX_TOKENS = 4096` is separate from the shared `UTILITY_MAX_TOKENS = 512` used for running-summary and classification calls.

**Why:** Multi-subject structured output fills far more tokens than small utility tasks. An enrichment cycle with 10+ subjects each returning a 4-field reading plus basis plus informedBy ids easily exceeds 512. At the old shared ceiling the tool-call JSON truncated mid-stream and the Anthropic SDK returned an empty `input: {}` object — which the parser dropped silently, manifesting as "the LLM chose not to emit" when actually the call was truncated.

**How this was discovered:** A controlled probe (scripts/enrichment-probe.ts) ran character_relationships and two variants of character_arcs against captured Ipswich chunks at 512 and 4096. At 512 every call truncated; at 4096 every variant fired on every chunk. The falsified hypothesis was that comparative fields (trajectory, direction) were the cause — character_arcs with an absolute-worded trajectory variant was indistinguishable from the original. Truncation dominated.

---

#### K17. The brief is a lens, not a gate (2026-04-21)

**Decision:** Narrative context — the writer's brief — informs how live evidence is interpreted. It does not override what live evidence shows. When the brief says "Mavropanos is the story of this match" and the live evidence shows him quiet for an hour, enrichment must not falsely surface him. The brief defines what *could* become meaningful; the action determines what actually *is*.

**Why this matters as a principle:** This is what makes the difference between a platform where great writers enhance the product and one where writers become decoration on top of a system that's doing its own thing. Without this discipline, brief-informed enrichment becomes invention — a writer's thematic preference manufacturing salience the match isn't providing. With it, the brief is a meaning palette the engine composes from when the action calls for it. The first model breaks trust with the audience (the prose stops corresponding to what's happening); the second is the model Kairos is built around.

**How it's enforced:** Per-service materiality tests and saturation control apply identically to brief-informed annotations and action-only annotations. A brief-informed annotation that doesn't pass the materiality bar gets dropped just like any other. The brief shapes the *interpretive vocabulary* enrichment services have access to; it does not excuse them from the materiality discipline that keeps every other reading honest.

**Where the principle bites:** Wherever a service has access to `narrative_context` (under the architecture introduced in the repetition-fix round, that's all six enrichment services and the curation services that use the brief), the prompt must frame the brief as something to draw on *when triggered by evidence*, never as something to surface in the absence of triggering evidence.

---

#### K18. Action and meaning meet at enrichment, not at generation (2026-04-21)

**Decision:** `narrative_context` is visible to all six enrichment services and to the curation services that use it (`BroadcastSummaryService`, `PriorityService`, `NarrativeArcService`). It is no longer surfaced only at the generator. Each service's system prompt includes the full brief as cached standing reference, with concept-aligned guidance on what to extract.

**Why:** Kairos's founding philosophy is the merging of action and meaning — Chronos transformed into Kairos. Enrichment is where action becomes meaning. If context only arrives at generation, then enrichment is operating with action alone — extracting meaning from events with no awareness of the brief that defines what those events could mean. The result is meaning derived from action alone, then dressed in context-flavoured prose at the end. That isn't merging; it's decoration. Honouring the philosophy structurally requires context to be present where meaning is constructed.

**Why the brief stays free-form (no per-service fields):** A schema'd brief with a slot per service would leak Kairos's internal structure into the writer-facing studio, force writers to compartmentalise their thinking against an architecture they shouldn't have to learn, and make adding new services a brief-rewriting event rather than an additive change. Each service is responsible for extracting its own relevant slice from the free-form brief via concept-aligned prompt guidance — the same pattern as how services already interpret the chunk. Writers stay in writer-mode; the boundary between The Blackout and Kairos stays clean.

**Constrained by K17 (lens not gate):** Visibility doesn't mean compulsion. Brief-informed annotations remain subject to the same materiality and saturation discipline as action-only annotations.

---

#### K19. The pendulum of generation modes — silence is not a valid outcome (2026-04-22)

**Decision:** Every cycle generates a passage. The curator decides which of three modes the cycle lives at — **action_led** (reportable events present in the feed), **enrichment_led** (no events but meaningful signal in annotations), **context_led** (nothing fresh from feed or enrichment; the passage reaches into the pre-event brief for depth). Voice, time-grounding and no-invention rules apply across all three; only the material source shifts.

**Why:** "Don't generate this cycle" produced dead air in practice. The Brighton-Chelsea replay (2026-04-22) surfaced the failure mode: after an opening passage, saturation-resolver aggressively held every subsequent cycle, leaving four minutes of silence while the match was still in progress. Treating silence as the answer for "nothing new happened" was a misdiagnosis — what's really wanted is a *different* kind of passage, not the absence of one. The pendulum frames it correctly: the cycle is always generating; the question is only what the passage is about.

**Shape:** `CurationMode = "action_led" | "enrichment_led" | "context_led"`. Resolved by `decideMode()` in the curator after all services run: priority emphasis → action_led; shouldGenerate=false from saturation-resolver → context_led; zero annotations → context_led; otherwise enrichment_led. The generator sees the mode in both the TASK_INSTRUCTIONS (all three modes described) and a per-call preamble telling it which mode this cycle is.

**Validated:** Burnley-Manchester City live test 2026-04-22 — 39 generations / 44 cycles, 0% silence, context_led passages pulled Caicedo's arc and Pawson's refereeing history from the brief during quiet windows.

---

#### K20. Kairos layering — engine, domain pack, event instance, integration (2026-04-22)

**Decision:** Kairos is a four-layer product, not two.

1. **Engine** (Kairos code) — domain-agnostic. Pipeline, pendulum, service interfaces, runtime.
2. **Domain pack** (Kairos content, ships with the product) — expert tuning for a content type. Specs, enrichment heuristics, priority rules, arc-phase definitions, domain-specific prompt discipline.
3. **Event instance** (consumer authors, per event) — `matchBrief` and `narrativeVoice` for one specific broadcast. Not reusable across events.
4. **Integration** (consumer code) — source adapters, presentation, room management. The work of wiring a client to Kairos.

**Why:** The earlier two-layer framing (code + specs) conflated "domain knowledge" with "per-event authoring." They are distinct. Domain knowledge is expertise Kairos ships. Per-event authoring is editorial work the consumer does for each specific event. Separating them lets Kairos make a clean product promise: "we ship football; you author tonight's match."

**Implication:** The separation sets up K21 (domain content packs as Kairos's responsibility) and K22 (generator-level discipline rules that apply across all domains live in engine code, not content packs).

---

#### K21. Kairos ships domain content packs; customers don't tune the engine (2026-04-22)

**Decision:** Each domain Kairos supports ships as an expert-authored content pack inside Kairos — specs, priority heuristics, arc definitions, enrichment tuning, domain-specific prompt rails. A customer picks a pack and gets high-quality narrative out of the box. New domains are Kairos's authoring responsibility, not the customer's.

**Why:** A good product doesn't require customers to do the tuning. Positioning Kairos as "an engine you tune for your domain" makes it a framework, not a product. Positioning it as "Kairos does football well, and next: basketball, election night, theatre, whatever we ship" makes it a product with a clear value proposition per domain. The economics also follow — Kairos can charge for domain expertise once; customers pay for outcomes, not authorship.

**How it lives in the codebase:** Domain packs live in `apps/kairos/server/src/db/seed.ts` (or evolve into a `src/domains/<pack>/` directory as packs grow). Shipped as part of `db:seed`. The `sporting_event` event profile and its service_specs rows are Kairos's football pack. Adding a new domain means adding a new event profile + its seed specs + any prompt content specific to that domain.

**Constraint preserved:** K1 (Kairos as domain-agnostic code) still holds. The *code* imports nothing domain-specific. The pack is content — strings, configuration, seeds — loaded at runtime.

**Current state:** The sporting_event profile exists with placeholder specs. The *football pack content* is scattered across Blackout + Kairos + conversation history. Work item: factor football content into a proper pack.

---

#### K22. The feed is canon; reportable events anchor the passage (2026-04-22)

**Decision:** Two generator-level rules added to TASK_INSTRUCTIONS, phrased domain-agnostically so they live in the engine rather than a domain pack:

1. **The feed is canon; do not invent state-changing events.** Reportable events — anything that changes the state of what is unfolding — may only be narrated when a feed entry in the context explicitly reports them. Oblique framings ("may have scored", "finally broke through", "one goal will be enough") count as claims and are forbidden.
2. **Reportable events anchor the passage.** When one appears in the context, it is the passage's centre of gravity — the thing the prose is built around, not a subordinate clause trailing a rolling observation.

**Why they're engine-level, not domain-pack:** Both rules are about narrative integrity, not football-specific knowledge. "Don't invent events" and "foreground reportable events" apply to election-night narration, theatre narration, cricket narration. They're universal craft rules for live narrative.

**Validated against failures:** Mitoma replay 2026-04-22 — narrator hallucinated a Delap goal from pressure signals and the pre-match brief. Rules added; subsequent replay produced correct Mitoma goal narration with proper foregrounding ("Mitoma. Three minutes in. The flick from Kadıoğlu…") and no fabrication.

**Paired invariant (Blackout-side):** `score_phrase_without_goal` widened to catch oblique goal claims ("goal", "scored", etc.) even when no explicit score phrase appears. Diagnostic-only; the prompt rules are the primary defense, the invariant catches escapes.

---

*This is a living document. Each build step should add an entry before starting (assumption + success criterion) and after completing (what happened + what it changes).*
