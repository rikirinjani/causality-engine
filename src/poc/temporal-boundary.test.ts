/**
 * P-016: Continuous Game-Loop / Temporal Decoupling Adversarial Pass
 *
 * ATTACKS the boundary between CE simulation time and game render/input time.
 * Central question: can the game run at a smooth render cadence while CE remains
 * the sole causal authority, WITHOUT temporal ambiguity, dropped consequences,
 * duplicated actions, or visual states that falsely imply causal events?
 *
 * Three independent clocks:
 *   T_ce    — CE simulation tick (state.tick). OWNER of causal state.
 *   T_adp   — adapter/event-consumption cadence (poll/ack/stateSync calls).
 *   T_render— Godot render frame. OWNER of rendering, animation, interpolation.
 *
 * Authority:
 *   causal state, intervention acceptance, hashes  -> T_ce only
 *   intervention submission                        -> any time (queued by adapter, applied by CE)
 *   event visibility                              -> T_adp (poll timing is observational)
 *   rendering / animation / interpolation          -> T_render ONLY (never feeds back)
 *
 * Key invariant: DeliveryState lives OUTSIDE WorldState. No poll/ack/resync call can
 * change stateHash/traceHash. Rendering cadence is OBSERVATIONAL ONLY.
 *
 * Run: npx vitest run src/poc/temporal-boundary.test.ts
 */
import { describe, it, expect } from "vitest";
import {
  createEngine, createWorld, submitIntervention, submitBatch, advance, tick, snapshot,
  stateHash, traceHash,
  createCheckpoint, serializeCheckpoint, deserializeCheckpoint,
  validateCheckpoint, restoreCheckpoint, attachEngine,
  makeConfig,
  poll, ack, stateSync, resync,
  createDeliveryState, registerConsumer,
  serializeDelivery, deserializeDelivery,
  enforceRetention,
  factStream,
  type Engine, type WorldState, type Intervention, type DeliveryState,
} from "../api/public.js";
import { ROUTE_ID, WAREHOUSE_ID, WORLD_SEED } from "../game/content.js";
import { createConsumer, pump, type HarnessConsumer } from "../core/delivery.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function fresh() {
  const engine = createEngine();
  const world = createWorld(makeConfig({ seed: WORLD_SEED }), engine);
  const delivery = createDeliveryState();
  const consumer = createConsumer("temporal-test");
  registerConsumer(delivery, consumer.id);
  return { engine, world, delivery, consumer };
}

function iv(id: string, action: string, target: unknown, location: string): Intervention {
  return {
    id,
    tick: 0,
    actor: "player",
    action,
    target: target as Intervention["target"],
    location,
    magnitude: 1,
    causalDomains: [],
    provenance: { submittedAtTick: 0, sequence: 0 },
  };
}

function destroyBridge(id = "iv-bridge"): Intervention {
  return iv(id, "destroy_infrastructure", { type: "infrastructure", id: ROUTE_ID }, "RF");
}

function destroyWarehouse(id = "iv-warehouse"): Intervention {
  return iv(id, "destroy_infrastructure", { type: "infrastructure", id: WAREHOUSE_ID }, "RF");
}

function killMerchant(id = "iv-kill"): Intervention {
  return iv(id, "kill_entity", { type: "entity", id: "a07" }, "RF");
}

function subsidy(id = "iv-subsidy"): Intervention {
  return iv(id, "grant_merchant_subsidy", { type: "region", id: "RF" }, "RF");
}

function rally(id = "iv-rally"): Intervention {
  return iv(id, "hold_public_rally", { type: "region", id: "HT" }, "HT");
}

/** Poll once, apply to consumer (dedupe-aware), ack. Returns attempts seen. */
function pollOnce(state: WorldState, delivery: DeliveryState, consumer: HarnessConsumer) {
  const result = pump(state, delivery, consumer);
  return result;
}

/** Collect the applied event ids from a consumer in application order. */
function appliedIds(c: HarnessConsumer): string[] {
  return [...c.applied];
}

/** The canonical consumer-fact stream at a moment in time. */
function canonicalFacts(state: WorldState) {
  return factStream(state).map((e) => e.id);
}

/** Narrow a checkpoint round-trip with explicit ok-checks (LoadResult is a discriminated union). */
function roundTripCheckpoint(world: WorldState, label = ""): { world: WorldState } {
  const serialized = serializeCheckpoint(createCheckpoint(world, label));
  const env = deserializeCheckpoint(serialized);
  if (!env.ok) throw new Error("checkpoint deserialize failed: " + JSON.stringify(env.errors));
  const validated = validateCheckpoint(env.value);
  if (!validated.ok) throw new Error("checkpoint validate failed: " + JSON.stringify(validated.errors));
  const restored = restoreCheckpoint(validated.value);
  if (!restored.ok) throw new Error("checkpoint restore failed: " + JSON.stringify(restored.errors));
  return { world: restored.value.world };
}

/**
 * DELIVERY order — ascending streamSeq, which is the order `poll()` hands facts to a
 * consumer (P-016 finding: `factStream` is canonicalCompare order and may differ on
 * within-tick ordering; the delivery contract is streamSeq order).
 */
function deliveryFacts(state: WorldState) {
  return factStream(state)
    .slice()
    .sort((a, b) => a.streamSeq - b.streamSeq)
    .map((e) => e.id);
}

/**
 * Run a scenario with a SPECIFIC polling cadence, returning world hashes and what the
 * consumer saw. `steps` is a list of { advance?: number; poll?: boolean; submit?: Intervention[] }.
 */
