/**
 * P-018: First Playable Vertical Slice — determinism, persistence, failure injection
 * (CE API level; one-town RF scenario; seed 42).
 *
 * THE SCENARIO — the vertical slice the game will actually run on day one:
 *   seed 42. Two interventions at tick 0, BEFORE any advance, in this exact order:
 *     1. destroy_infrastructure on grain_road (RF)   — bridge destroyed → trade blocked
 *     2. grant_merchant_subsidy (RF)                 — the competing (relieving) cause
 *   then advance 10 ticks and poll once with a harness consumer.
 *
 * WHAT THIS FILE PROVES, in four sections:
 *   §1 determinism       — the scenario is a pure function of (seed, script, tick count).
 *                          Advance chunking and polling cadence are observational.
 *   §2 causal substance  — the slice produces the intended causal chain (price shock;
 *                          explain() resolves grain price and MG hostility to the
 *                          destroy_infrastructure intervention).
 *   §3 persistence       — checkpoint/restore and delivery-cursor round-trips resume
 *                          byte-identically, with no duplicated event application.
 *   §4 failure injection — never-ack + retention eviction → explicit gap → stateSync/resync
 *                          recovery; fresh-consumer redelivery with id-based dedupe;
 *                          rejected interventions leave state/trace/seq untouched.
 *
 * Run: npx vitest run src/poc/vertical-slice.test.ts
 */
