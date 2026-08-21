import { eq, and } from "drizzle-orm";
import { db } from "./db/client.js";
import { eventProfiles, serviceSpecs, enrichmentServiceStates } from "./db/schema.js";
import type {
  EnrichmentService,
  ServiceSnapshot,
  ServiceSpec,
  SubjectStateMap,
} from "./enrichment/types.js";
import type { CurationService } from "./curation/types.js";
import type { LLMClient } from "./llm/types.js";
import type {
  GenerationSpecContent,
  ImagerySpecContent,
  SummarySpecContent,
} from "./narrative/spec-types.js";
import { MomentumService } from "./enrichment/services/momentum.js";
import { TensionConflictService } from "./enrichment/services/tension-conflict.js";
import { PatternsEchoesService } from "./enrichment/services/patterns-echoes.js";
import { ThemesService } from "./enrichment/services/themes.js";
import { CharacterArcsService } from "./enrichment/services/character-arcs.js";
import { CharacterRelationshipsService } from "./enrichment/services/character-relationships.js";
import { PriorityService } from "./curation/services/priority.js";
import { ConflictResolver } from "./curation/services/conflict-resolver.js";
import { NarrativeArcService } from "./curation/services/narrative-arc.js";
import { NarrativeGapService } from "./curation/services/narrative-gap.js";
import { PacingService } from "./curation/services/pacing.js";
import { BroadcastSummaryService } from "./curation/services/broadcast-summary.js";
import { SaturationResolver } from "./curation/services/saturation-resolver.js";
import { ContextCurator } from "./curation/services/context-curator.js";

type EnrichmentFactory = (spec: ServiceSpec, llm: LLMClient) => EnrichmentService;

const enrichmentFactories: Record<string, EnrichmentFactory> = {
  momentum: (spec, llm) => new MomentumService(spec, llm),
  tension_conflict: (spec, llm) => new TensionConflictService(spec, llm),
  patterns_echoes: (spec, llm) => new PatternsEchoesService(spec, llm),
  themes: (spec, llm) => new ThemesService(spec, llm),
  character_arcs: (spec, llm) => new CharacterArcsService(spec, llm),
  character_relationships: (spec, llm) => new CharacterRelationshipsService(spec, llm),
};

type CurationFactory = (spec: ServiceSpec, llm: LLMClient) => CurationService;

const curationFactories: Record<string, CurationFactory> = {
  priority: (spec, llm) => new PriorityService(spec, llm),
  conflict_resolver: (spec, llm) => new ConflictResolver(spec, llm),
  narrative_arc: (spec, llm) => new NarrativeArcService(spec, llm),
  narrative_gap: (spec, llm) => new NarrativeGapService(spec, llm),
  pacing: (spec, llm) => new PacingService(spec, llm),
  broadcast_summary: (spec, llm) => new BroadcastSummaryService(spec, llm),
  saturation_resolver: (spec, llm) => new SaturationResolver(spec, llm),
  context_curator: (spec, llm) => new ContextCurator(spec, llm),
};

export class ServiceRegistry {
  private enrichmentServices = new Map<string, EnrichmentService>();
  private curationServices = new Map<string, CurationService>();
  // Tier membership for curation services — parallel groups, sequential
  // between groups. Built from the event profile's
  // `curation_service_tiers` at initialise time. The Curator iterates
  // these in order and runs each tier with `Promise.all`.
  private curationTiers: CurationService[][] = [];
  private broadcastId: string | null = null;

  // Narrative-path spec content resolved at initialise time. The engine
  // reads these to compose its prompts (baseline-in-code +
  // profile-content-from-DB). Null when no spec row exists for the
  // profile — engine falls back to baseline-only assembly. See
  // docs/prompts-as-content-design.md.
  private generationSpec: GenerationSpecContent | null = null;
  private imagerySpec: ImagerySpecContent | null = null;
  private summarySpec: SummarySpecContent | null = null;

