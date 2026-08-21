/**
 * Commentary distillation.
 *
 * Reads a chunk of raw transcription lines and emits three classes of
 * output for the broadcast-runner to route:
 *
 *   - atmosphere:     crowd, manager, ambient mood — non-event observations
 *                     that aren't tied to a specific canonical event.
 *   - event_texture:  build-up, reactions, body language *around* canonical
 *                     events. Carries an optional `eventHint` so the
 *                     correlation buffer can link the texture to the
 *                     Sportmonks event row when it arrives.
 *   - event_claim:    structured signal that commentary noticed a
 *                     canonical event happen. Internal-only — never
 *                     reaches Kairos. Used by `event-correlation.ts` to
 *                     calibrate the radio-stream offset and to release
 *                     buffered event_texture with parentSourceId set.
 *
 * What this distiller deliberately drops:
 *   - Pure opinions: "Chelsea are awful tonight."
 *   - Opinions redundant with structured data: "Brighton are dominating"
 *     (we have pressure data).
 *   - Speculation: "if they don't score soon..."
 *   - Editorial framing of the broadcast as a whole.
 *   - The fact-claim of an event when emitting event_texture
 *     ("GOAL!" / "1-0!"): the Sportmonks row is canonical for that.
 *
 * What it keeps despite sounding like opinion:
 *   - Observations the commentator is reporting from what they directly
 *     saw and that structured data can't capture: defensive positioning,
 *     formation shifts, body language, off-ball movement, manager
 *     actions, crowd reactions. We trust commentary's eyes the way we
 *     trust any sensor; the resulting fact is ours, written first-person.
 *
 * Single Haiku call per chunk. The chunk size is configurable but
 * typically a 30-second buffered window of utterance lines. The runner
 * decides cadence; this module just does the classification.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "./anthropic.js";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 2048;

/** Event classes the distiller can identify in commentary. Mirrors
 * the canonical Sportmonks event types we want to correlate against —
 * extending this list is how we add coverage for new event classes. */
export const EVENT_CLAIM_CLASSES = [
  "KICKOFF",
  "HALFTIME",
  "SECOND_HALF_KICKOFF",
  "FULL_TIME",
  "GOAL",
  "YELLOW_CARD",
  "RED_CARD",
  "SUBSTITUTION",
  "VAR_CHECK",
  "PENALTY_AWARDED",
] as const;

export type EventClaimClass = typeof EVENT_CLAIM_CLASSES[number];

export interface AtmosphereOutput {
  /** Single sentence describing the observed atmosphere or off-ball
   * moment. Written as our own observation, not as citation. */
  content: string;
  /** Original transcription line indices that informed this output —
   * indices into the chunk's `lines` array. Used by the runner for
   * provenance + diagnostics. */
  fromLines: number[];
}

export interface EventTextureOutput {
  /** Single sentence of texture: build-up, reaction, body language
   * around a canonical event. */
  content: string;
  /** Hint about which canonical event this texture is anchored on, so
   * the correlation buffer can link it once Sportmonks emits the
   * matching row. Optional fields populated when commentary made them
   * clear; missing fields are fine. */
  eventHint: {
    eventClass: EventClaimClass;
    player?: string;
    team?: string;
    minuteHint?: string;
  };
  fromLines: number[];
}

export interface EventClaimOutput {
  eventClass: EventClaimClass;
  player?: string;
  team?: string;
  /** Match-time string ("3", "45+1") if commentary made it clear,
   * otherwise omitted — the runner stamps wall-clock timing
   * regardless. */
  subjectTimeHint?: string;
  /** The line index where commentary asserted the claim. The runner
   * uses this to compute a precise commentary-side timestamp via the
   * Deepgram utterance metadata. */
  fromLine: number;
}

export interface DistillationOutput {
  atmosphere: AtmosphereOutput[];
  eventTexture: EventTextureOutput[];
  eventClaim: EventClaimOutput[];
}

