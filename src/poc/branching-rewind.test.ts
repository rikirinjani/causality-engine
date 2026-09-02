/**
 * P-020: Branching/Rewind as a Gameplay Mechanic — Adversarial Verification
 *
 * ATTACKS the branching/rewind semantics (docs/RECONNAISSANCE.md §17.4–§17.6) as a
 * gameplay mechanic: a player saves (checkpoint), rewinds, forks, and expects the
 * engine to keep every timeline honest, isolated, deterministic and addressable.
 *
 * Predictions under test (P1–P10) and the attack matrix (§11):
 *   P1  exact rewind + identical replay reproduces physics, NOT identity
 *   P2  an alternate branch diverges in physics while sharing ancestry
 *   P3  post-fork timelines are isolated: no event/hash/history leakage
 *   P4  forking the same checkpoint with the same discriminator is deterministic
 *   P5  branch identity survives physics convergence (lineage is hashed)
 *   P6  interventionsAfter() names exactly the abandoned future; a fork inherits none
 *   P7  event identity is timeline-scoped: same content, different timelines, different ids
 *   P8  branch explanations cite both its own post-fork causes and shared pre-fork causes
 *   P9  rewind and fork produce different lineage structures (abandoned vs sibling)
 *   P10 convergent branches stay independently addressable — the engine never collapses them
 *
 * Load-bearing facts (from the code, not contradicted here):
 *   - Lineage lives INSIDE WorldState and is covered by stateHash.
 *   - Timeline ids are content-derived: the same fork twice yields the same id.
 *   - DeliveryState lives OUTSIDE WorldState; poll/resync carry wrong_timeline guards.
 *   - Event id = f(timelineId, tick, ordinal, type, region, payload).
 *
 * Run: npx vitest run src/poc/branching-rewind.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  advance,
  attachEngine,
  createEngine,
  createWorld,
  submitIntervention,
  stateHash,
  traceHash,
  createCheckpoint,
  serializeCheckpoint,
  deserializeCheckpoint,
  validateCheckpoint,
  restoreCheckpoint,
  factStream,
  explain,
  key,
  createDeliveryState,
  registerConsumer,
  poll,
  ack,
  forkTimeline,
  rewindTo,
  interventionsAfter,
  replayAbandoned,
  checkpoint,
  makeConfig,
  type WorldState,
  type Intervention,
  type DeliveryState,
} from "../api/public.js";
import { noteDivergence } from "../core/timeline.js";
import { ancestryOf } from "../core/genealogy.js";
import { createConsumer, pump, type HarnessConsumer } from "../core/delivery.js";
import { ROUTE_ID, WORLD_SEED } from "../game/content.js";

// ── Helpers (patterns from temporal-boundary.test.ts) ─────────────────────

function fresh() {
  const engine = createEngine();
  const world = createWorld(makeConfig({ seed: WORLD_SEED }), engine);
  const delivery = createDeliveryState();
  const consumer = createConsumer("branching-rewind-test");
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
  return pump(state, delivery, consumer);
}

/** Collect the applied event ids from a consumer in application order. */
function appliedIds(c: HarnessConsumer): string[] {
  return [...c.applied];
}

/** The canonical consumer-fact stream at a moment in time, in delivery (streamSeq) order. */
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

/**
 * PHYSICS-ONLY hash: stateHash with every lineage field normalised away. Two worlds with
 * identical physics but different ancestry must compare equal here and DIFFER in stateHash.
 */
function physicalHash(w: WorldState): string {
  const c = structuredClone(w);
  c.lineage = {
    ...c.lineage,
    timelineId: "T-x",
    origin: "genesis",
    parentTimelineId: null,
    parentCheckpointId: null,
    forkTick: null,
    divergenceInterventionIds: [],
    abandonedTimelines: [],
    generation: 0,
  };
  return stateHash(c);
}

/**
 * The P-020 standard scenario:
 *   seed 42, I1=destroyBridge, advance 2, I2=subsidy, advance 2, checkpoint C,
 *   I3=rally, advance 2, I4=killMerchant, advance 2  →  world at tick 8, C at tick 4.
 */
function buildScenario() {
  const { engine, world } = fresh();
  submitIntervention(world, destroyBridge("I1"), engine);
  advance(world, engine, 2);
  submitIntervention(world, subsidy("I2"), engine);
  advance(world, engine, 2);
  const C = checkpoint(world, "C");
  submitIntervention(world, rally("I3"), engine);
  advance(world, engine, 2);
  submitIntervention(world, killMerchant("I4"), engine);
  advance(world, engine, 2);
  return { world, engine, C };
}