  async initialize(broadcastId: string, eventProfileName: string, llm: LLMClient): Promise<void> {
    this.broadcastId = broadcastId;

    const profile = await db.query.eventProfiles.findFirst({
      where: eq(eventProfiles.name, eventProfileName),
    });

    if (!profile) {
      throw new Error(`Event profile "${eventProfileName}" not found`);
    }

    const savedStates = await db
      .select()
      .from(enrichmentServiceStates)
      .where(eq(enrichmentServiceStates.broadcastId, broadcastId));
    const stateByService = new Map(savedStates.map((s) => [s.serviceName, s]));

    for (const serviceName of profile.enrichmentServices as string[]) {
      const spec = await this.resolveSpec(serviceName, eventProfileName);
      if (!spec) { console.log(`[registry] no spec found for ${serviceName} — skipping`); continue; }
      const factory = enrichmentFactories[serviceName];
      if (!factory) { console.log(`[registry] no implementation for ${serviceName} — skipping`); continue; }
      const service = factory(spec, llm);

      const saved = stateByService.get(serviceName);
      if (saved) {
        service.hydrateStates(
          (saved.expressedState ?? {}) as SubjectStateMap,
          (saved.unexpressedState ?? {}) as SubjectStateMap,
          (saved.acknowledgedState ?? {}) as SubjectStateMap,
        );
        console.log(`[registry] loaded ${serviceName} (v${spec.version}, ${spec.status}) — hydrated from DB`);
      } else {
        console.log(`[registry] loaded ${serviceName} (v${spec.version}, ${spec.status})`);
      }

      this.enrichmentServices.set(serviceName, service);
    }

    const tiers = (profile.curationServiceTiers as string[][]) ?? [];
    this.curationTiers = [];
    for (const tier of tiers) {
      const tierServices: CurationService[] = [];
      for (const serviceName of tier) {
        const spec = await this.resolveSpec(serviceName, eventProfileName);
        if (!spec) { console.log(`[registry] no spec found for ${serviceName} — skipping`); continue; }
        const factory = curationFactories[serviceName];
        if (!factory) { console.log(`[registry] no implementation for ${serviceName} — skipping`); continue; }
        const service = factory(spec, llm);
        this.curationServices.set(serviceName, service);
        tierServices.push(service);
        console.log(`[registry] loaded ${serviceName} (v${spec.version}, ${spec.status})`);
      }
      if (tierServices.length > 0) this.curationTiers.push(tierServices);
    }

    // Narrative-path specs (generation / imagery / summary) carry no
    // service factory — the engine consumes their content directly to
    // assemble prompts. Same resolution precedence (active → experimental)
    // as enrichment / curation. Null when no row exists for the profile;
    // the engine falls back to baseline-only assembly.
    this.generationSpec = await this.resolveContentSpec<GenerationSpecContent>("generation", eventProfileName);
    this.imagerySpec = await this.resolveContentSpec<ImagerySpecContent>("imagery", eventProfileName);
    this.summarySpec = await this.resolveContentSpec<SummarySpecContent>("summary", eventProfileName);
    for (const [name, present] of [
      ["generation", this.generationSpec],
      ["imagery", this.imagerySpec],
      ["summary", this.summarySpec],
    ] as const) {
      if (present) console.log(`[registry] loaded ${name} spec for profile "${eventProfileName}"`);
      else console.log(`[registry] no ${name} spec for profile "${eventProfileName}" — baseline-only assembly`);
    }

    const total = this.enrichmentServices.size + this.curationServices.size;
    console.log(
      `[registry] initialized ${total} services (${this.enrichmentServices.size} enrichment, ${this.curationServices.size} curation across ${this.curationTiers.length} tiers) for profile "${eventProfileName}"`,
    );
  }