export interface DistillationInput {
  /** Transcription utterance lines, oldest first. The distiller treats
   * each entry as one observable unit; `fromLines` references indices
   * into this array. */
  lines: string[];
  /** Recent canonical events the runner has seen, oldest first. Helps
   * the distiller (a) avoid re-extracting an event_texture for an
   * event that already had texture attributed in a prior chunk, and
   * (b) recognise event_claims it might otherwise miss because it
   * knows what's just happened. Each entry is a short summary. */
  recentCanonicalEvents?: string[];
  /** Match-clock anchor at the chunk's mid-point, e.g. "3" or "45+1".
   * The distiller uses it to ground its outputs in the right minute
   * and to populate `subjectTimeHint` / `minuteHint`. Optional for
   * pre-match where there isn't yet a clock. */
  subjectTimeAnchor?: string | null;
  /**
   * Player rosters for the two teams in this fixture. The distiller
   * uses these to snap near-miss transcriptions to canonical names
   * ("Vogel" → "Bogle", "Menzo" → "Enzo") and to drop or de-name
   * mentions that don't correspond to anyone on the pitch. Surfaced
   * during the 2026-04-26 FA Cup SF retro: a fictional Leeds equaliser
   * passage — narrating "Euler Brand finishes cleanly" in a 1-0
   * Chelsea win — was traceable to a transcription mistake the
   * distiller had no canonical reference to correct.
   *
   * Each list is a flat array of full names; the upstream
   * `normaliseTranscript` already runs roster-fuzzy-matching on
   * surnames before we get here, but its tight Levenshtein threshold
   * misses (a) first-name mistranscriptions and (b) garbles further
   * than 1–2 edits from the canonical surname. The LLM closes those
   * gaps with semantic + contextual knowledge.
   *
   * Optional — empty rosters disable the constraint. The pre-match
   * lineup may not be available before kickoff; for those windows the
   * distiller falls back to its prior name-passthrough behaviour.
   */
  homeRoster?: string[];
  awayRoster?: string[];
  /** Display names for the two teams (e.g. "Chelsea", "Leeds United").
   * Helps the distiller bind a roster to a club name when commentary
   * uses one or the other. Optional. */
  homeTeamName?: string;
  awayTeamName?: string;
}

const TOOL = {
  name: "distill_commentary",
  description: "Classify the chunk's lines into atmosphere, event_texture, and event_claim outputs.",
  input_schema: {
    type: "object" as const,
    properties: {
      atmosphere: {
        type: "array" as const,
        description:
          "Residual class for observations that don't fit eventClaim or eventTexture. Crowd, manager, off-ball mood, body language, mid-phase play with no event endpoint. NEVER includes lines that name or imply a goal, shot result, yellow/red card, substitution (on/off/replacing/coming on), VAR check, penalty awarded, or phase whistle — those route to eventClaim and eventTexture per the decision procedure. Each entry is one short sentence written in first-person observation form (\"the crowd lifted as Brighton broke\"), not citation (\"the commentators noted...\").",
        items: {
          type: "object" as const,
          properties: {
            content: { type: "string" as const },
            fromLines: { type: "array" as const, items: { type: "integer" as const } },
          },
          required: ["content", "fromLines"],
          additionalProperties: false,
        },
      },
      eventTexture: {
        type: "array" as const,
        description:
          "Texture around canonical events: build-up sequences, player reactions after a goal/card, defensive positioning at the moment of an event, the keeper's decision, the away end's reaction. ANCHORED on a specific canonical-event-class moment (eventHint). The texture content describes the moment around the event — the run, the touch, the reaction, the body language. The fact-claim itself (\"GOAL!\", \"1-0!\") goes to eventClaim, not into the texture content.",
        items: {
          type: "object" as const,
          properties: {
            content: { type: "string" as const },
            eventHint: {
              type: "object" as const,
              properties: {
                eventClass: { type: "string" as const, enum: [...EVENT_CLAIM_CLASSES] as unknown as string[] },
                player: { type: "string" as const },
                team: { type: "string" as const },
                minuteHint: { type: "string" as const },
              },
              required: ["eventClass"],
              additionalProperties: false,
            },
            fromLines: { type: "array" as const, items: { type: "integer" as const } },
          },
          required: ["content", "eventHint", "fromLines"],
          additionalProperties: false,
        },
      },
      eventClaim: {
        type: "array" as const,
        description:
          "STRUCTURED SIGNAL that commentary asserted a canonical event is happening NOW. Internal-only — drives radio-stream timing calibration and texture-to-event linkage. CRITICAL: only emit when commentary is signalling the moment itself, not when they reference an event that already happened earlier in the match. Claim phrasing (emit): \"he scores\", \"GOAL!\", \"he gets a yellow\", \"X comes on for Y\", \"X is coming on\", \"X takes the pitch\", \"X replaces Y\", \"penalty given\", \"the whistle goes for half-time\". Reference phrasing (do NOT emit a claim — already canonical from the earlier moment): \"his goal earlier\", \"that yellow he picked up\", \"after Anderson's equaliser\", \"the substitute who came on at sixty-one\". For phase whistles (KICKOFF / HALFTIME / SECOND_HALF_KICKOFF / FULL_TIME), use the FIRST line where commentary noticed the whistle. The downstream system correlates against Sportmonks events; partial info is fine (e.g. KICKOFF only needs the class).",
        items: {
          type: "object" as const,
          properties: {
            eventClass: { type: "string" as const, enum: [...EVENT_CLAIM_CLASSES] as unknown as string[] },
            player: { type: "string" as const },
            team: { type: "string" as const },
            subjectTimeHint: { type: "string" as const },
            fromLine: { type: "integer" as const },
          },
          required: ["eventClass", "fromLine"],
          additionalProperties: false,
        },
      },
    },
    required: ["atmosphere", "eventTexture", "eventClaim"],
    additionalProperties: false,
  },
};

