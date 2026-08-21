import "../env.js";
import { db, sql } from "./client.js";
import { eventProfiles, serviceSpecs } from "./schema.js";
import {
  sportingEventGenerationV1,
  sportingEventImageryV1,
  sportingEventSummaryV1,
} from "./seed-data/sporting-event/index.js";
import {
  sportingEventMomentumV1,
  sportingEventTensionConflictV1,
  sportingEventThemesV1,
  sportingEventCharacterArcsV1,
  sportingEventCharacterRelationshipsV1,
  sportingEventPatternsEchoesV1,
} from "./seed-data/sporting-event/enrichment/index.js";
import {
  sportingEventNarrativeArcV1,
  sportingEventPriorityV1,
  sportingEventNarrativeGapV1,
  sportingEventBroadcastSummaryV1,
  sportingEventSaturationResolverV1,
  sportingEventContextCuratorV1,
  sportingEventConflictResolverV1,
} from "./seed-data/sporting-event/curation/index.js";

const enrichmentServiceNames = [
  "momentum",
  "tension_conflict",
  "patterns_echoes",
  "themes",
  "character_arcs",
  "character_relationships",
];

// Curation tiers. Within a tier, services run concurrently (they don't
// read each other's writes). Between tiers, the previous tier's outputs
// are merged into the context the next tier sees.
//
// Tier 1 — independent: each only reads from the initial cycle context.
//   narrative_arc       — judges the dramatic phase from elapsed time + annotations.
//   narrative_gap       — flags subjects whose parent service has gone quiet.
//   saturation_resolver — flags annotations restating the recent window.
//   context_curator     — manages brief-fragment recency; suppresses stale echoes
//                         from patterns_echoes and surfaces fresh threads for
//                         context-led passages. Replaces the older
//                         context_resonance_resolver.
//
// Tier 2 — read tier 1 outputs: arcPhase, urgentSubjects.
//   priority — selects emphasis + removal entries.
//   pacing   — recommends word count + cadence.
//
// Tier 3 — reads priority's emphasis decision.
//   conflict_resolver — resolves the merged conflict set against priority.
//
// Tier 4 — synthesises everything.
//   broadcast_summary.
const curationServiceTiers: string[][] = [
  ["narrative_arc", "narrative_gap", "saturation_resolver", "context_curator"],
  ["priority", "pacing"],
  ["conflict_resolver"],
  ["broadcast_summary"],
];

// Flattened list — used to upsert service_specs rows below.
const curationServiceNames = curationServiceTiers.flat();

