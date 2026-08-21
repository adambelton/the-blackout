import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BaseEnrichmentService } from "../src/enrichment/base-service.js";
import {
  FEEDBACK_OUTCOMES,
  type EnrichmentAnnotation,
  type FeedChunk,
  type ServiceSpec,
} from "../src/enrichment/types.js";

interface TestReading extends Record<string, unknown> {
  direction: "rising" | "stable" | "falling";
  intensity: "low" | "moderate" | "high";
}

const SPEC: ServiceSpec = {
  serviceName: "test",
  serviceType: "enrichment",
  eventProfileName: "test_profile",
  version: "0.0.1",
  status: "experimental",
  spec: {},
};

/** Concrete subclass exposing the protected helpers so tests can drive them. */
class TestService extends BaseEnrichmentService<TestReading> {
  readonly name = "test";

  async process(_chunk: FeedChunk): Promise<EnrichmentAnnotation[]> {
    this.markProcessed();
    return [];
  }

  // Test-facing shims.
  public setSubject(id: string, label: string, reading: TestReading): void {
    this.upsertUnexpressed(id, label, reading);
  }

  public emit(id: string, basis = "b", informedBy: string[] = []): EnrichmentAnnotation | null {
    return this.buildAnnotation(id, basis, informedBy);
  }

  public changed(id: string): boolean {
    return this.shouldEmitAnnotation(id);
  }

  public knownSubjects(): Array<{ id: string; label: string }> {
    return this.getKnownSubjects();
  }
}

function s(): TestService {
  return new TestService(SPEC);
}

describe("BaseEnrichmentService — subject lifecycle", () => {
  it("new subject enters unexpressed; shouldEmit=true when no acknowledged", () => {
    const svc = s();
    svc.setSubject("a", "A", { direction: "rising", intensity: "moderate" });
    assert.equal(svc.changed("a"), true);
    const ann = svc.emit("a", "event stream opened");
    assert.ok(ann);
    assert.equal(ann.subjectId, "a");
    assert.equal(ann.subjectLabel, "A");
    assert.deepEqual(ann.meaning.unexpressed, { direction: "rising", intensity: "moderate" });
    assert.equal(ann.meaning.expressed, null);
    assert.equal(ann.meaning.acknowledged, null);
  });

  it("shouldEmit suppresses when unexpressed matches acknowledged exactly", () => {
    const svc = s();
    svc.setSubject("a", "A", { direction: "rising", intensity: "moderate" });
    svc.confirmSurfaced({
      serviceName: "test",
      subjectId: "a",
      outcome: FEEDBACK_OUTCOMES.ACKNOWLEDGED,
    });
    // Same reading re-submitted next cycle.
    svc.setSubject("a", "A", { direction: "rising", intensity: "moderate" });
    assert.equal(svc.changed("a"), false);
  });

  it("shouldEmit fires again when unexpressed diverges from acknowledged", () => {
    const svc = s();
    svc.setSubject("a", "A", { direction: "rising", intensity: "moderate" });
    svc.confirmSurfaced({
      serviceName: "test",
      subjectId: "a",
      outcome: FEEDBACK_OUTCOMES.ACKNOWLEDGED,
    });
    svc.setSubject("a", "A", { direction: "rising", intensity: "high" });
    assert.equal(svc.changed("a"), true);
  });
});