const SYSTEM = [
  "# Concept",
  "",
  "You distil live football commentary into three classes of structured output for a narrative engine. The narrator that consumes your output writes literary prose; the canonical event stream (Sportmonks) provides the ground truth of what happened on the pitch. Your job is to extract from commentary what those two sources together cannot: the texture of the moment, the atmosphere, the body language, the build-up, the reactions — what a literary narrator would notice that the structured row can't capture.",
  "",
  "# What to keep",
  "",
  "Observations the commentator is reporting from what they directly saw, that structured event data can't capture:",
  "  - Defensive positioning, formation shifts, off-ball runs, body language",
  "  - The build-up sequence to a canonical event (the run, the touches, the chain)",
  "  - Reactions in the moment after a canonical event (player on knees, manager shaking head, crowd response)",
  "  - Manager actions on the touchline, players communicating, gestures, fouls being signalled",
  "  - Crowd noise, ambient mood shifts, the texture of phases of play",
  "",
  "We trust commentary's eyes the way we'd trust any sensor; the resulting fact is OURS, written first-person observation. Do not write \"the commentary team noted...\", \"according to the booth...\", or any framing that cites the speaker as the source. Render observations as our own.",
  "",
  "# What to drop",
  "",
  "Pure opinions: \"Chelsea are awful tonight.\" Drop.",
  "Opinions redundant with structured data: \"Brighton are dominating.\" The pressure pipeline already measures dominance — drop the editorial. Drop.",
  "Speculation, what-ifs, hypotheticals: \"if they don't score soon...\". Drop.",
  "Editorial framing of the broadcast as a whole: \"the irony of this evening...\", \"this is full-blown crisis mode\". Drop.",
  "Team-level emotional or interpretive reads: \"Chelsea are crumbling\", \"Brighton appear disillusioned and fractured\", \"the side looks broken\", \"they're falling apart\". These are abstractions about a whole team's emotional state. The structured pressure data + event stream already captures the underlying truth (territorial dominance, score, cards, subs), and the narrator will reach a more grounded version of the same conclusion from those signals. Drop.",
  "The announcement of an event itself in eventTexture content: \"GOAL!\", \"1-0!\", \"yellow card!\", \"sub coming on\" go to eventClaim (the structured signal); the surrounding texture goes to eventTexture; never put the announcement line in atmosphere.",
  "",
  "## Individual emotional reads vs team-level reads",
  "",
  "Emotional reads of a SPECIFIC PERSON are signal we don't have any other channel for — the audience can't see Rosenior's face or Caicedo's posture, only the commentator can. Keep these even when phrased as inference. Emotional reads of a WHOLE TEAM are abstractions the structured data already captures; drop those.",
  "  - KEEP: \"Rosenior looks dejected on the touchline\" — specific person, observable signal we have no other channel for.",
  "  - KEEP: \"Caicedo seems frustrated, gesturing at his back four\" — specific person, observable.",
  "  - KEEP: \"Sánchez looks shattered, hands on his head\" — specific person, observable.",
  "  - KEEP: \"Rosenior stands arms folded, jaw set\" — specific person, raw body language is even better.",
  "  - DROP: \"Chelsea look disillusioned and fractured\" — team-level, the data captures this.",
  "  - DROP: \"Brighton are crumbling under sustained pressure\" — team-level, redundant with pressure data.",
  "  - DROP: \"the away end looks defeated\" — borderline; if the commentator describes the specific behaviour (\"the away end is silent and starting to leave\") keep that observable form, otherwise drop.",
  "When the commentary supplies both an emotional read AND the observable behaviour underneath it, prefer the version that includes the behaviour — \"Rosenior shakes his head, arms folded, looks dejected\" beats \"Rosenior looks dejected\" alone.",
  "",
  "When in doubt, prefer the more conservative interpretation. The narrator has the brief and the structured data; we don't need the commentator's framing to fill gaps.",
  "",
  "# Player names — roster discipline",
  "",
  "When the user message includes squad lists for the home and away sides, treat those rosters as the only valid source of player identity for this match. The transcription pipeline upstream produces near-miss garbles when commentators speak quickly, accents are thick, or the audio is noisy. Apply two rules to every player mention you write into output:",
  "  1. **Snap near-misses.** If a transcribed token is phonetically or visually close to a roster name (1–2 letters off, common surname/first-name confusion, missing or extra letter), rewrite it to the canonical roster spelling. Examples from real broadcasts: \"Vogel\" → Bogle; \"Garnett\" → Garnacho; \"Menzo\" → Enzo; \"Adam Wharton\" → Adam Wharton (no change needed).",
  "  2. **Drop or de-name unknowns.** If a name in the transcription doesn't correspond to anyone on either roster — and isn't an obvious common-noun word like \"keeper\" or \"defender\" — either rewrite the observation without naming the player (\"the right-back attacks down the wing\") or drop the line entirely if the observation depends on the identity. Do not pass through unverified names. Inventing or propagating fictional names is the failure mode this rule exists to prevent.",
  "Manager names and other staff named only on the touchline are not in the roster — those mentions are usually fine to pass through as-is, but apply the same near-miss check if you have additional context.",
  "When the user message has no squad lists (pre-match, missing lineup data), treat all player mentions as best-effort: still snap obvious garbles in service of basic spelling, but pass names through rather than drop, since the canonical reference isn't available.",
  "",
  "# Decision procedure",
  "",
  "For every observation in the chunk, walk this cascade in order. Take the FIRST class that fits and stop — never emit the same observation in a later class.",
  "",
  "1. **Is the line asserting a canonical event is happening NOW?** Goals, yellow/red cards, substitutions (player coming on, going off, replacing, swap), VAR checks, penalties awarded, phase whistles (kickoff, halftime, second-half kickoff, fulltime). Claim phrasing — present tense or just-happened: \"he scores\", \"GOAL!\", \"he gets a yellow\", \"X comes on for Y\", \"X is coming on\", \"X takes the pitch\", \"X replaces Y\", \"penalty given\", \"the whistle goes\". → emit `eventClaim`. If surrounding lines describe the moment, also emit `eventTexture` for those.",
  "",
  "2. **Is the line referencing an event that already happened earlier?** \"his goal earlier\", \"that yellow he picked up\", \"after Anderson's equaliser\", \"the substitute who came on at sixty-one\", \"Forest's late equaliser\". These reference a canonical event but they are NOT new claims — the canonical event was already claimed at the moment it happened. Routing rules:",
  "   - If the reference adds texture to the originating event (commentary expanding on a goal that just happened, body language days after a card, etc.) → `eventTexture` with `eventHint` pointing at that originating event.",
  "   - If the reference is just contextual mention woven into present-tense play (\"Forest, who lost their last visit here, push forward\") → `atmosphere`.",
  "   - Either way: do NOT emit a fresh `eventClaim`. Re-claiming an old event pollutes calibration and double-emits the signal.",
  "",
  "3. **Is the line describing build-up or aftermath of a specific canonical event?** The chain that led to a goal, body language right after a card, the run that produced a substitute coming on. → emit `eventTexture` with `eventHint` pointing at the specific canonical event.",
  "",
  "4. **Otherwise — pure ambient observation, off-ball moment, manager on the touchline, crowd mood, mid-phase play with no event endpoint.** → emit `atmosphere`.",
  "",
  "# Atmosphere is a residual class",
  "",
  "Atmosphere is what's left when none of the prior cascade rules apply. It MUST NOT include lines that name or imply a goal, shot result that crossed the goal line, yellow / red card, substitution (player on, player off, replacing, coming on, taken off, swap), phase whistle (kickoff, halftime, second-half, fulltime, extra-time), VAR check, or penalty awarded. Those route to eventClaim and (where the surrounding commentary supports it) eventTexture, per the cascade above.",
  "",
  "Lines like \"X comes on for Y\", \"X is coming on\", \"X takes the pitch\", \"X enters the field\", \"X replaces Y\", \"the substitution is being made\" are all substitution claims — even when commentary signals them before the formal substitution completes. Atmosphere about a player carrying the ball, defending mid-phase, or talking to the referee is fine; atmosphere announcing a substitution is not.",
  "",
  "# Output classes",
  "",
  "## eventClaim",
  "",
  "Internal structured signal that commentary asserted a canonical event is happening NOW. Used by the broadcast-runner to calibrate radio-stream timing against Sportmonks's event arrivals — every match contributes samples (kickoff / halftime / second-half / fulltime guaranteed; goals / cards / subs as they happen). Provide as much identifying detail as commentary made clear (player, team, minute), but partial info is fine. Pick the FIRST line where commentary signalled the event, not where they elaborated. Do NOT emit when commentary is referring back to an event that already happened (per the cascade's rule 2).",
  "",
  "## eventTexture",
  "",
  "Texture ANCHORED on a canonical-event moment: build-up, reactions, body language at goals / cards / subs / VAR / phase whistles. Each entry must declare which event-class moment it's anchored on via `eventHint`. The downstream system uses this hint to link the texture to the Sportmonks event row when it arrives. Texture content describes the moment around the event — keep the run, the touch, the reaction, the body language. The fact-claim itself goes to eventClaim, not into the texture content.",
  "",
  "Anchor only when the canonical-event moment is unambiguous. The eventHint is a commitment, not a guess: a wrong hint links texture to the wrong canonical event downstream and produces a structurally misleading moment for the narrator. If you have an event-announcing line but no surrounding texture worth anchoring, emit eventClaim alone — the calibration signal still matters even without rich texture. \"Build-up\" only counts as eventTexture if there's a canonical event the build-up actually led to. Mid-phase action with no event endpoint goes to atmosphere.",
  "",
  "## atmosphere",
  "",
  "Crowd, manager, ambient mood, off-ball moments, mid-phase play with no event endpoint. One short sentence each, first-person observation. Cite the line indices that informed each entry in `fromLines`. NEVER includes lines that fall under the cascade's first three rules — see \"Atmosphere is a residual class\" above.",
  "",
  "# Output discipline",
  "",
  "Always call the `distill_commentary` tool. Empty arrays are valid for any class — chunks of pure filler are normal in pre-match and quiet phases.",
].join("\n");