// ════════════════════════════════════════════════════════════════════════════
// §1. P1 — exact rewind reproduces physics, not identity
// ════════════════════════════════════════════════════════════════════════════

describe("P-020 §1 — P1 exact rewind", () => {
  it("rewind + identical replay reproduces physics exactly; stateHash/traceHash differ (lineage hashed)", () => {
    const { world, C } = buildScenario();
    const origPrice = world.regions["RF"]!.prices["grain"]!;
    const origHostility = world.relations["MG>player"]!;
    const origState = stateHash(world);
    const origTrace = traceHash(world);
    const origRng = world.rngState.s;
    const origTimeline = world.lineage.timelineId;

    const rw = rewindTo(C, world);
    expect(rw.ok).toBe(true);
    if (!rw.ok) return;

    // replay I3, I4 identically (submit + advance 2 each)
    submitIntervention(rw.value.world, rally("I3"), rw.value.engine);
    advance(rw.value.world, rw.value.engine, 2);
    submitIntervention(rw.value.world, killMerchant("I4"), rw.value.engine);
    advance(rw.value.world, rw.value.engine, 2);

    // PHYSICS identical — the load-bearing claim
    expect(rw.value.world.regions["RF"]!.prices["grain"]).toBe(origPrice);
    expect(rw.value.world.relations["MG>player"]).toBe(origHostility);
    expect(rw.value.world.rngState.s).toBe(origRng);
    expect(physicalHash(rw.value.world)).toBe(physicalHash(world));

    // IDENTITY differs — lineage is hashed
    const stateDiffers = stateHash(rw.value.world) !== origState;
    const traceMatches = traceHash(rw.value.world) === origTrace;
    console.log(
      `[P1] exact rewind+replay: physics equal (price ${origPrice}, hostility ${origHostility}, rng ${origRng}); ` +
        `stateHash differs=${stateDiffers}; traceHash matches=${traceMatches} ` +
        `(traceHash differs because events are timeline-scoped: event id = f(timelineId, tick, ordinal, content))`,
    );
    expect(stateDiffers).toBe(true);
    expect(traceMatches).toBe(false);

    // the rewound world is a NEW timeline descended from the abandoned one
    expect(rw.value.world.lineage.origin).toBe("rewind");
    expect(rw.value.world.lineage.parentTimelineId).toBe(origTimeline);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §2. P2 — alternate branch diverges in physics, shares ancestry
// ════════════════════════════════════════════════════════════════════════════

describe("P-020 §2 — P2 alternate branch", () => {
  it("a branch with different interventions diverges from the parent but shares lineage ancestry", () => {
    const { world, engine, C } = buildScenario();

    // parent continues I3 → tick → I4 → tick
    submitIntervention(world, rally("I3"), engine);
    advance(world, engine, 2);
    submitIntervention(world, killMerchant("I4"), engine);
    advance(world, engine, 2);
    const parentPrice = world.regions["RF"]!.prices["grain"]!;

    // branch: I3'=subsidy → tick → I4'=rally → tick
    const f = forkTimeline(C, "B");
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    const i3p = subsidy("I3p");
    const i4p = rally("I4p");
    submitIntervention(f.value.world, i3p, f.value.engine);
    advance(f.value.world, f.value.engine, 2);
    submitIntervention(f.value.world, i4p, f.value.engine);
    advance(f.value.world, f.value.engine, 2);
    noteDivergence(f.value.world, [i3p, i4p]);

    // physics diverge
    expect(f.value.world.regions["RF"]!.prices["grain"]).not.toBe(parentPrice);

    // lineage shares worldId, parentTimelineId, parentCheckpointId, forkTick with the parent
    const bl = f.value.world.lineage;
    expect(bl.worldId).toBe(world.lineage.worldId);
    expect(bl.parentTimelineId).toBe(world.lineage.timelineId);
    expect(bl.parentCheckpointId).toBe(C.identity.checkpointId);
    expect(bl.forkTick).toBe(C.identity.tick);
    expect(bl.origin).toBe("fork");
    expect(bl.divergenceInterventionIds).toEqual(["I3p", "I4p"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §3. P3 — timeline isolation
// ════════════════════════════════════════════════════════════════════════════

describe("P-020 §3 — P3 timeline isolation", () => {
  it("post-fork events, hashes and intervention histories never cross timelines", () => {
    const { world, engine, C } = buildScenario();
    const f = forkTimeline(C, "iso");
    expect(f.ok).toBe(true);
    if (!f.ok) return;

    const parentHashAtFork = stateHash(world);
    // advance the branch first (with an intervention)
    submitIntervention(f.value.world, subsidy("B1"), f.value.engine);
    advance(f.value.world, f.value.engine, 5);
    expect(stateHash(world)).toBe(parentHashAtFork); // parent untouched by branch activity

    const branchHashAfterBranch = stateHash(f.value.world);
    // advance the parent (with a different intervention)
    submitIntervention(world, rally("P1"), engine);
    advance(world, engine, 5);
    expect(stateHash(f.value.world)).toBe(branchHashAfterBranch); // branch untouched by parent activity

    // post-fork events are disjoint by id (event identity is timeline-scoped)
    const parentPostFork = new Set(factStream(world).filter((e) => e.tick > C.identity.tick).map((e) => e.id));
    const branchPostFork = new Set(factStream(f.value.world).filter((e) => e.tick > C.identity.tick).map((e) => e.id));
    for (const id of parentPostFork) expect(branchPostFork.has(id)).toBe(false);
    for (const id of branchPostFork) expect(parentPostFork.has(id)).toBe(false);

    // the branch's interventionHistory contains only its own post-fork interventions
    const branchPostIv = f.value.world.interventionHistory
      .filter((i) => i.provenance.sequence > C.world.interventionSeq)
      .map((i) => i.id);
    expect(branchPostIv).toEqual(["B1"]);
    expect(f.value.world.interventionHistory.map((i) => i.id)).not.toContain("P1");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §4. P4 — deterministic branch replay
// ════════════════════════════════════════════════════════════════════════════

describe("P-020 §4 — P4 deterministic branch replay", () => {
  it("forking the same checkpoint with the same discriminator twice yields identical worlds", () => {
    const { C } = buildScenario();
    const a = forkTimeline(C, "X");
    const b = forkTimeline(C, "X");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(a.value.timelineId).toBe(b.value.timelineId);

    // advance both identically
    submitIntervention(a.value.world, subsidy("s"), a.value.engine);
    submitIntervention(b.value.world, subsidy("s"), b.value.engine);
    advance(a.value.world, a.value.engine, 6);
    advance(b.value.world, b.value.engine, 6);

    expect(stateHash(a.value.world)).toBe(stateHash(b.value.world));
    expect(traceHash(a.value.world)).toBe(traceHash(b.value.world));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §5. P5 — branch identity survives convergence
// ════════════════════════════════════════════════════════════════════════════

describe("P-020 §5 — P5 branch identity", () => {
  it("two branches converging to the same physics still have distinct identity", () => {
    const { C } = buildScenario();
    const runOrder = (label: string, order: Intervention[]) => {
      const f = forkTimeline(C, label);
      if (!f.ok) throw new Error("fork failed");
      for (const i of order) submitIntervention(f.value.world, i, f.value.engine);
      advance(f.value.world, f.value.engine, 20);
      return f.value.world;
    };
    // different intervention sequences that CONVERGE to the same effective physics
    const a = runOrder("conv-a", [subsidy("s1"), rally("r1")]);
    const b = runOrder("conv-b", [rally("r1"), subsidy("s1")]);

    // identity relationships that MUST hold regardless of convergence
    expect(a.lineage.timelineId).not.toBe(b.lineage.timelineId);
    expect(stateHash(a)).not.toBe(stateHash(b)); // lineage is hashed — the load-bearing claim
    expect(traceHash(a)).not.toBe(traceHash(b));

    // measured: does the construction actually converge?
    const physicsEqual = physicalHash(a) === physicalHash(b);
    const priceEqual = a.regions["RF"]!.prices["grain"] === b.regions["RF"]!.prices["grain"];
    console.log(
      `[P5] convergent construction (subsidy→rally vs rally→subsidy): physics equal=${physicsEqual}, ` +
        `grain price equal=${priceEqual} (${a.regions["RF"]!.prices["grain"]} vs ${b.regions["RF"]!.prices["grain"]}); ` +
        `stateHash differs=${stateHash(a) !== stateHash(b)} DESPITE convergence — lineage is hashed`,
    );
    expect(physicsEqual).toBe(true);
    expect(priceEqual).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §6. P6 — abandoned future
// ════════════════════════════════════════════════════════════════════════════

describe("P-020 §6 — P6 abandoned future", () => {
  it("interventionsAfter names exactly the post-checkpoint interventions; a fork inherits none", () => {
    const { world, C } = buildScenario();

    const after = interventionsAfter(C, world).map((i) => i.id);
    expect(after).toEqual(["I3", "I4"]);

    const f = forkTimeline(C, "B6");
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    const branchIds = f.value.world.interventionHistory.map((i) => i.id);
    expect(branchIds).toEqual(["I1", "I2"]);
    expect(branchIds).not.toContain("I3");
    expect(branchIds).not.toContain("I4");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §7. P7 — event identity is timeline-scoped
// ════════════════════════════════════════════════════════════════════════════

describe("P-020 §7 — P7 event identity", () => {
  it("the same-content event on two timelines gets different ids", () => {
    // minimal build: settle to tick 4, checkpoint, then both timelines destroy the SAME bridge
    const engine = createEngine();
    const world = createWorld(makeConfig({ seed: WORLD_SEED }), engine);
    advance(world, engine, 4);
    const C = checkpoint(world, "C");

    const f = forkTimeline(C, "ev7");
    expect(f.ok).toBe(true);
    if (!f.ok) return;

    submitIntervention(world, destroyBridge("same"), engine);
    advance(world, engine, 2);
    submitIntervention(f.value.world, destroyBridge("same"), f.value.engine);
    advance(f.value.world, f.value.engine, 2);

    const parentEv = world.events.filter((e) => e.tick > C.identity.tick && e.type === "economy.trade_disruption");
    const branchEv = f.value.world.events.filter((e) => e.tick > C.identity.tick && e.type === "economy.trade_disruption");
    expect(parentEv.length).toBeGreaterThan(0);
    expect(branchEv.length).toBeGreaterThan(0);

    const p = parentEv[0]!;
    const b = branchEv[0]!;
    // same content (type, region, tick, payload) — only identity differs
    const { id: pid, ...prest } = p;
    const { id: bid, ...brest } = b;
    expect(JSON.stringify(prest)).toBe(JSON.stringify(brest));
    expect(pid).not.toBe(bid);
    console.log(`[P7] same-content event (${p.type} @ tick ${p.tick}): parent id=${pid}, branch id=${bid} — timeline-scoped identity`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §8. P8 — provenance preserves shared ancestry
// ════════════════════════════════════════════════════════════════════════════

describe("P-020 §8 — P8 provenance", () => {
  it("branch explanations cite both its own post-fork causes and the shared pre-fork destroy", () => {
    const { C } = buildScenario();
    const f = forkTimeline(C, "prov");
    expect(f.ok).toBe(true);
    if (!f.ok) return;

    // subsidy + killMerchant together: the combined economy pressure fires the resolution,
    // so the branch's own post-fork causes reach the price ancestry alongside the pre-fork destroy.
    const i3p = subsidy("I3p");
    const i4p = killMerchant("I4p");
    submitIntervention(f.value.world, i3p, f.value.engine);
    submitIntervention(f.value.world, i4p, f.value.engine);
    advance(f.value.world, f.value.engine, 6);

    const ex = explain(f.value.world, key.price("RF", "grain"));
    expect(ex.explained).toBe(true);
    const rootIds = ex.roots.map((r) => r.interventionId);
    expect(rootIds).toContain("I1"); // shared pre-fork destroy — shared ancestry preserved
    expect(rootIds).toContain("I3p"); // branch's own post-fork subsidy
    expect(rootIds).toContain("I4p"); // branch's own post-fork kill
    console.log(`[P8] branch price roots: [${rootIds.join(", ")}] — shared pre-fork destroy AND branch post-fork causes both present`);
  });

  it("a branch subsidy applied ALONE does not reach the price roots (measured deviation from the naive prediction)", () => {
    const { C } = buildScenario();
    const f = forkTimeline(C, "prov-alone");
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    submitIntervention(f.value.world, subsidy("I3p"), f.value.engine);
    advance(f.value.world, f.value.engine, 6);

    const ex = explain(f.value.world, key.price("RF", "grain"));
    expect(ex.explained).toBe(true);
    const rootIds = ex.roots.map((r) => r.interventionId);
    expect(rootIds).toContain("I1"); // shared ancestry preserved regardless
    console.log(
      `[P8] subsidy ALONE: price roots = [${rootIds.join(", ")}]; the branch subsidy is NOT a root because its ` +
        `economy relief (0.4) is below the 0.6 resolution threshold and never fires alone — ` +
        `the load-bearing claim (shared pre-fork ancestry) still holds`,
    );
  });

  it("a parent explanation is not polluted by branch activity", () => {
    const { world, engine, C } = buildScenario();
    const f = forkTimeline(C, "prov-parent");
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    // branch does a lot of its own thing
    submitIntervention(f.value.world, subsidy("I3p"), f.value.engine);
    submitIntervention(f.value.world, killMerchant("I4p"), f.value.engine);
    advance(f.value.world, f.value.engine, 10);
    // parent continues its own history
    submitIntervention(world, rally("I3"), engine);
    advance(world, engine, 2);
    submitIntervention(world, killMerchant("I4"), engine);
    advance(world, engine, 2);

    const ex = explain(world, key.price("RF", "grain"));
    expect(ex.explained).toBe(true);
    const rootIds = ex.roots.map((r) => r.interventionId);
    expect(rootIds).toContain("I1");
    expect(rootIds).not.toContain("I3p");
    expect(rootIds).not.toContain("I4p");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §9. P9 — rewind vs fork produce different lineage structures
// ════════════════════════════════════════════════════════════════════════════

describe("P-020 §9 — P9 rewind vs fork", () => {
  it("rewind records the abandoned future; fork preserves the parent as a sibling", () => {
    const { world, C } = buildScenario();
    const rw = rewindTo(C, world);
    const f = forkTimeline(C, "F");
    expect(rw.ok && f.ok).toBe(true);
    if (!rw.ok || !f.ok) return;

    // rewind: origin "rewind", the abandoned future is recorded
    expect(rw.value.world.lineage.origin).toBe("rewind");
    expect(rw.value.world.lineage.abandonedTimelines).toHaveLength(1);
    expect(rw.value.world.lineage.abandonedTimelines[0]!.timelineId).toBe(world.lineage.timelineId);

    // fork: origin "fork", the parent future is preserved as a sibling, NOT abandoned
    expect(f.value.world.lineage.origin).toBe("fork");
    expect(f.value.world.lineage.abandonedTimelines).toHaveLength(0);

    // both descend from the same parent timeline, but the lineage structures differ
    expect(rw.value.world.lineage.parentTimelineId).toBe(world.lineage.timelineId);
    expect(f.value.world.lineage.parentTimelineId).toBe(world.lineage.timelineId);
    expect(rw.value.world.lineage.timelineId).not.toBe(f.value.world.lineage.timelineId);
    expect(JSON.stringify(rw.value.world.lineage)).not.toBe(JSON.stringify(f.value.world.lineage));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §10. P10 — convergence: physics equal, identity distinct, no collapse
// ════════════════════════════════════════════════════════════════════════════

describe("P-020 §10 — P10 convergence", () => {
  it("convergent branches stay independently addressable; the engine never collapses them", () => {
    const { C } = buildScenario();
    const runOrder = (label: string, order: Intervention[]) => {
      const f = forkTimeline(C, label);
      if (!f.ok) throw new Error("fork failed");
      for (const i of order) submitIntervention(f.value.world, i, f.value.engine);
      advance(f.value.world, f.value.engine, 20);
      return f.value.world;
    };
    const a = runOrder("conv-a", [subsidy("s1"), rally("r1")]);
    const b = runOrder("conv-b", [rally("r1"), subsidy("s1")]);

    // physics equal
    expect(a.regions["RF"]!.prices["grain"]).toBe(b.regions["RF"]!.prices["grain"]);
    expect(physicalHash(a)).toBe(physicalHash(b));

    // identity distinct
    expect(stateHash(a)).not.toBe(stateHash(b));
    expect(traceHash(a)).not.toBe(traceHash(b));
    expect(a.lineage.timelineId).not.toBe(b.lineage.timelineId);

    // genealogy distinct: same parent, different children
    expect(a.lineage.parentTimelineId).toBe(b.lineage.parentTimelineId);
    expect(ancestryOf(a.lineage)).toEqual([a.lineage.parentTimelineId!, a.lineage.timelineId]);
    expect(ancestryOf(b.lineage)).toEqual([b.lineage.parentTimelineId!, b.lineage.timelineId]);
    expect(ancestryOf(a.lineage)).not.toEqual(ancestryOf(b.lineage));

    // no collapse: advancing one does not change the other
    const bHash = stateHash(b);
    const aEngine = attachEngine(a, createEngine());
    advance(a, aEngine, 3);
    expect(stateHash(b)).toBe(bHash);

    console.log(
      `[P10] convergent branches: grain price equal=${a.regions["RF"]!.prices["grain"] === b.regions["RF"]!.prices["grain"]} ` +
        `(${a.regions["RF"]!.prices["grain"]}); stateHash differs=${stateHash(a) !== stateHash(b)}; ` +
        `traceHash differs=${traceHash(a) !== traceHash(b)}; timelineIds differ=${a.lineage.timelineId !== b.lineage.timelineId}`,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §11. Adversarial attack matrix
// ════════════════════════════════════════════════════════════════════════════

describe("P-020 §11 — adversarial attack matrix", () => {
  it("11. fork twice from the same checkpoint → two distinct valid branches", () => {
    const { C } = buildScenario();
    const a = forkTimeline(C, "b1");
    const b = forkTimeline(C, "b2");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.timelineId).not.toBe(b.value.timelineId);
    // both are valid: each advances independently
    advance(a.value.world, a.value.engine, 3);
    advance(b.value.world, b.value.engine, 3);
    expect(a.value.world.tick).toBe(C.identity.tick + 3);
    expect(b.value.world.tick).toBe(C.identity.tick + 3);
  });

  it("12. fork from a branch (grandchild) → generation 2, parentTimelineId is the branch", () => {
    const { C } = buildScenario();
    const f = forkTimeline(C, "g1");
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    const C2 = checkpoint(f.value.world, "C2");
    const g = forkTimeline(C2, "g2");
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.value.world.lineage.generation).toBe(2);
    expect(g.value.world.lineage.parentTimelineId).toBe(f.value.timelineId);
    expect(g.value.world.lineage.parentCheckpointId).toBe(C2.identity.checkpointId);
  });

  it("13. rewind after multiple interventions records the full abandoned stretch with the correct hash", () => {
    const { world, C } = buildScenario();
    const abandonedHash = stateHash(world);
    const rw = rewindTo(C, world);
    expect(rw.ok).toBe(true);
    if (!rw.ok) return;

    const rec = rw.value.world.lineage.abandonedTimelines[0]!;
    expect(rec.interventionIds).toEqual(["I3", "I4"]);
    expect(rec.abandonedStateHash).toBe(abandonedHash);
    expect(rec.abandonedAtTick).toBe(8);
    expect(rec.rewoundToTick).toBe(C.identity.tick);
    expect(rec.resumedFromCheckpointId).toBe(C.identity.checkpointId);

    // and the abandoned future is re-derivable: replayAbandoned reproduces the abandoned hash
    const abandonedInterventions = structuredClone(
      world.interventionHistory.filter((i) => i.provenance.sequence > C.world.interventionSeq),
    );
    const replayed = replayAbandoned(
      C,
      abandonedInterventions,
      (w, e, i) => {
        submitIntervention(w, i, e);
      },
      8,
    );
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.stateHash).toBe(abandonedHash);
  });

  it("14. switching timelines repeatedly causes no cross-mutation", () => {
    const { world, engine, C } = buildScenario();
    const f = forkTimeline(C, "sw");
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    for (let i = 0; i < 3; i++) {
      const branchHashBefore = stateHash(f.value.world);
      advance(world, engine, 2);
      expect(stateHash(f.value.world)).toBe(branchHashBefore); // branch untouched by parent advance
      const parentHashBefore = stateHash(world);
      advance(f.value.world, f.value.engine, 2);
      expect(stateHash(world)).toBe(parentHashBefore); // parent untouched by branch advance
    }
  });

  it("15. interventions submitted immediately after switching land on the correct world", () => {
    const { world, engine, C } = buildScenario();
    const f = forkTimeline(C, "sw2");
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    advance(world, engine, 2);
    submitIntervention(world, rally("P-switch"), engine);
    advance(f.value.world, f.value.engine, 2);
    submitIntervention(f.value.world, subsidy("B-switch"), f.value.engine);

    const parentIds = world.interventionHistory.map((i) => i.id);
    const branchIds = f.value.world.interventionHistory.map((i) => i.id);
    expect(parentIds).toContain("P-switch");
    expect(parentIds).not.toContain("B-switch");
    expect(branchIds).toContain("B-switch");
    expect(branchIds).not.toContain("P-switch");
  });

  it("16. replaying the same branch (same checkpoint + discriminator, advanced identically) → identical hashes", () => {
    const { C } = buildScenario();
    const a = forkTimeline(C, "rep");
    const b = forkTimeline(C, "rep");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    submitIntervention(a.value.world, subsidy("s"), a.value.engine);
    submitIntervention(b.value.world, subsidy("s"), b.value.engine);
    advance(a.value.world, a.value.engine, 8);
    advance(b.value.world, b.value.engine, 8);
    expect(a.value.timelineId).toBe(b.value.timelineId);
    expect(stateHash(a.value.world)).toBe(stateHash(b.value.world));
    expect(traceHash(a.value.world)).toBe(traceHash(b.value.world));
  });

  it("17. converge two branches → physics equal, identity distinct (reuses §10)", () => {
    const { C } = buildScenario();
    const runOrder = (label: string, order: Intervention[]) => {
      const f = forkTimeline(C, label);
      if (!f.ok) throw new Error("fork failed");
      for (const i of order) submitIntervention(f.value.world, i, f.value.engine);
      advance(f.value.world, f.value.engine, 20);
      return f.value.world;
    };
    const a = runOrder("conv-a", [subsidy("s1"), rally("r1")]);
    const b = runOrder("conv-b", [rally("r1"), subsidy("s1")]);
    expect(physicalHash(a)).toBe(physicalHash(b));
    expect(stateHash(a)).not.toBe(stateHash(b));
    expect(traceHash(a)).not.toBe(traceHash(b));
    expect(a.lineage.timelineId).not.toBe(b.lineage.timelineId);
  });

  it("18. reconnect after a fork: fresh consumer polls the branch → branch events only, at-least-once, dedup by id", () => {
    const { world, engine, C } = buildScenario();
    const f = forkTimeline(C, "rec");
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    // parent produces post-fork events
    submitIntervention(world, rally("P1"), engine);
    advance(world, engine, 3);
    const parentPostFork = new Set(factStream(world).filter((e) => e.tick > C.identity.tick).map((e) => e.id));
    // branch produces its own
    submitIntervention(f.value.world, subsidy("B1"), f.value.engine);
    advance(f.value.world, f.value.engine, 3);

    const delivery = createDeliveryState();
    const consumer = createConsumer("branch-reconnect");
    registerConsumer(delivery, consumer.id);
    const r1 = poll(f.value.world, delivery, consumer.id);
    expect(r1.status).toBe("deliverable");
    if (r1.status === "deliverable") for (const a of r1.attempts) consumer.apply(a);
    const firstCount = consumer.applied.length;
    expect(firstCount).toBeGreaterThan(0);
    // no parent-only events delivered into the branch consumer
    for (const id of consumer.applied) expect(parentPostFork.has(id)).toBe(false);

    // at-least-once: poll again WITHOUT ack → same events redelivered, deduped by id
    const r2 = poll(f.value.world, delivery, consumer.id);
    expect(r2.status).toBe("deliverable");
    if (r2.status === "deliverable") for (const a of r2.attempts) consumer.apply(a);
    expect(consumer.duplicatesSeen.length).toBeGreaterThan(0);
    expect(consumer.applied.length).toBe(firstCount);

    // ack → caught up
    ack(f.value.world, delivery, consumer.id, f.value.world.highestEmittedSeq);
    const r3 = poll(f.value.world, delivery, consumer.id);
    expect(r3.status).toBe("caught_up");
  });

  it("19. restoring a checkpoint after a branch exists gives the pre-fork world; the branch is untouched", () => {
    const { world, C } = buildScenario();
    const preForkHash = stateHash(C.world);
    const origTimeline = world.lineage.timelineId;
    const f = forkTimeline(C, "r19");
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    submitIntervention(f.value.world, subsidy("b1"), f.value.engine);
    advance(f.value.world, f.value.engine, 4);
    const branchHash = stateHash(f.value.world);

    // direct restore of the checkpoint
    const restored = restoreCheckpoint(C);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(stateHash(restored.value.world)).toBe(preForkHash);
    expect(restored.value.world.lineage.timelineId).toBe(origTimeline);
    expect(stateHash(f.value.world)).toBe(branchHash); // branch untouched by the restore

    // and the round-trip path agrees
    const round = roundTripCheckpoint(C.world, "r19");
    expect(stateHash(round.world)).toBe(preForkHash);
  });

  it("20. two consumers, one per branch, each sees only its own events", () => {
    const { C } = buildScenario();
    const a = forkTimeline(C, "c-a");
    const b = forkTimeline(C, "c-b");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    submitIntervention(a.value.world, subsidy("A1"), a.value.engine);
    advance(a.value.world, a.value.engine, 3);
    submitIntervention(b.value.world, rally("B1"), b.value.engine);
    advance(b.value.world, b.value.engine, 3);

    const da = createDeliveryState();
    const ca = createConsumer("consumer-a");
    registerConsumer(da, ca.id);
    pollOnce(a.value.world, da, ca);

    const db = createDeliveryState();
    const cb = createConsumer("consumer-b");
    registerConsumer(db, cb.id);
    pollOnce(b.value.world, db, cb);

    // each consumer saw exactly its own world's facts, in delivery order
    expect(appliedIds(ca)).toEqual(deliveryFacts(a.value.world));
    expect(appliedIds(cb)).toEqual(deliveryFacts(b.value.world));

    // and no post-fork event from one branch leaked into the other's stream
    const aPost = new Set(factStream(a.value.world).filter((e) => e.tick > C.identity.tick).map((e) => e.id));
    const bPost = new Set(factStream(b.value.world).filter((e) => e.tick > C.identity.tick).map((e) => e.id));
    for (const id of ca.applied) expect(bPost.has(id)).toBe(false);
    for (const id of cb.applied) expect(aPost.has(id)).toBe(false);
    expect(ca.applied.some((id) => aPost.has(id))).toBe(true);
    expect(cb.applied.some((id) => bPost.has(id))).toBe(true);
  });

  it("21. a parent cursor polled against the child timeline is refused (wrong_timeline)", () => {
    const { world, engine, C } = buildScenario();
    const f = forkTimeline(C, "wt21");
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    submitIntervention(world, rally("p1"), engine);
    advance(world, engine, 2);
    submitIntervention(f.value.world, subsidy("b1"), f.value.engine);
    advance(f.value.world, f.value.engine, 2);

    const delivery = createDeliveryState();
    const consumer = createConsumer("parent-consumer");
    registerConsumer(delivery, consumer.id);
    const r1 = poll(world, delivery, consumer.id);
    expect(r1.status).toBe("deliverable"); // cursor established on the parent timeline
    const r2 = poll(f.value.world, delivery, consumer.id);
    expect(r2.status).toBe("wrong_timeline");
    if (r2.status === "wrong_timeline") {
      expect(r2.expected).toBe(world.lineage.timelineId);
      expect(r2.actual).toBe(f.value.world.lineage.timelineId);
    }
    expect(r2.attempts).toEqual([]); // nothing silently delivered into the child
  });

  it("22. a child cursor polled against the parent timeline is refused (symmetric)", () => {
    const { world, engine, C } = buildScenario();
    const f = forkTimeline(C, "wt22");
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    submitIntervention(world, rally("p1"), engine);
    advance(world, engine, 2);
    submitIntervention(f.value.world, subsidy("b1"), f.value.engine);
    advance(f.value.world, f.value.engine, 2);

    const delivery = createDeliveryState();
    const consumer = createConsumer("child-consumer");
    registerConsumer(delivery, consumer.id);
    const r1 = poll(f.value.world, delivery, consumer.id);
    expect(r1.status).toBe("deliverable"); // cursor established on the child timeline
    const r2 = poll(world, delivery, consumer.id);
    expect(r2.status).toBe("wrong_timeline");
    expect(r2.attempts).toEqual([]); // nothing silently delivered into the parent
  });

  it("23. a rejected intervention on one timeline changes nothing on either timeline", () => {
    const { world, C } = buildScenario();
    const f = forkTimeline(C, "rej23");
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    submitIntervention(f.value.world, destroyBridge("first"), f.value.engine);
    advance(f.value.world, f.value.engine, 2);
    const seq1 = f.value.world.interventionSeq;
    const h1 = stateHash(f.value.world);
    const t1 = traceHash(f.value.world);
    const parentHash = stateHash(world);

    // destroy the already-destroyed bridge on the branch → rejected
    const res = submitIntervention(f.value.world, destroyBridge("second"), f.value.engine);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain("already destroyed");
    expect(f.value.world.interventionSeq).toBe(seq1);
    expect(stateHash(f.value.world)).toBe(h1);
    expect(traceHash(f.value.world)).toBe(t1);
    expect(stateHash(world)).toBe(parentHash); // parent unaffected
  });
});