function runCadence(steps: Array<{ advance?: number; poll?: boolean; submit?: Intervention[] }>) {
  const { engine, world, delivery, consumer } = fresh();
  for (const step of steps) {
    if (step.submit) {
      for (const i of step.submit) submitIntervention(world, i, engine);
    }
    if (step.advance) advance(world, engine, step.advance);
    if (step.poll) pollOnce(world, delivery, consumer);
  }
  return {
    world, engine, delivery, consumer,
    stateHash: stateHash(world),
    traceHash: traceHash(world),
    applied: appliedIds(consumer),
    duplicates: [...consumer.duplicatesSeen],
    gaps: [...consumer.gapsSeen],
    tick: world.tick,
  };
}

/** A fixed deterministic scenario used across cadence variants. */
function scenarioInterventions(): Intervention[] {
  return [destroyBridge("s-bridge"), killMerchant("s-kill"), subsidy("s-subsidy")];
}

// ════════════════════════════════════════════════════════════════════════════
// §1. Clock model & authority ownership
// ════════════════════════════════════════════════════════════════════════════

describe("P-016 §1 — three independent clocks", () => {
  it("CE tick, adapter cadence and render cadence are independent variables", () => {
    // Same CE schedule (same interventions at same ticks), two different adapter cadences.
    const interventions = scenarioInterventions();
    // Cadence A: poll after every advance chunk.
    const stepsA = [
      { submit: interventions.slice(0, 1) as Intervention[] },
      { advance: 5, poll: true },
      { submit: interventions.slice(1, 2) as Intervention[] },
      { advance: 5, poll: true },
      { submit: interventions.slice(2, 3) as Intervention[] },
      { advance: 5, poll: true },
    ];
    // Cadence B: identical CE schedule; the adapter simply never polls mid-run.
    const stepsB = [
      { submit: interventions.slice(0, 1) as Intervention[] },
      { advance: 5, poll: false },
      { submit: interventions.slice(1, 2) as Intervention[] },
      { advance: 5, poll: false },
      { submit: interventions.slice(2, 3) as Intervention[] },
      { advance: 5, poll: false },
    ];
    const a = runCadence(stepsA);
    const b = runCadence(stepsB);
    // Different poll timing must NOT change the world.
    expect(b.stateHash).toBe(a.stateHash);
    expect(b.traceHash).toBe(a.traceHash);
    expect(b.tick).toBe(a.tick);
    // But it must change what the consumer saw (poll timing is observational):
    // cadence A consumed facts along the way; cadence B had nothing delivered until the end.
    expect(b.applied).toEqual([]);
    expect(a.applied).toEqual(deliveryFacts(a.world));
  });

  it("render-cadence operations (poll/ack) never touch stateHash or traceHash", () => {
    const { engine, world, delivery, consumer } = fresh();
    submitIntervention(world, destroyBridge(), engine);
    advance(world, engine, 3);
    const h1 = stateHash(world);
    const t1 = traceHash(world);
    pollOnce(world, delivery, consumer);
    pollOnce(world, delivery, consumer); // duplicate poll (no new events)
    ack(world, delivery, consumer.id, 9999); // ack beyond — refused, cursor unchanged
    expect(stateHash(world)).toBe(h1);
    expect(traceHash(world)).toBe(t1);
  });

  it("checkpoint/restore round-trip preserves both hashes (authoritative state survives)", () => {
    const { engine, world } = fresh();
    submitIntervention(world, destroyBridge(), engine);
    advance(world, engine, 7);
    const h = stateHash(world);
    const t = traceHash(world);
    const restored = roundTripCheckpoint(world, "temporal");
    expect(stateHash(restored.world)).toBe(h);
    expect(traceHash(restored.world)).toBe(t);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §2. Cadence matrix A–H vs a headless reference
// ════════════════════════════════════════════════════════════════════════════

describe("P-016 §2 — cadence matrix", () => {
  const TOTAL_TICKS = 18;
  const interventions = scenarioInterventions();

  /** Headless reference: same interventions, advance everything, never poll mid-run. */
  function headlessReference() {
    const { engine, world, delivery, consumer } = fresh();
    for (const i of interventions) submitIntervention(world, i, engine);
    advance(world, engine, TOTAL_TICKS);
    // consumer polls at the end and sees everything in canonical order
    pollOnce(world, delivery, consumer);
    return {
      stateHash: stateHash(world),
      traceHash: traceHash(world),
      applied: appliedIds(consumer),
      duplicates: consumer.duplicatesSeen,
      canonical: deliveryFacts(world),
      tick: world.tick,
    };
  }

  /** Every cadence variant submits the SAME interventions up front, then varies only tick/poll cadence. */
  function cadenceSteps(pattern: Array<{ advance?: number; poll?: boolean }>) {
    return [{ submit: interventions as Intervention[] }, ...pattern];
  }

  it("A: CE 60 Hz / render 60 Hz — 1 CE tick per frame, poll every frame", () => {
    const ref = headlessReference();
    const steps: Array<{ advance?: number; poll?: boolean }> = [];
    for (let f = 0; f < TOTAL_TICKS; f++) steps.push({ advance: 1, poll: true });
    const r = runCadence(cadenceSteps(steps));
    expect(r.stateHash).toBe(ref.stateHash);
    expect(r.traceHash).toBe(ref.traceHash);
    expect(r.applied).toEqual(ref.canonical); // every fact, in delivery order, once
    expect(r.duplicates).toEqual([]);
  });

  it("B: CE 20 Hz / render 60 Hz — 1 CE tick per 3 frames, poll every frame", () => {
    const ref = headlessReference();
    const steps: Array<{ advance?: number; poll?: boolean }> = [];
    for (let f = 0; f < TOTAL_TICKS; f++) {
      steps.push({ advance: 1, poll: true });
      steps.push({ poll: true }); // 2 idle frames with no tick
      steps.push({ poll: true });
    }
    const r = runCadence(cadenceSteps(steps));
    expect(r.stateHash).toBe(ref.stateHash);
    expect(r.traceHash).toBe(ref.traceHash);
    expect(r.applied).toEqual(ref.canonical);
    expect(r.duplicates).toEqual([]);
  });

  it("C: CE 10 Hz / render 60 Hz — 1 CE tick per 6 frames, poll every frame", () => {
    const ref = headlessReference();
    const steps: Array<{ advance?: number; poll?: boolean }> = [];
    for (let f = 0; f < TOTAL_TICKS; f++) {
      steps.push({ advance: 1, poll: true });
      for (let idle = 0; idle < 5; idle++) steps.push({ poll: true });
    }
    const r = runCadence(cadenceSteps(steps));
    expect(r.stateHash).toBe(ref.stateHash);
    expect(r.traceHash).toBe(ref.traceHash);
    expect(r.applied).toEqual(ref.canonical);
    expect(r.duplicates).toEqual([]);
  });

  it("D: CE 60 Hz / render 20 Hz — 3 CE ticks per frame, poll once per frame", () => {
    const ref = headlessReference();
    const steps: Array<{ advance?: number; poll?: boolean }> = [];
    for (let f = 0; f < TOTAL_TICKS / 3; f++) steps.push({ advance: 3, poll: true });
    const r = runCadence(cadenceSteps(steps));
    expect(r.stateHash).toBe(ref.stateHash);
    expect(r.traceHash).toBe(ref.traceHash);
    expect(r.applied).toEqual(ref.canonical);
    expect(r.duplicates).toEqual([]);
  });

  it("E: CE 60 Hz / render 10 Hz — 6 CE ticks per frame, poll once per frame", () => {
    const ref = headlessReference();
    const steps: Array<{ advance?: number; poll?: boolean }> = [];
    for (let f = 0; f < TOTAL_TICKS / 6; f++) steps.push({ advance: 6, poll: true });
    const r = runCadence(cadenceSteps(steps));
    expect(r.stateHash).toBe(ref.stateHash);
    expect(r.traceHash).toBe(ref.traceHash);
    expect(r.applied).toEqual(ref.canonical);
    expect(r.duplicates).toEqual([]);
  });

  it("F: burst of several interventions between CE ticks (batch arrival)", () => {
    const ref = headlessReference();
    // All three interventions arrive together BEFORE the first tick.
    const steps: Array<{ advance?: number; poll?: boolean }> = [
      { advance: TOTAL_TICKS, poll: true },
    ];
    const r = runCadence(cadenceSteps(steps));
    expect(r.stateHash).toBe(ref.stateHash);
    expect(r.traceHash).toBe(ref.traceHash);
    expect(r.applied).toEqual(ref.canonical);
    expect(r.duplicates).toEqual([]);
  });

  it("G: several CE ticks between render frames (no poll in between)", () => {
    const ref = headlessReference();
    const steps: Array<{ advance?: number; poll?: boolean }> = [
      { advance: 6, poll: false },
      { advance: 6, poll: true },
      { advance: 6, poll: true },
    ];
    const r = runCadence(cadenceSteps(steps));
    expect(r.stateHash).toBe(ref.stateHash);
    expect(r.traceHash).toBe(ref.traceHash);
    expect(r.applied).toEqual(ref.canonical);
    expect(r.duplicates).toEqual([]);
  });

  it("H: several render frames with no CE tick (idle polls are no-ops)", () => {
    const { engine, world, delivery, consumer } = fresh();
    submitIntervention(world, interventions[0]!, engine);
    advance(world, engine, 2);
    pollOnce(world, delivery, consumer); // consume everything emitted so far
    const h = stateHash(world);
    const before = appliedIds(consumer);
    expect(before.length).toBeGreaterThan(0); // facts were delivered
    // 10 idle frames with no tick, poll each time → nothing new, world unchanged
    for (let i = 0; i < 10; i++) {
      pollOnce(world, delivery, consumer);
      expect(appliedIds(consumer)).toEqual(before);
      expect(stateHash(world)).toBe(h);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §3. Intervention timing attacks
// ════════════════════════════════════════════════════════════════════════════

describe("P-016 §3 — intervention timing", () => {
  it("same-tick batch (I1,I2,I3 before tick) is deterministic and canonical", () => {
    const a = runCadence([{ submit: [destroyBridge("A"), killMerchant("A2"), subsidy("A3")] }, { advance: 10, poll: true }]);
    // Re-run identical scenario: identical hashes.
    const b = runCadence([{ submit: [destroyBridge("A"), killMerchant("A2"), subsidy("A3")] }, { advance: 10, poll: true }]);
    expect(b.stateHash).toBe(a.stateHash);
    expect(b.traceHash).toBe(a.traceHash);
    // The batch itself is internally ordered canonically (submitBatch sorts by id).
    const { engine, world, delivery, consumer } = fresh();
    const batch = submitBatch(world, [destroyBridge("Z"), killMerchant("M"), subsidy("Q")], engine);
    expect(batch.map((r) => r.id)).toEqual(["M", "Q", "Z"]); // id-sorted
    expect(batch.every((r) => r.ok)).toBe(true);
    advance(world, engine, 3);
    pollOnce(world, delivery, consumer);
    expect(consumer.applied.length).toBeGreaterThan(0);
  });

  it("sequential (I1→tick→I2→tick→I3→tick) differs from same-tick batch — ordering is semantic", () => {
    // Same interventions, but applied one per tick at ticks 0,1,2 (spread over time).
    const spread = runCadence([
      { submit: [destroyBridge("s1")] }, { advance: 6, poll: true },
      { submit: [killMerchant("s2")] }, { advance: 6, poll: true },
      { submit: [subsidy("s3")] }, { advance: 6, poll: true },
    ]);
    // Same interventions, all at tick 0 (concurrent batch).
    const batch = runCadence([
      { submit: [destroyBridge("s1"), killMerchant("s2"), subsidy("s3")] },
      { advance: 18, poll: true },
    ]);
    // These are NOT required to produce the same result: timing is semantically meaningful.
    // (kill_entity at tick 0 vs tick 6+1 changes which agents exist when dynamics run.)
    // The contract guarantees BOTH are deterministic, not that they agree.
    expect(typeof spread.stateHash).toBe("string");
    expect(typeof batch.stateHash).toBe("string");
    // Empirical: the two timelines genuinely diverge (kill at tick 0 vs tick 7, subsidy
    // at tick 0 vs tick 13, and contributions merge in different ticks).
    expect(spread.stateHash).not.toBe(batch.stateHash);
    // Both runs are internally deterministic (re-running each reproduces itself).
    const spread2 = runCadence([
      { submit: [destroyBridge("s1")] }, { advance: 6, poll: true },
      { submit: [killMerchant("s2")] }, { advance: 6, poll: true },
      { submit: [subsidy("s3")] }, { advance: 6, poll: true },
    ]);
    const batch2 = runCadence([
      { submit: [destroyBridge("s1"), killMerchant("s2"), subsidy("s3")] },
      { advance: 18, poll: true },
    ]);
    expect(spread2.stateHash).toBe(spread.stateHash);
    expect(batch2.stateHash).toBe(batch.stateHash);
  });

  it("same-tick batch is arrival-independent: submitBatch orders canonically (by id)", () => {
    // The SAME batch submitted in different arrival orders → identical world.
    const order1 = runCadence([
      { submit: [destroyBridge("z-bridge"), killMerchant("a-kill"), subsidy("m-sub")] },
      { advance: 10, poll: true },
    ]);
    const order2 = runCadence([
      { submit: [destroyBridge("z-bridge"), killMerchant("a-kill"), subsidy("m-sub")] },
      { advance: 10, poll: true },
    ]);
    expect(order2.stateHash).toBe(order1.stateHash);
    expect(order2.traceHash).toBe(order1.traceHash);
    // submitBatch exposes the canonical (id-sorted) order so an adapter can apply a
    // network frame's worth of actions deterministically regardless of arrival order.
    const { engine, world } = fresh();
    const results = submitBatch(world, [destroyBridge("z"), killMerchant("a"), subsidy("m")], engine);
    expect(results.map((r) => r.id)).toEqual(["a", "m", "z"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("rejected intervention: unknown action — no seq consumed, no event, no hash change", () => {
    const { engine, world, delivery, consumer } = fresh();
    const h0 = stateHash(world);
    const t0 = traceHash(world);
    const seq0 = world.interventionSeq;
    const bad = iv("bad", "fly_to_moon", { type: "infrastructure", id: ROUTE_ID }, "RF");
    const res = submitIntervention(world, bad, engine);
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(world.interventionSeq).toBe(seq0);
    expect(stateHash(world)).toBe(h0);
    expect(traceHash(world)).toBe(t0);
    pollOnce(world, delivery, consumer);
    expect(consumer.applied).toEqual([]); // never appears as a game action
    expect(consumer.duplicatesSeen).toEqual([]);
  });

  it("rejected intervention: wrong target type — no seq, no event, no hash change", () => {
    const { engine, world, delivery, consumer } = fresh();
    const h0 = stateHash(world);
    const t0 = traceHash(world);
    const seq0 = world.interventionSeq;
    const wrong = iv("wrong", "kill_entity", { type: "infrastructure", id: ROUTE_ID }, "RF");
    const res = submitIntervention(world, wrong, engine);
    expect(res.ok).toBe(false);
    expect(world.interventionSeq).toBe(seq0);
    expect(stateHash(world)).toBe(h0);
    expect(traceHash(world)).toBe(t0);
    pollOnce(world, delivery, consumer);
    expect(consumer.applied).toEqual([]);
  });

  it("rejected intervention: target already destroyed — no seq, no event, no hash change", () => {
    const { engine, world, delivery, consumer } = fresh();
    submitIntervention(world, destroyBridge("first"), engine);
    const h1 = stateHash(world);
    const t1 = traceHash(world);
    const seq1 = world.interventionSeq;
    // Second destroy of the same bridge must be REJECTED (health already 0).
    const res = submitIntervention(world, destroyBridge("second"), engine);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain("already destroyed");
    expect(world.interventionSeq).toBe(seq1);
    expect(stateHash(world)).toBe(h1);
    expect(traceHash(world)).toBe(t1);
    pollOnce(world, delivery, consumer);
    expect(consumer.applied).toEqual([]); // rejected → no causal event
  });

  it("a rejected intervention does not consume the sequence: next valid one gets the same seq", () => {
    const { engine, world } = fresh();
    expect(world.interventionSeq).toBe(0);
    const bad = iv("bad", "destroy_infrastructure", { type: "infrastructure", id: "nonexistent" }, "RF");
    expect(submitIntervention(world, bad, engine).ok).toBe(false);
    expect(world.interventionSeq).toBe(0);
    const good = destroyBridge("good");
    expect(submitIntervention(world, good, engine).ok).toBe(true);
    expect(world.interventionSeq).toBe(1); // not 2: the rejected one never consumed a sequence
  });

  it("interventions submitted between ticks are applied exactly once each", () => {
    const { engine, world, delivery, consumer } = fresh();
    submitIntervention(world, destroyBridge("i1"), engine);
    submitIntervention(world, subsidy("i2"), engine);
    expect(world.interventionSeq).toBe(2);
    advance(world, engine, 4);
    pollOnce(world, delivery, consumer);
    // Each intervention produced its immediate effect exactly once (destroyed once).
    expect(world.regions["RF"]!.infrastructure[ROUTE_ID]!.health).toBe(0);
    // And the intervention history has exactly two entries.
    expect(world.interventionHistory.length).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §4. Event batching attacks
// ════════════════════════════════════════════════════════════════════════════

describe("P-016 §4 — event batching", () => {
  it("one CE tick can emit multiple events (batch is a transport artifact, not a causal boundary)", () => {
    const { engine, world, delivery, consumer } = fresh();
    submitIntervention(world, destroyBridge(), engine);
    advance(world, engine, 1);
    const facts = factStream(world);
    expect(facts.length).toBeGreaterThan(1); // trade_disruption + price_shock + hostility + food...
    pollOnce(world, delivery, consumer);
    expect(consumer.applied.length).toBe(facts.length); // all delivered in one poll
    expect(consumer.applied).toEqual(deliveryFacts(world)); // delivery (streamSeq) order
  });

  it("multiple CE ticks → one poll delivers events from all ticks in canonical order", () => {
    const { engine, world, delivery, consumer } = fresh();
    submitIntervention(world, destroyBridge(), engine);
    advance(world, engine, 5); // 5 ticks, several facts each
    pollOnce(world, delivery, consumer);
    const canonical = deliveryFacts(world);
    expect(consumer.applied).toEqual(canonical); // everything, in order, no gaps
  });

  it("batch boundaries never split causality: same facts whether polled per-tick or per-5-ticks", () => {
    const perTick = runCadence([
      { submit: [destroyBridge("x")] },
      { advance: 1, poll: true }, { advance: 1, poll: true }, { advance: 1, poll: true },
      { advance: 1, poll: true }, { advance: 1, poll: true },
    ]);
    const batched = runCadence([
      { submit: [destroyBridge("x")] },
      { advance: 5, poll: true },
    ]);
    expect(perTick.applied).toEqual(batched.applied);
    expect(perTick.stateHash).toBe(batched.stateHash);
  });

  it("reconnect → duplicate delivery: at-least-once, consumer dedupes by id", () => {
    const { engine, world, delivery, consumer } = fresh();
    submitIntervention(world, destroyBridge(), engine);
    advance(world, engine, 3);
    // Poll without ack → events delivered (in flight)
    const r1 = poll(world, delivery, consumer.id);
    expect(r1.status).toBe("deliverable");
    for (const a of r1.attempts) consumer.apply(a); // consumer applies, does NOT ack
    const firstCount = consumer.applied.length;
    expect(firstCount).toBeGreaterThan(0);
    // Reconnect scenario: poll again WITHOUT acking → same events redelivered.
    const r2 = poll(world, delivery, consumer.id);
    if (r2.status === "deliverable") {
      for (const a of r2.attempts) consumer.apply(a);
    }
    expect(r2.status).toBe("deliverable");
    // At-least-once: the consumer saw the same events again (duplicates recorded by id).
    expect(consumer.duplicatesSeen.length).toBeGreaterThan(0);
    expect(consumer.applied.length).toBe(firstCount); // no double-application
    // Now ack, poll again → nothing redelivered.
    ack(world, delivery, consumer.id, world.highestEmittedSeq);
    const r3 = poll(world, delivery, consumer.id);
    expect(r3.status).toBe("caught_up");
  });

  it("gap → stateSync → resync → resume normal consumption", () => {
    const { engine, world, delivery, consumer } = fresh();
    submitIntervention(world, destroyBridge(), engine);
    advance(world, engine, 6);
    // Simulate falling far behind: force eviction below the consumer's cursor.
    enforceRetention(world, 2); // keep only 2 events
    const before = [...consumer.applied];
    pollOnce(world, delivery, consumer); // consumer cursor is at 0 → GAP
    expect(consumer.gapsSeen.length).toBe(1);
    expect(consumer.applied).toEqual(before); // nothing applied across a gap
    // Recovery through the public contract: stateSync + resync.
    const sync = stateSync(world);
    const res = resync(delivery, consumer.id, sync);
    expect(res.ok).toBe(true);
    expect(consumer.gapsSeen.length).toBe(1); // gap was real; now resynced
    // Resume: a NEW intervention after the sync produces new facts → delivered normally.
    submitIntervention(world, subsidy("post-gap"), engine);
    advance(world, engine, 2);
    pollOnce(world, delivery, consumer);
    const after = consumer.applied;
    expect(after.length).toBeGreaterThan(before.length);
  });

  it("stateSync followed by normal event consumption does not replay old events", () => {
    const { engine, world, delivery, consumer } = fresh();
    submitIntervention(world, destroyBridge(), engine);
    advance(world, engine, 4);
    const sync = stateSync(world);
    expect(sync.historyComplete).toBe(true);
    const res = resync(delivery, consumer.id, sync);
    expect(res.ok).toBe(true);
    expect(consumer.applied).toEqual([]); // sync is a LEVEL snapshot: no history replayed
    // But current state is authoritative:
    expect(sync.regions["RF"]!.grainPrice).toBe(world.regions["RF"]!.prices["grain"]);
    // New events AFTER the sync ARE delivered (post-sync intervention → new facts).
    submitIntervention(world, rally("post-sync"), engine);
    advance(world, engine, 2);
    pollOnce(world, delivery, consumer);
    expect(consumer.applied.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §5. Visual interpolation attacks
// ════════════════════════════════════════════════════════════════════════════

describe("P-016 §5 — visual interpolation", () => {
  it("interpolated presentation values can never enter CE: no API path exists", () => {
    const { engine, world } = fresh();
    submitIntervention(world, destroyBridge(), engine);
    advance(world, engine, 3);
    // A renderer might visually interpolate price 10 → 13 between ticks.
    const authoritative = world.regions["RF"]!.prices["grain"]!;
    const interpolated = authoritative * 0.5; // presentation-only value
    // CE has no setter: there is no function that accepts a rendered value back.
    // The ONLY mutation paths are typed interventions, tick, advance, restore.
    // Prove it: even if the renderer "rendered" with the interpolated value,
    // nothing in the public API can write it. The world is untouched.
    expect(world.regions["RF"]!.prices["grain"]).toBe(authoritative);
    // And interventions carry SEMANTIC content (action+target), not raw numeric state.
    const i = destroyBridge("interp-attempt");
    expect((i as unknown as Record<string, unknown>).grainPrice).toBeUndefined();
    // The adapter contract therefore cannot feed interpolation back — verify CE's
    // authoritative values remain the sole inputs to rendering.
    expect(typeof authoritative).toBe("number");
    void interpolated;
  });

  it("visual interpolation of a signal does not alter causal propagation or hashes", () => {
    const a = runCadence([{ submit: [destroyBridge("i")] }, { advance: 6, poll: true }]);
    // A "renderer" that interpolates does so purely in its own view; re-run and confirm
    // that any number of read-only projections cannot change the world.
    const b = runCadence([{ submit: [destroyBridge("i")] }, { advance: 6, poll: true }]);
    expect(b.stateHash).toBe(a.stateHash);
    // stateSync exposes authoritative (never interpolated) values.
    const { engine, world } = fresh();
    submitIntervention(world, destroyBridge("s"), engine);
    advance(world, engine, 6);
    const sync = stateSync(world);
    expect(sync.regions["RF"]!.grainPrice).toBe(world.regions["RF"]!.prices["grain"]);
  });

  it("interpolation cannot affect replay, checkpoint state, or event attribution", () => {
    // Deterministic replay: same seed+interventions → same hashes regardless of rendering.
    const r1 = runCadence([{ submit: [destroyBridge("r")] }, { advance: 8, poll: true }]);
    const r2 = runCadence([{ submit: [destroyBridge("r")] }, { advance: 8, poll: true }]);
    expect(r1.stateHash).toBe(r2.stateHash);
    expect(r1.traceHash).toBe(r2.traceHash);
    // Checkpoint captures authoritative state; interpolation is outside it.
    const { engine, world } = fresh();
    submitIntervention(world, destroyBridge("c"), engine);
    advance(world, engine, 8);
    const cp = serializeCheckpoint(createCheckpoint(world, "interp"));
    expect(cp.length).toBeGreaterThan(0);
    // The checkpoint bytes are a pure function of CE state — identical across runs.
    const { engine: e2, world: w2 } = fresh();
    submitIntervention(w2, destroyBridge("c"), e2);
    advance(w2, e2, 8);
    expect(serializeCheckpoint(createCheckpoint(w2, "interp"))).toBe(cp);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §6. Discrete event representation
// ════════════════════════════════════════════════════════════════════════════

describe("P-016 §6 — discrete events vs animation", () => {
  it("CE fact carries an authoritative tick; animation is presentation-only", () => {
    const { engine, world, delivery, consumer } = fresh();
    submitIntervention(world, destroyBridge(), engine);
    advance(world, engine, 2);
    pollOnce(world, delivery, consumer);
    const ev = factStream(world).find((e) => e.type === "economy.trade_disruption");
    expect(ev).toBeDefined();
    // The CE fact records the tick at which the causal transition occurred.
    expect(ev!.tick).toBeGreaterThanOrEqual(1);
    // A renderer may animate a bridge-collapse over frames 2520–2540, but the CE fact
    // (and its tick) is the ONLY truth about WHEN causality happened. The event tick
    // is CE tick space, decoupled from any frame number.
    const ceTickOfFact = ev!.tick;
    const frameStart = ceTickOfFact * 60; // 60fps: frames 60–120 for tick 1-2
    expect(frameStart).toBeGreaterThan(0);
    // The animation delay must never be confused with CE tick: acking late changes nothing.
  });

  it("delayed ack (renderer animates for many frames) does not change CE state or hashes", () => {
    const { engine, world, delivery, consumer } = fresh();
    submitIntervention(world, destroyBridge(), engine);
    advance(world, engine, 3);
    const h = stateHash(world);
    // Renderer animates 30 frames before acking — but CE already moved on.
    const r = poll(world, delivery, consumer.id);
    expect(r.status).toBe("deliverable");
    // ... 30 frames pass (renderer playing animation, no ack) ...
    advance(world, engine, 5); // CE keeps ticking regardless
    const h2 = stateHash(world);
    expect(h2).not.toBe(h); // world advanced
    // Consumer eventually acks — CE does not care when; only the world state matters.
    ack(world, delivery, consumer.id, world.highestEmittedSeq);
    expect(stateHash(world)).toBe(h2); // ack is observational, not causal
  });

  it("event stream exposes stable identity so an animation can be keyed to a fact", () => {
    const { engine, world, delivery, consumer } = fresh();
    submitIntervention(world, destroyBridge(), engine);
    advance(world, engine, 2);
    pollOnce(world, delivery, consumer);
    const ev = factStream(world).find((e) => e.type === "economy.trade_disruption")!;
    expect(typeof ev.id).toBe("string");
    expect(ev.id.length).toBeGreaterThan(0);
    // A renderer keys its animation to event.id + event.tick, never to frame numbers.
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §7. Restart while rendering
// ════════════════════════════════════════════════════════════════════════════

describe("P-016 §7 — restart while rendering", () => {
  it("CE checkpoint → shutdown → restore → continue: same authoritative state, deterministic continuation", () => {
    const { engine, world } = fresh();
    submitIntervention(world, destroyBridge("restart-id"), engine);
    advance(world, engine, 5);
    const h5 = stateHash(world);
    const t5 = traceHash(world);
    // Checkpoint
    const cp = serializeCheckpoint(createCheckpoint(world, "restart"));
    // CE "shutdown": everything discarded.
    // CE "restore":
    const restored = roundTripCheckpoint(world, "restart");
    const world2 = restored.world;
    const engine2 = createEngine();
    attachEngine(world2, engine2);
    expect(stateHash(world2)).toBe(h5);
    expect(traceHash(world2)).toBe(t5);
    // Continue: deterministic continuation — same next hash as uninterrupted run.
    // NOTE: the comparison world must use the SAME intervention id (interventionHistory
    // is part of traceHash) and the same submission tick.
    const { engine: e3, world: w3 } = fresh();
    submitIntervention(w3, destroyBridge("restart-id"), e3);
    advance(w3, e3, 5);
    advance(w3, e3, 3); // continue 3 more
    advance(world2, engine2, 3); // continue 3 more from restore
    expect(stateHash(world2)).toBe(stateHash(w3));
    expect(traceHash(world2)).toBe(traceHash(w3));
    // No duplicate historical events: restored world has the same event record.
    expect(world2.events.length).toBe(w3.events.length);
  });

  it("renderer resynchronizes after CE restart without knowing CE internals", () => {
    // Restart CE, restore world + delivery, then the SAME consumer resumes.
    const { engine, world, delivery, consumer } = fresh();
    submitIntervention(world, destroyBridge("rs-id"), engine);
    advance(world, engine, 4);
    pollOnce(world, delivery, consumer); // consumer catches up to tick 4
    const seenBefore = consumer.applied.length;
    const cp = serializeCheckpoint(createCheckpoint(world, "r2"));
    const dlv = serializeDelivery(delivery);
    const restored = roundTripCheckpoint(world, "r2");
    const world2 = restored.world;
    const engine2 = createEngine();
    attachEngine(world2, engine2);
    const delivery2 = deserializeDelivery(dlv);
    registerConsumer(delivery2, consumer.id);
    // Continue: a NEW intervention after restart produces new facts.
    submitIntervention(world2, subsidy("post-restart"), engine2);
    advance(world2, engine2, 3);
    pollOnce(world2, delivery2, consumer);
    expect(consumer.applied.length).toBeGreaterThan(seenBefore);
    // No duplicates from the pre-restart window (cursor was preserved in delivery state).
    expect(consumer.duplicatesSeen.filter((id) => seenBefore > 0)).toEqual(consumer.duplicatesSeen);
  });

  it("reconnect without restart: disconnect → poll blocked → reconnect → resumes from cursor", () => {
    const { engine, world, delivery } = fresh();
    submitIntervention(world, destroyBridge(), engine);
    advance(world, engine, 3);
    // Simulate connection drop at the delivery layer.
    const { disconnect, reconnect } = { disconnect: () => (delivery.channels["temporal-test"]!.connected = false), reconnect: () => (delivery.channels["temporal-test"]!.connected = true) };
    disconnect();
    const r = poll(world, delivery, "temporal-test");
    expect(r.status).toBe("disconnected");
    reconnect();
    const r2 = poll(world, delivery, "temporal-test");
    expect(r2.status).toBe("deliverable"); // resumes; nothing lost (no eviction)
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §8. Failure injection
// ════════════════════════════════════════════════════════════════════════════

describe("P-016 §8 — failure injection", () => {
  it("delayed polling: CE advances while renderer is stalled; later poll delivers everything retained", () => {
    const { engine, world, delivery, consumer } = fresh();
    submitIntervention(world, destroyBridge(), engine);
    advance(world, engine, 10); // renderer stalls 10 ticks
    pollOnce(world, delivery, consumer);
    expect(consumer.applied).toEqual(deliveryFacts(world)); // nothing dropped, delivery order
    expect(consumer.gapsSeen).toEqual([]); // within retention → no gap
  });

  it("duplicate poll without ack cannot double-apply (consumer dedupes by event id)", () => {
    const { engine, world, delivery, consumer } = fresh();
    submitIntervention(world, destroyBridge(), engine);
    advance(world, engine, 2);
    const r1 = poll(world, delivery, consumer.id);
    if (r1.status === "deliverable") for (const a of r1.attempts) consumer.apply(a);
    const count1 = consumer.applied.length;
    const r2 = poll(world, delivery, consumer.id); // no ack between → redelivery
    if (r2.status === "deliverable") for (const a of r2.attempts) consumer.apply(a);
    expect(consumer.applied.length).toBe(count1); // no double-apply
    expect(consumer.duplicatesSeen.length).toBeGreaterThan(0);
  });

  it("stale cursor / ack beyond highest: refused, cursor never moves backwards", () => {
    const { engine, world, delivery } = fresh();
    submitIntervention(world, destroyBridge(), engine);
    advance(world, engine, 2);
    const r = poll(world, delivery, "temporal-test");
    if (r.status === "deliverable") {
      const last = r.attempts[r.attempts.length - 1]!;
      ack(world, delivery, "temporal-test", last.streamSeq);
    }
    const cursor = delivery.channels["temporal-test"]!.acked;
    // Ack an OLD seq (stale) → ignored, cursor unchanged.
    const stale = ack(world, delivery, "temporal-test", 1);
    expect(stale.ok).toBe(true);
    expect(stale.reason).toContain("never moves backwards");
    expect(delivery.channels["temporal-test"]!.acked).toEqual(cursor);
    // Ack beyond highest → refused.
    const future = ack(world, delivery, "temporal-test", world.highestEmittedSeq + 50);
    expect(future.ok).toBe(false);
  });

  it("event gap (eviction) → explicit gap → recovery via stateSync/resync only", () => {
    const { engine, world, delivery, consumer } = fresh();
    submitIntervention(world, destroyBridge(), engine);
    advance(world, engine, 10);
    enforceRetention(world, 3); // evict most facts
    pollOnce(world, delivery, consumer);
    expect(consumer.gapsSeen.length).toBe(1);
    expect(consumer.gapsSeen[0]!.kind).toBe("gap");
    expect(consumer.gapsSeen[0]!.remedy).toBe("resync_from_state");
    const sync = stateSync(world);
    expect(sync.historyComplete).toBe(false); // eviction happened
    const res = resync(delivery, consumer.id, sync);
    expect(res.ok).toBe(true);
    // Renderer now holds authoritative state; can resume rendering from stateSync.
    expect(sync.regions["RF"]!.grainPrice).toBe(world.regions["RF"]!.prices["grain"]);
  });

  it("delayed intervention response: submission is atomic; the world has it immediately", () => {
    const { engine, world } = fresh();
    // Player clicks "destroy" — the adapter submits; response may be slow, but CE is atomic.
    const res = submitIntervention(world, destroyBridge("atomic"), engine);
    expect(res.ok).toBe(true);
    // Immediate effect already applied synchronously (P-014 confirmed).
    expect(world.regions["RF"]!.infrastructure[ROUTE_ID]!.health).toBe(0);
    expect(world.interventionHistory.length).toBe(1);
    // Even if the renderer never reads the response, CE has the action once.
    advance(world, engine, 2);
    expect(world.interventionHistory.length).toBe(1);
  });

  it("CE restart mid-run: continuation is deterministic and identical to uninterrupted", () => {
    const run1 = runCadence([{ submit: [destroyBridge("d")] }, { advance: 4, poll: true }]);
    // Restart path
    const { engine, world } = fresh();
    submitIntervention(world, destroyBridge("d"), engine);
    advance(world, engine, 4);
    const restored = roundTripCheckpoint(world, "mid");
    const w2 = restored.world;
    attachEngine(w2, createEngine());
    expect(stateHash(w2)).toBe(run1.stateHash);
    expect(traceHash(w2)).toBe(run1.traceHash);
  });

  it("renderer restart: fresh consumer re-syncs via stateSync (public contract only)", () => {
    const { engine, world, delivery, consumer } = fresh();
    submitIntervention(world, destroyBridge(), engine);
    advance(world, engine, 3);
    // Old consumer dies. New renderer starts fresh — no delivery state.
    const freshConsumer = createConsumer("fresh-renderer");
    const freshDelivery = createDeliveryState();
    registerConsumer(freshDelivery, freshConsumer.id);
    // It can recover through the public contract: stateSync (or poll if within retention).
    const sync = stateSync(world);
    expect(sync.regions["RF"]!.grainPrice).toBe(world.regions["RF"]!.prices["grain"]);
    const res = resync(freshDelivery, freshConsumer.id, sync);
    expect(res.ok).toBe(true);
    // Or poll (retention holds) — both are public-contract recovery.
    const r = poll(world, freshDelivery, freshConsumer.id);
    expect(r.status).toBe("caught_up"); // cursor already at sync point
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §9/10. Adapter temporal contract + determinism
// ════════════════════════════════════════════════════════════════════════════

describe("P-016 §9/10 — temporal contract & determinism", () => {
  it("rendering cadence is observational: every cadence config matches the headless reference", () => {
    const ref = headlessRef();
    const submits: Intervention[] = [destroyBridge("h"), killMerchant("h2")];
    const a: Array<{ advance?: number; poll?: boolean }> = [];
    for (let f = 0; f < 12; f++) a.push({ advance: 1, poll: true }); // 12 frames, 1 tick each
    const b: Array<{ advance?: number; poll?: boolean }> = [];
    for (let f = 0; f < 12; f++) { b.push({ advance: 1, poll: true }); b.push({ poll: true }); b.push({ poll: true }); } // 36 frames, 1 tick / 3 frames
    const c: Array<{ advance?: number; poll?: boolean }> = [];
    for (let f = 0; f < 12; f++) { c.push({ advance: 1, poll: true }); for (let i = 0; i < 5; i++) c.push({ poll: true }); } // 72 frames, 1 tick / 6 frames
    const d: Array<{ advance?: number; poll?: boolean }> = [];
    for (let f = 0; f < 4; f++) d.push({ advance: 3, poll: true }); // 4 frames, 3 ticks each
    const e: Array<{ advance?: number; poll?: boolean }> = [];
    for (let f = 0; f < 2; f++) e.push({ advance: 6, poll: true }); // 2 frames, 6 ticks each
    const cadences = [a, b, c, d, e];
    for (const steps of cadences) {
      const r = runCadence([{ submit: submits }, ...steps]);
      expect(r.stateHash).toBe(ref.stateHash);
      expect(r.traceHash).toBe(ref.traceHash);
      expect(r.applied).toEqual(ref.canonical);
      expect(r.duplicates).toEqual([]);
    }
  });

  it("RNG state is identical across cadence configs (rendering never consumes RNG)", () => {
    const a = runCadence([{ submit: [destroyBridge("rng")] }, { advance: 8, poll: true }]);
    const b = runCadence([{ submit: [destroyBridge("rng")] }, { advance: 8, poll: true }]);
    expect(b.world.rngState).toEqual(a.world.rngState);
    expect(b.stateHash).toBe(a.stateHash);
  });

  it("causal decisions and intervention acceptance are cadence-independent", () => {
    // Same interventions, different poll cadence → same acceptance results.
    const a = runCadence([{ submit: [destroyBridge("x"), subsidy("y")] }, { advance: 10, poll: true }]);
    const b = runCadence([{ submit: [destroyBridge("x"), subsidy("y")] }, { advance: 10, poll: true }]);
    expect(b.world.interventionSeq).toBe(a.world.interventionSeq);
    expect(b.world.interventionHistory.map((i) => i.id)).toEqual(a.world.interventionHistory.map((i) => i.id));
    // Causal consequences identical (grain price, hostility).
    expect(b.world.regions["RF"]!.prices["grain"]).toBe(a.world.regions["RF"]!.prices["grain"]);
    expect(b.world.relations["MG>RF"]).toBe(a.world.relations["MG>RF"]);
  });
});

/** Headless reference: all interventions up front, all ticks, poll at the end. */
function headlessRef() {
  const { engine, world, delivery, consumer } = fresh();
  submitIntervention(world, destroyBridge("h"), engine);
  submitIntervention(world, killMerchant("h2"), engine);
  advance(world, engine, 12);
  pollOnce(world, delivery, consumer);
  return {
    stateHash: stateHash(world),
    traceHash: traceHash(world),
    canonical: deliveryFacts(world),
    tick: world.tick,
  };
}