function getClient(): Anthropic {
  return getAnthropicClient("distillation");
}

/** Exported for testing. Produces the user-message payload Haiku
 * receives — the runtime call passes the result directly to the
 * Anthropic SDK's `messages.create`. */
export function buildUserMessage(input: DistillationInput): string {
  const parts: string[] = [];

  if (input.subjectTimeAnchor) {
    parts.push(`## Match-clock anchor`);
    parts.push(`This chunk sits around match minute ${input.subjectTimeAnchor}.`);
    parts.push("");
  }

  const homeRoster = input.homeRoster ?? [];
  const awayRoster = input.awayRoster ?? [];
  if (homeRoster.length > 0 || awayRoster.length > 0) {
    parts.push("## Squad lists for this fixture");
    parts.push(
      "Use these rosters to correct near-miss transcriptions of player names back to their canonical spelling, and to drop or de-name any mention whose name doesn't correspond to a real squad member. Treat these as the only valid sources of player identity for this match.",
    );
    if (homeRoster.length > 0) {
      const teamLabel = input.homeTeamName ? `${input.homeTeamName} (home)` : "Home";
      parts.push(`### ${teamLabel}`);
      parts.push(homeRoster.map((n) => `  - ${n}`).join("\n"));
    }
    if (awayRoster.length > 0) {
      const teamLabel = input.awayTeamName ? `${input.awayTeamName} (away)` : "Away";
      parts.push(`### ${teamLabel}`);
      parts.push(awayRoster.map((n) => `  - ${n}`).join("\n"));
    }
    parts.push("");
  }

  if (input.recentCanonicalEvents && input.recentCanonicalEvents.length > 0) {
    parts.push("## Recent canonical events");
    for (const e of input.recentCanonicalEvents) {
      parts.push(`  - ${e}`);
    }
    parts.push("");
  }

  parts.push("## Commentary lines (fromLine indices)");
  if (input.lines.length === 0) {
    parts.push("(empty chunk)");
  } else {
    for (let i = 0; i < input.lines.length; i++) {
      parts.push(`  [${i}] ${input.lines[i]}`);
    }
  }

  return parts.join("\n");
}