describe("BaseEnrichmentService — feedback transitions", () => {
  it("EMPHASIS copies unexpressed to expressed and clears acknowledged", () => {
    const svc = s();
    svc.setSubject("a", "A", { direction: "rising", intensity: "high" });
    // Pre-existing ack snapshot that should clear on emphasis.
    svc.confirmSurfaced({
      serviceName: "test",
      subjectId: "a",
      outcome: FEEDBACK_OUTCOMES.ACKNOWLEDGED,
    });

    svc.setSubject("a", "A", { direction: "falling", intensity: "moderate" });
    svc.confirmSurfaced({
      serviceName: "test",
      subjectId: "a",
      outcome: FEEDBACK_OUTCOMES.DELIVERED_WITH_EMPHASIS,
    });

    const expressed = svc.getExpressedStates();
    const acknowledged = svc.getAcknowledgedStates();
    assert.deepEqual(expressed["a"].reading, { direction: "falling", intensity: "moderate" });
    assert.equal(acknowledged["a"], undefined, "acknowledged should be cleared after emphasis");
  });

  it("ACKNOWLEDGED snapshots unexpressed into acknowledged without touching expressed", () => {
    const svc = s();
    svc.setSubject("a", "A", { direction: "rising", intensity: "moderate" });
    svc.confirmSurfaced({
      serviceName: "test",
      subjectId: "a",
      outcome: FEEDBACK_OUTCOMES.ACKNOWLEDGED,
    });

    assert.equal(svc.getExpressedStates()["a"], undefined);
    assert.deepEqual(svc.getAcknowledgedStates()["a"].reading, {
      direction: "rising",
      intensity: "moderate",
    });
  });

  it("IGNORED leaves all three states untouched (ledger accumulates)", () => {
    const svc = s();
    svc.setSubject("a", "A", { direction: "rising", intensity: "moderate" });
    const before = {
      expressed: svc.getExpressedStates(),
      unexpressed: svc.getUnexpressedStates(),
      acknowledged: svc.getAcknowledgedStates(),
    };
    svc.confirmSurfaced({
      serviceName: "test",
      subjectId: "a",
      outcome: FEEDBACK_OUTCOMES.IGNORED,
    });
    assert.deepEqual(svc.getExpressedStates(), before.expressed);
    assert.deepEqual(svc.getUnexpressedStates(), before.unexpressed);
    assert.deepEqual(svc.getAcknowledgedStates(), before.acknowledged);
  });

  it("KILLED with replacement overwrites expressed and unexpressed, clears acknowledged", () => {
    const svc = s();
    svc.setSubject("a", "A", { direction: "rising", intensity: "high" });
    svc.confirmSurfaced({
      serviceName: "test",
      subjectId: "a",
      outcome: FEEDBACK_OUTCOMES.ACKNOWLEDGED,
    });

    svc.confirmSurfaced({
      serviceName: "test",
      subjectId: "a",
      outcome: FEEDBACK_OUTCOMES.KILLED_WITH_REPLACEMENT,
      replacementReading: { direction: "falling", intensity: "low" },
    });

    assert.deepEqual(svc.getExpressedStates()["a"].reading, { direction: "falling", intensity: "low" });
    assert.deepEqual(svc.getUnexpressedStates()["a"].reading, { direction: "falling", intensity: "low" });
    assert.equal(svc.getAcknowledgedStates()["a"], undefined);
  });

  it("KILLED without replacement reverts unexpressed to expressed, clears acknowledged", () => {
    const svc = s();
    // Establish a baseline via emphasis.
    svc.setSubject("a", "A", { direction: "stable", intensity: "low" });
    svc.confirmSurfaced({
      serviceName: "test",
      subjectId: "a",
      outcome: FEEDBACK_OUTCOMES.DELIVERED_WITH_EMPHASIS,
    });
    // Drift to a new unexpressed reading.
    svc.setSubject("a", "A", { direction: "rising", intensity: "high" });
    svc.confirmSurfaced({
      serviceName: "test",
      subjectId: "a",
      outcome: FEEDBACK_OUTCOMES.ACKNOWLEDGED,
    });
    // Kill without replacement.
    svc.confirmSurfaced({
      serviceName: "test",
      subjectId: "a",
      outcome: FEEDBACK_OUTCOMES.KILLED_WITH_REPLACEMENT,
    });
    // Unexpressed rewound to the baseline expressed reading.
    assert.deepEqual(svc.getUnexpressedStates()["a"].reading, { direction: "stable", intensity: "low" });
    assert.equal(svc.getAcknowledgedStates()["a"], undefined);
  });

  it("per-subject isolation: feedback to A doesn't touch B", () => {
    const svc = s();
    svc.setSubject("a", "A", { direction: "rising", intensity: "moderate" });
    svc.setSubject("b", "B", { direction: "falling", intensity: "low" });

    svc.confirmSurfaced({
      serviceName: "test",
      subjectId: "a",
      outcome: FEEDBACK_OUTCOMES.DELIVERED_WITH_EMPHASIS,
    });

    assert.deepEqual(svc.getExpressedStates()["a"].reading, { direction: "rising", intensity: "moderate" });
    assert.equal(svc.getExpressedStates()["b"], undefined, "B should not have advanced");
    assert.deepEqual(svc.getUnexpressedStates()["b"].reading, { direction: "falling", intensity: "low" });
  });
});

describe("BaseEnrichmentService — hydration + reset", () => {
  it("hydrateStates populates all three maps and marks ready", () => {
    const svc = s();
    svc.hydrateStates(
      { a: { label: "A", reading: { direction: "rising", intensity: "high" } } },
      { a: { label: "A", reading: { direction: "rising", intensity: "high" } } },
      {},
    );
    assert.equal(svc.isReady(), true);
    assert.equal(svc.knownSubjects().length, 1);
  });

  it("reset clears every state and un-readies the service", () => {
    const svc = s();
    svc.setSubject("a", "A", { direction: "rising", intensity: "low" });
    svc.hydrateStates({}, {}, {});
    svc.reset();
    assert.equal(svc.isReady(), false);
    assert.deepEqual(svc.getExpressedStates(), {});
    assert.deepEqual(svc.getUnexpressedStates(), {});
    assert.deepEqual(svc.getAcknowledgedStates(), {});
  });
});
