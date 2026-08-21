// K6.2 prompts-as-content — v1.0.0 active spec content for the
// `sporting_event` profile. Prose elaboration lives in the sibling
// `.md` files (editable as content); the structural mode blurbs live
// here because they are short, typed JSON. The section-by-section
// assembler interleaves these strings with the profile-agnostic
// baselines in `src/narrative/*.baseline.md` under matching
// `## Section` headers.

import { readFileSync } from "node:fs";
import type {
  GenerationSpecContent,
  ImagerySpecContent,
  SummarySpecContent,
} from "../../../narrative/spec-types.js";

const readMd = (filename: string): string =>
  readFileSync(new URL(filename, import.meta.url), "utf8").trimEnd();

export const sportingEventGenerationV1: GenerationSpecContent = {
  taskInstructions: readMd("./generation.md"),
  modeBlurbs: {
    action_led:
      "Reportable events are present in the feed this cycle — goals, cards, subs, set-pieces, momentum-changing moments. The passage is built around them; lead with the event or arrive at it as the moment the passage turns. Surrounding context grounds and frames, but the event is the centre of gravity.",
    enrichment_led:
      "No reportable events this cycle, but the feed carries meaningful signal — pressure shifts, momentum, tactical patterns, an emerging thread between two players or two phases of the game. The passage explores what the game is becoming — shape, not event. You are narrating the texture of play and what it implies.",
    context_led:
      "The feed has given you nothing new to report and nothing new to explore. Reach into the world established before kickoff — a character's arc (a manager's history with this fixture, a player's recent form), a statistical thread (an unbeaten run, a head-to-head pattern), a detail of the occasion (the league position at stake, the cup-tie weight), a history between these clubs. Write something true from the context that lives in this present moment, keeping the broadcast's voice. Silence is not an option; depth is the answer when the action gives you nothing.",
  },
};

export const sportingEventImageryV1: ImagerySpecContent = {
  imageryInstructions: readMd("./imagery.md"),
};

export const sportingEventSummaryV1: SummarySpecContent = {
  summaryInstructions: readMd("./summary.md"),
};