export async function distillCommentary(
  input: DistillationInput,
): Promise<DistillationOutput> {
  if (input.lines.length === 0) {
    return { atmosphere: [], eventTexture: [], eventClaim: [] };
  }

  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserMessage(input) }],
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUse) {
    console.warn("[distiller] no tool call in response — returning empty distillation");
    return { atmosphere: [], eventTexture: [], eventClaim: [] };
  }

  return parseToolInput(toolUse.input);
}

function parseToolInput(raw: unknown): DistillationOutput {
  const empty: DistillationOutput = { atmosphere: [], eventTexture: [], eventClaim: [] };
  if (!raw || typeof raw !== "object") return empty;
  const o = raw as Record<string, unknown>;

  return {
    atmosphere: parseAtmosphere(o.atmosphere),
    eventTexture: parseEventTexture(o.eventTexture),
    eventClaim: parseEventClaim(o.eventClaim),
  };
}

function parseAtmosphere(raw: unknown): AtmosphereOutput[] {
  if (!Array.isArray(raw)) return [];
  const out: AtmosphereOutput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.content !== "string" || !o.content.trim()) continue;
    const fromLines = Array.isArray(o.fromLines)
      ? o.fromLines.filter((n): n is number => typeof n === "number")
      : [];
    out.push({ content: o.content.trim(), fromLines });
  }
  return out;
}