import { describe, it, expect } from "vitest";
import {
  createEngine, createWorld, submitIntervention, advance,
  stateHash, traceHash,
  createCheckpoint, serializeCheckpoint, deserializeCheckpoint,
  validateCheckpoint, restoreCheckpoint, attachEngine,
  makeConfig,
  poll, stateSync, resync,
  createDeliveryState, registerConsumer,
  serializeDelivery, deserializeDelivery,
  enforceRetention,
  explain,
  factStream,
  type WorldState, type Intervention, type DeliveryState,
} from "../api/public.js";
import { ROUTE_ID, WORLD_SEED } from "../game/content.js";
import { key } from "../core/provenance.js";
import { createConsumer, pump, type HarnessConsumer } from "../core/delivery.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** A fresh engine + world + delivery + harness consumer. Seed overridable (controls). */
function fresh(seed = WORLD_SEED, consumerId = "slice-harness") {
  const engine = createEngine();
  const world = createWorld(makeConfig({ seed }), engine);
  const delivery = createDeliveryState();
  const consumer = createConsumer(consumerId);
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

function sliceDestroy(id = "sli-destroy"): Intervention {
  return iv(id, "destroy_infrastructure", { type: "infrastructure", id: ROUTE_ID }, "RF");
}

function sliceSubsidy(id = "sli-subsidy"): Intervention {
  return iv(id, "grant_merchant_subsidy", { type: "region", id: "RF" }, "RF");
}

/** The exact vertical-slice script: destroy the road, then subsidise — both at tick 0. */
function sliceScript(): Intervention[] {
  return [sliceDestroy(), sliceSubsidy()];
}

/** Poll once, apply to consumer (dedupe-aware), ack. Returns the pump result. */
function pollOnce(state: WorldState, delivery: DeliveryState, consumer: HarnessConsumer) {
  return pump(state, delivery, consumer);
}

/** Collect the applied event ids from a consumer in application order. */
function appliedIds(c: HarnessConsumer): string[] {
  return [...c.applied];
}

/** DELIVERY order — ascending streamSeq, the order `poll()` hands facts to a consumer. */
function deliveryFacts(state: WorldState) {
  return factStream(state)
    .slice()
    .sort((a, b) => a.streamSeq - b.streamSeq)
    .map((e) => e.id);
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

interface SliceRunOptions {
  seed?: number;
  /** Advance chunk sizes, applied in order. Default [10]. */
  chunks?: number[];
  /** "end" (default) polls once after all ticks; "each" polls after every chunk. */
  poll?: "end" | "each";
}

/**
 * Run the vertical-slice scenario end-to-end: script at tick 0, then `chunks` advances,
 * then (depending on cadence) one or more polls. Returns hashes + what the consumer saw.
 */
function runScenario(opts: SliceRunOptions = {}) {
  const seed = opts.seed ?? WORLD_SEED;
  const chunks = opts.chunks ?? [10];
  const { engine, world, delivery, consumer } = fresh(seed, "slice-run");
  for (const i of sliceScript()) submitIntervention(world, i, engine);
  for (const c of chunks) {
    advance(world, engine, c);
    if (opts.poll === "each") pollOnce(world, delivery, consumer);
  }
  if (opts.poll !== "each") pollOnce(world, delivery, consumer);
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

// ════════════════════════════════════════════════════════════════════════════
// §1. Vertical-slice determinism
// ════════════════════════════════════════════════════════════════════════════

describe("P-018 §1 — vertical-slice determinism", () => {
  it("two fresh runs of the vertical slice are byte-identical (stateHash + traceHash)", () => {
    const a = runScenario();
    const b = runScenario();
    expect(b.stateHash).toBe(a.stateHash);
    expect(b.traceHash).toBe(a.traceHash);
    expect(b.tick).toBe(a.tick);
  });

  it("advance chunking is a pure loop: 1x10, 2x5 and 10x1 produce identical worlds", () => {
    const big = runScenario({ chunks: [10] });
    const two = runScenario({ chunks: [5, 5] });
    const one = runScenario({ chunks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] });
    expect(two.stateHash).toBe(big.stateHash);
    expect(two.traceHash).toBe(big.traceHash);
    expect(one.stateHash).toBe(big.stateHash);
    expect(one.traceHash).toBe(big.traceHash);
  });

  it("polling cadence is observational: same world and the same event-id set", () => {
    const atEnd = runScenario({ poll: "end" });
    const eachTick = runScenario({ poll: "each" });
    expect(eachTick.stateHash).toBe(atEnd.stateHash);
    expect(eachTick.traceHash).toBe(atEnd.traceHash);
    // Both consumers observe exactly the same canonical event-id set, in delivery order.
    expect(eachTick.applied).toEqual(atEnd.applied);
    expect(atEnd.applied).toEqual(deliveryFacts(atEnd.world));
    expect(atEnd.applied.length).toBeGreaterThan(0);
  });

  it("different-seed control: seed 43 diverges from seed 42 and is internally deterministic", () => {
    const s42 = runScenario({ seed: 42 });
    const s43a = runScenario({ seed: 43 });
    const s43b = runScenario({ seed: 43 });
    // RNG is consumed every tick (population heartbeat), so the seed changes the world.
    expect(s43a.stateHash).not.toBe(s42.stateHash);
    // The control run is itself deterministic.
    expect(s43b.stateHash).toBe(s43a.stateHash);
    expect(s43b.traceHash).toBe(s43a.traceHash);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §2. Causal chain substance
// ════════════════════════════════════════════════════════════════════════════

describe("P-018 §2 — causal chain substance", () => {
  it("RF grain price is shocked above the base price of 10 (bridge destroyed → price shock)", () => {
    const { world } = runScenario();
    // The road is actually gone...
    expect(world.regions["RF"]!.infrastructure[ROUTE_ID]!.health).toBe(0);
    // ...and the importing town's grain price has cleared its base of 10.
    expect(world.regions["RF"]!.prices["grain"]!).toBeGreaterThan(10);
  });

  it("explain(RF grain price) is explained and rooted in the destroy_infrastructure intervention", () => {
    const { world } = runScenario();
    const ex = explain(world, key.price("RF", "grain"));
    expect(ex.explained).toBe(true);
    expect(ex.roots.some((r) => r.action === "destroy_infrastructure")).toBe(true);
    expect(ex.paths.length).toBeGreaterThan(0);
  });

  it("explain(MG hostility) returns a well-formed explanation — finding: it IS explained", () => {
    const { world } = runScenario();
    const ex = explain(world, key.hostility("MG"));
    // Explanation object shape (the API contract to hold stable).
    expect(ex.target).toBe("MG:hostility");
    expect(Array.isArray(ex.roots)).toBe(true);
    expect(Array.isArray(ex.nodes)).toBe(true);
    expect(Array.isArray(ex.paths)).toBe(true);
    expect(typeof ex.explained).toBe("boolean");
    // Finding (verified empirically, seed 42 after 10 ticks): MG:hostility does NOT come
    // back unexplained — the destroy_infrastructure intervention is a proven root of the
    // hostility chain, so the slice's causal story closes end to end.
    expect(ex.explained || ex.roots.length > 0).toBe(true);
    expect(ex.explained).toBe(true);
    expect(ex.roots.some((r) => r.action === "destroy_infrastructure")).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §3. Persistence round-trip
// ════════════════════════════════════════════════════════════════════════════

describe("P-018 §3 — persistence round-trip", () => {
  it("checkpoint at tick 5 → shutdown → restore → hashes equal pre-shutdown", () => {
    const { engine, world } = fresh();
    for (const i of sliceScript()) submitIntervention(world, i, engine);
    advance(world, engine, 5);
    const h5 = stateHash(world);
    const t5 = traceHash(world);
    // "Shutdown": discard the world; "restore": rebuild from the checkpoint envelope.
    const world2 = roundTripCheckpoint(world, "slice").world;
    attachEngine(world2, createEngine());
    expect(stateHash(world2)).toBe(h5);
    expect(traceHash(world2)).toBe(t5);
  });

  it("restored world continues identically to an uninterrupted 10-tick run", () => {
    // Uninterrupted reference: script at tick 0, advance 10 in one call.
    const ref = runScenario({ chunks: [10] });
    // Restart path: run to tick 5, checkpoint/restore, then continue 5 more.
    const { engine, world } = fresh();
    for (const i of sliceScript()) submitIntervention(world, i, engine);
    advance(world, engine, 5);
    const world2 = roundTripCheckpoint(world, "slice").world;
    const engine2 = attachEngine(world2, createEngine());
    advance(world2, engine2, 5);
    expect(stateHash(world2)).toBe(ref.stateHash);
    expect(traceHash(world2)).toBe(ref.traceHash);
    expect(world2.events.length).toBe(ref.world.events.length);
  });

  it("delivery cursor round-trip: consumer resumes without duplicates and keeps receiving new facts", () => {
    const { engine, world, delivery, consumer } = fresh();
    for (const i of sliceScript()) submitIntervention(world, i, engine);
    advance(world, engine, 5);
    pollOnce(world, delivery, consumer); // consumer is current through tick 5
    const seenAt5 = appliedIds(consumer);
    expect(seenAt5.length).toBeGreaterThan(0);

    // Persist BOTH the world and the delivery cursor; "reboot".
    const dlv = serializeDelivery(delivery);
    const world2 = roundTripCheckpoint(world, "slice").world;
    const engine2 = attachEngine(world2, createEngine());
    const delivery2 = deserializeDelivery(dlv);
    registerConsumer(delivery2, consumer.id);

    // Resume: a NEW intervention after restore must deliver new facts and never redeliver
    // the pre-save window (the saved cursor prevents it).
    submitIntervention(world2, sliceSubsidy("sli-post-cursor"), engine2);
    advance(world2, engine2, 3);
    const r = pollOnce(world2, delivery2, consumer);
    expect(r.status).toBe("deliverable");
    const seenAfter = appliedIds(consumer);
    expect(seenAfter.length).toBeGreaterThan(seenAt5.length);
    // No event id applied twice: unique ids, no redelivery of the pre-save window.
    expect(new Set(seenAfter).size).toBe(seenAfter.length);
    expect(consumer.duplicatesSeen).toEqual([]);
    expect(seenAfter.slice(0, seenAt5.length)).toEqual(seenAt5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §4. Failure injection (transport-level semantics, in-process)
// ════════════════════════════════════════════════════════════════════════════

describe("P-018 §4 — failure injection", () => {
  it("never-ack consumer + retention eviction → explicit gap → stateSync/resync recovery → new facts", () => {
    const { engine, world, delivery, consumer } = fresh();
    for (const i of sliceScript()) submitIntervention(world, i, engine);
    advance(world, engine, 10);

    // Consumer polls but NEVER acks — its cursor stays at 0.
    const first = poll(world, delivery, consumer.id);
    expect(first.status).toBe("deliverable");
    for (const a of first.attempts) consumer.apply(a);
    const before = consumer.applied.length;
    expect(before).toBeGreaterThan(0);

    // The retention bound evicts the facts the cursor still needs → explicit GAP.
    enforceRetention(world, 5);
    const second = poll(world, delivery, consumer.id);
    if (second.status !== "gap") {
      throw new Error("expected a retention gap, got: " + second.status);
    }
    expect(second.gap.remedy).toBe("resync_from_state");
    expect(consumer.applied.length).toBe(before); // nothing applied across a gap

    // Recovery through the public contract: level sync + resync reposition the cursor.
    const sync = stateSync(world);
    expect(sync.historyComplete).toBe(false); // eviction means history is incomplete
    expect(resync(delivery, consumer.id, sync).ok).toBe(true);

    // Post-resync activity produces NEW facts that are delivered normally.
    submitIntervention(world, sliceSubsidy("sli-post-resync"), engine);
    advance(world, engine, 2);
    const r = pollOnce(world, delivery, consumer);
    expect(r.status).toBe("deliverable");
    expect(consumer.applied.length).toBeGreaterThan(before);
  });

  it("fresh consumer on the same world receives retained events; redelivery dedupes by event id", () => {
    const { engine, world } = fresh();
    for (const i of sliceScript()) submitIntervention(world, i, engine);
    advance(world, engine, 10);

    // "Reconnect without restart": a brand-new delivery state + consumer, same world.
    const delivery2 = createDeliveryState();
    const consumer2 = createConsumer("slice-reconnect");
    registerConsumer(delivery2, consumer2.id);
    const r1 = poll(world, delivery2, consumer2.id);
    expect(r1.status).toBe("deliverable");
    for (const a of r1.attempts) consumer2.apply(a);
    const first = consumer2.applied.length;
    expect(first).toBeGreaterThan(0);

    // At-least-once: without an ack the same retained events are redelivered...
    const r2 = poll(world, delivery2, consumer2.id);
    expect(r2.status).toBe("deliverable");
    for (const a of r2.attempts) consumer2.apply(a);
    // ...and the consumer dedupes by stable event id: nothing is applied twice.
    expect(consumer2.applied.length).toBe(first);
    expect(consumer2.duplicatesSeen.length).toBeGreaterThan(0);
  });

  it("a rejected re-destroy changes nothing: stateHash, traceHash and interventionSeq are stable", () => {
    const { engine, world, delivery, consumer } = fresh();
    for (const i of sliceScript()) submitIntervention(world, i, engine);
    advance(world, engine, 10);
    pollOnce(world, delivery, consumer); // drain the stream once (baseline)
    const h1 = stateHash(world);
    const t1 = traceHash(world);
    const seq1 = world.interventionSeq;
    const appliedBefore = appliedIds(consumer);

    // The road is already destroyed → this second destroy must be REJECTED.
    const res = submitIntervention(world, sliceDestroy("sli-destroy-again"), engine);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain("already destroyed");
    expect(world.interventionSeq).toBe(seq1);
    expect(stateHash(world)).toBe(h1);
    expect(traceHash(world)).toBe(t1);
    // And it never surfaces as a causal event for the consumer.
    pollOnce(world, delivery, consumer);
    expect(appliedIds(consumer)).toEqual(appliedBefore);
    expect(consumer.duplicatesSeen).toEqual([]);
  });
});