async function seed() {
  // Upsert so re-seeding picks up additions to the service lists
  // (e.g. saturation_resolver added in the repetition-fix round).
  await db
    .insert(eventProfiles)
    .values({
      name: "sporting_event",
      description: "Live sporting event — football matches, etc.",
      enrichmentServices: enrichmentServiceNames,
      curationServiceTiers,
    })
    .onConflictDoUpdate({
      target: eventProfiles.name,
      set: {
        enrichmentServices: enrichmentServiceNames,
        curationServiceTiers,
      },
    });

  for (const serviceName of enrichmentServiceNames) {
    await db.insert(serviceSpecs).values({
      serviceName,
      serviceType: "enrichment",
      eventProfileName: "sporting_event",
      version: "0.1.0",
      status: "experimental",
      spec: { placeholder: true },
      notes: "Placeholder spec — to be replaced with real domain knowledge.",
    }).onConflictDoNothing();
  }

  for (const serviceName of curationServiceNames) {
    await db.insert(serviceSpecs).values({
      serviceName,
      serviceType: "curation",
      eventProfileName: "sporting_event",
      version: "0.1.0",
      status: "experimental",
      spec: { placeholder: true },
      notes: "Placeholder spec — to be replaced with real domain knowledge.",
    }).onConflictDoNothing();
  }

  // Narrative-path service specs — v1.0.0 active. All three share the
  // `narrative` stage-type (serviceName distinguishes them — symmetric
  // with enrichment/curation). Profile content (per-domain elaboration on
  // top of the in-code baselines) lives in `./seed-data/sporting-event/*.md`.
  // Re-seeding is a no-op via the unique index on
  // (service_name, event_profile_name, version).
  const narrativeRows = [
    {
      serviceName: "generation",
      serviceType: "narrative" as const,
      spec: sportingEventGenerationV1 as unknown as Record<string, unknown>,
    },
    {
      serviceName: "imagery",
      serviceType: "narrative" as const,
      spec: sportingEventImageryV1 as unknown as Record<string, unknown>,
    },
    {
      serviceName: "summary",
      serviceType: "narrative" as const,
      spec: sportingEventSummaryV1 as unknown as Record<string, unknown>,
    },
  ];
  for (const row of narrativeRows) {
    await db.insert(serviceSpecs).values({
      serviceName: row.serviceName,
      serviceType: row.serviceType,
      eventProfileName: "sporting_event",
      version: "1.0.0",
      status: "active",
      spec: row.spec,
      activatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // Enrichment service specs — v1.0.0 active. Per-service .md files
  // in seed-data/sporting-event/enrichment/ carry the per-domain
  // elaboration; the service-class baselines (in code) carry the
  // structural rules. Re-seeding is a no-op via the unique index on
  // (service_name, event_profile_name, version). K6.5+ completed the
  // sweep — all six enrichment services now have a v1 row; the v0.1.0
  // experimental placeholder rows inserted above stay for the
  // active-vs-experimental precedence ladder.
  const enrichmentRows = [
    {
      serviceName: "momentum",
      spec: sportingEventMomentumV1 as unknown as Record<string, unknown>,
    },
    {
      serviceName: "tension_conflict",
      spec: sportingEventTensionConflictV1 as unknown as Record<string, unknown>,
    },
    {
      serviceName: "themes",
      spec: sportingEventThemesV1 as unknown as Record<string, unknown>,
    },
    {
      serviceName: "character_arcs",
      spec: sportingEventCharacterArcsV1 as unknown as Record<string, unknown>,
    },
    {
      serviceName: "character_relationships",
      spec: sportingEventCharacterRelationshipsV1 as unknown as Record<string, unknown>,
    },
    {
      serviceName: "patterns_echoes",
      spec: sportingEventPatternsEchoesV1 as unknown as Record<string, unknown>,
    },
  ];
  for (const row of enrichmentRows) {
    await db.insert(serviceSpecs).values({
      serviceName: row.serviceName,
      serviceType: "enrichment" as const,
      eventProfileName: "sporting_event",
      version: "1.0.0",
      status: "active",
      spec: row.spec,
      activatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // Curation service specs — v1.0.0 active. Same pattern as
  // enrichment. K6.5+ lifted every LLM-driven curation service; only
  // `pacing` has no row (pure arithmetic, no LLM, no baseline.md, so
  // nothing to split). The v0.1.0 placeholder rows stay for the
  // active-vs-experimental precedence ladder.
  const curationRows = [
    {
      serviceName: "narrative_arc",
      spec: sportingEventNarrativeArcV1 as unknown as Record<string, unknown>,
    },
    {
      serviceName: "priority",
      spec: sportingEventPriorityV1 as unknown as Record<string, unknown>,
    },
    {
      serviceName: "narrative_gap",
      spec: sportingEventNarrativeGapV1 as unknown as Record<string, unknown>,
    },
    {
      serviceName: "broadcast_summary",
      spec: sportingEventBroadcastSummaryV1 as unknown as Record<string, unknown>,
    },
    {
      serviceName: "saturation_resolver",
      spec: sportingEventSaturationResolverV1 as unknown as Record<string, unknown>,
    },
    {
      serviceName: "context_curator",
      spec: sportingEventContextCuratorV1 as unknown as Record<string, unknown>,
    },
    {
      serviceName: "conflict_resolver",
      spec: sportingEventConflictResolverV1 as unknown as Record<string, unknown>,
    },
  ];
  for (const row of curationRows) {
    await db.insert(serviceSpecs).values({
      serviceName: row.serviceName,
      serviceType: "curation" as const,
      eventProfileName: "sporting_event",
      version: "1.0.0",
      status: "active",
      spec: row.spec,
      activatedAt: new Date(),
    }).onConflictDoNothing();
  }

  console.log("[seed] sporting_event profile, placeholder specs, v1 narrative specs, v1 enrichment specs, and v1 curation specs created.");
  await sql.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