function parseEventTexture(raw: unknown): EventTextureOutput[] {
  if (!Array.isArray(raw)) return [];
  const out: EventTextureOutput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.content !== "string" || !o.content.trim()) continue;
    const hintRaw = o.eventHint;
    if (!hintRaw || typeof hintRaw !== "object") continue;
    const h = hintRaw as Record<string, unknown>;
    if (typeof h.eventClass !== "string") continue;
    if (!(EVENT_CLAIM_CLASSES as readonly string[]).includes(h.eventClass)) continue;
    const fromLines = Array.isArray(o.fromLines)
      ? o.fromLines.filter((n): n is number => typeof n === "number")
      : [];
    const hint: EventTextureOutput["eventHint"] = {
      eventClass: h.eventClass as EventClaimClass,
    };
    if (typeof h.player === "string" && h.player.trim()) hint.player = h.player.trim();
    if (typeof h.team === "string" && h.team.trim()) hint.team = h.team.trim();
    if (typeof h.minuteHint === "string" && h.minuteHint.trim()) hint.minuteHint = h.minuteHint.trim();
    out.push({ content: o.content.trim(), eventHint: hint, fromLines });
  }
  return out;
}

function parseEventClaim(raw: unknown): EventClaimOutput[] {
  if (!Array.isArray(raw)) return [];
  const out: EventClaimOutput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.eventClass !== "string") continue;
    if (!(EVENT_CLAIM_CLASSES as readonly string[]).includes(o.eventClass)) continue;
    if (typeof o.fromLine !== "number") continue;
    const claim: EventClaimOutput = {
      eventClass: o.eventClass as EventClaimClass,
      fromLine: o.fromLine,
    };
    if (typeof o.player === "string" && o.player.trim()) claim.player = o.player.trim();
    if (typeof o.team === "string" && o.team.trim()) claim.team = o.team.trim();
    if (typeof o.subjectTimeHint === "string" && o.subjectTimeHint.trim()) {
      claim.subjectTimeHint = o.subjectTimeHint.trim();
    }
    out.push(claim);
  }
  return out;
}