  async persistEnrichmentStates(): Promise<void> {
    if (!this.broadcastId) return;
    const broadcastId = this.broadcastId;

    for (const service of this.enrichmentServices.values()) {
      await db
        .insert(enrichmentServiceStates)
        .values({
          broadcastId,
          serviceName: service.name,
          specVersion: service.spec.version,
          expressedState: service.getExpressedStates(),
          unexpressedState: service.getUnexpressedStates(),
          acknowledgedState: service.getAcknowledgedStates(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [enrichmentServiceStates.broadcastId, enrichmentServiceStates.serviceName],
          set: {
            specVersion: service.spec.version,
            expressedState: service.getExpressedStates(),
            unexpressedState: service.getUnexpressedStates(),
            acknowledgedState: service.getAcknowledgedStates(),
            updatedAt: new Date(),
          },
        });
    }
  }

  /**
   * Current per-service `last_surfaced_at` values for the initialised
   * broadcast. `null` means never surfaced yet. Used by the curator's
   * NarrativeGapService to identify threads overdue for callback.
   */
  async getLastSurfacedAtMap(): Promise<Record<string, number | null>> {
    if (!this.broadcastId) return {};
    const rows = await db
      .select({
        serviceName: enrichmentServiceStates.serviceName,
        lastSurfacedAt: enrichmentServiceStates.lastSurfacedAt,
      })
      .from(enrichmentServiceStates)
      .where(eq(enrichmentServiceStates.broadcastId, this.broadcastId));
    const out: Record<string, number | null> = {};
    for (const s of this.enrichmentServices.values()) {
      out[s.name] = null;
    }
    for (const row of rows) {
      out[row.serviceName] = row.lastSurfacedAt ? row.lastSurfacedAt.getTime() : null;
    }
    return out;
  }

  async touchSurfacedAt(serviceName: string): Promise<void> {
    if (!this.broadcastId) return;
    await db
      .update(enrichmentServiceStates)
      .set({ lastSurfacedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(enrichmentServiceStates.broadcastId, this.broadcastId),
          eq(enrichmentServiceStates.serviceName, serviceName),
        ),
      );
  }

  private async resolveSpec(serviceName: string, profileName: string): Promise<ServiceSpec | null> {
    const rows = await db
      .select()
      .from(serviceSpecs)
      .where(
        and(
          eq(serviceSpecs.serviceName, serviceName),
          eq(serviceSpecs.eventProfileName, profileName),
        ),
      )
      .orderBy(serviceSpecs.status);

    const active = rows.find((r) => r.status === "active");
    const experimental = rows.find((r) => r.status === "experimental");
    const row = active ?? experimental;

    if (!row) return null;

    return {
      serviceName: row.serviceName,
      serviceType: row.serviceType,
      eventProfileName: row.eventProfileName,
      version: row.version,
      status: row.status,
      spec: row.spec as Record<string, unknown>,
    };
  }

  /**
   * Resolve a content-only spec (generation / imagery / summary) — same
   * precedence as service-spec resolution, but returns the parsed jsonb
   * content directly rather than wrapping a ServiceSpec. These specs
   * have no factory; the engine consumes their content directly.
   */
  private async resolveContentSpec<T>(
    serviceName: string,
    profileName: string,
  ): Promise<T | null> {
    const spec = await this.resolveSpec(serviceName, profileName);
    return spec ? (spec.spec as unknown as T) : null;
  }

  /**
   * The narrative-path specs (generation / imagery / summary), resolved
   * at initialise time. Each returns null when no spec row exists for
   * the active profile — the engine falls back to baseline-only
   * assembly for that surface.
   */
  getGenerationSpec(): GenerationSpecContent | null {
    return this.generationSpec;
  }
  getImagerySpec(): ImagerySpecContent | null {
    return this.imagerySpec;
  }
  getSummarySpec(): SummarySpecContent | null {
    return this.summarySpec;
  }

  getEnrichmentServices(): EnrichmentService[] {
    return Array.from(this.enrichmentServices.values());
  }

  getCurationServices(): CurationService[] {
    return Array.from(this.curationServices.values());
  }

  /** Curation services grouped into tiers — within a tier services run
   * concurrently, between tiers they run sequentially. The Curator
   * iterates these to drive parallel-within-tier execution. */
  getCurationServiceTiers(): CurationService[][] {
    return this.curationTiers.map((tier) => [...tier]);
  }

  getSnapshots(): ServiceSnapshot[] {
    // Literal narrowing: the maps are typed by their service kind, but
    // `s.spec.serviceType` widens to the full `ServiceType` union (which
    // also includes `narrative`). Map iteration guarantees the value
    // here — assert the narrow literal so ServiceSnapshot stays an
    // enrichment+curation-only concept.
    const enrichment: ServiceSnapshot[] = Array.from(this.enrichmentServices.values()).map((s) => ({
      name: s.name,
      serviceType: "enrichment" as const,
      specVersion: s.spec.version,
      ready: s.isReady(),
      expressed: s.getExpressedStates(),
      unexpressed: s.getUnexpressedStates(),
      acknowledged: s.getAcknowledgedStates(),
    }));

    const curation: ServiceSnapshot[] = Array.from(this.curationServices.values()).map((s) => ({
      name: s.name,
      serviceType: "curation" as const,
      specVersion: s.spec.version,
      ready: s.isReady(),
    }));

    return [...enrichment, ...curation];
  }
}
