/**
 * CE v1.0 product surface — external-consumer contract tests.
 *
 * IMPORTANT: this file imports ONLY from `../api/product.js`.
 *
 * That restriction is the test. If a game developer can drive the full loop —
 * create, intervene, advance, consume, inspect, explain, checkpoint, fork,
 * rewind, compare, save, reload deterministically — without reaching into
 * `src/core` or `src/game`, then the product surface is self-sufficient. Any
 * `../core/...` import appearing here would be a productization defect.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  // runtime
  createGame,
  step,
  // config
  validateConfig,
  createConfig,
  ConfigError,
  // catalog
  listActions,
  describeAction,
  isActionAvailable,
  // intervention
  buildIntervention,
  validateInterventionSpec,
  intervene,
  // events
  openEventStream,
  // persistence
  saveGame,
  loadGame,
  loadWorld,
  inspectSave,
  // timeline
  timelineOf,
  forkGame,
  rewindGame,
  compareTimelines,
  // inspection
  inspect,
  whatChanged,
  recentEvents,
  // explanation
  why,
  quantity,
  // pass-throughs
  DEFAULT_CONFIG,
  CURRENT_SCHEMA_VERSION,
  type CausalRuntime,
} from "../api/product.js";

// ── helpers ────────────────────────────────────────────────────────────────

const DESTROY_BRIDGE = {
  action: "destroy_infrastructure",
  target: { type: "infrastructure" as const, id: "grain_road" },
  location: "RF",
};

const SUBSIDY = {
  action: "grant_merchant_subsidy",
  target: { type: "region" as const, id: "RF" },
  location: "RF",
};

function grainPrice(rt: CausalRuntime): number {
  return inspect(rt).regions["RF"]!.prices["grain"]!;
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNTIME
// ═══════════════════════════════════════════════════════════════════════════

describe("product/runtime — createGame", () => {
  it("creates a world at tick 0 with a populated projection", () => {
    const rt = createGame();
    const view = inspect(rt);

    expect(rt.world.tick).toBe(0);
    expect(view.tick).toBe(0);
    expect(view.regions["RF"]).toBeDefined();
    expect(view.regions["RF"]!.name.length).toBeGreaterThan(0);
    expect(view.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(view.stateHash.length).toBeGreaterThan(0);
  });

  it("registers the consumer channel it was asked for", () => {
    const rt = createGame({ consumerId: "renderer" });
    expect(rt.consumerId).toBe("renderer");
    expect(rt.delivery.channels["renderer"]).toBeDefined();
  });

  it("same seed produces the same initial state hash", () => {
    const a = inspect(createGame({ seed: 7 }));
    const b = inspect(createGame({ seed: 7 }));
    expect(a.stateHash).toBe(b.stateHash);
  });

  it("step reports ticks advanced and both hashes", () => {
    const rt = createGame();
    const result = step(rt, 3);
    expect(result.tick).toBe(3);
    expect(result.ticksAdvanced).toBe(3);
    expect(result.stateHash.length).toBeGreaterThan(0);
    expect(result.traceHash.length).toBeGreaterThan(0);
  });

  it("step defaults to a single tick", () => {
    const rt = createGame();
    expect(step(rt).tick).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

describe("product/config — validation at the product boundary", () => {
  it("accepts an empty override set", () => {
    const validation = validateConfig({});
    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it("rejects ledgerDecayPerTick outside (0,1) and does not mutate the input", () => {
    const overrides = { ledgerDecayPerTick: 1.5 };
    const validation = validateConfig(overrides);

    expect(validation.ok).toBe(false);
    expect(validation.errors.some((e) => e.field === "ledgerDecayPerTick")).toBe(true);
    // never normalised or clamped
    expect(overrides.ledgerDecayPerTick).toBe(1.5);
  });

  it("createConfig throws ConfigError carrying every issue", () => {
    expect(() => createConfig({ ledgerDecayPerTick: 1.5 })).toThrow(ConfigError);

    try {
      createConfig({ ledgerDecayPerTick: 1.5, contestRatio: 9 });
      expect.unreachable("createConfig should have thrown");
    } catch (error) {
      const configError = error as ConfigError;
      expect(configError.issues.length).toBeGreaterThanOrEqual(2);
      expect(configError.issues.map((i) => i.field)).toContain("contestRatio");
    }
  });

  it("boundaryMaxHops: 0 is a warning, not an error", () => {
    const validation = validateConfig({ boundaryMaxHops: 0 });
    expect(validation.ok).toBe(true);
    expect(validation.warnings.some((w) => w.field === "boundaryMaxHops")).toBe(true);
  });

  it("rejects a non-positive causal threshold", () => {
    const validation = validateConfig({ thresholds: { ...DEFAULT_CONFIG.thresholds, economy: 0 } });
    expect(validation.ok).toBe(false);
    expect(validation.errors.some((e) => e.field === "thresholds.economy")).toBe(true);
  });

  it("rejects NaN and non-integer seeds", () => {
    expect(validateConfig({ seed: Number.NaN }).ok).toBe(false);
    expect(validateConfig({ seed: 4.2 }).ok).toBe(false);
    expect(validateConfig({ seed: 4 }).ok).toBe(true);
  });

  it("rejects priceClampMax at or below priceClampMin (cross-field)", () => {
    const validation = validateConfig({ priceClampMax: 0.1 });
    expect(validation.ok).toBe(false);
    expect(validation.errors.some((e) => e.field === "priceClampMax")).toBe(true);
  });

  it("createGame surfaces invalid config as a thrown ConfigError", () => {
    expect(() => createGame({ config: { boundaryDecay: 3 } })).toThrow(ConfigError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INTERVENTION CATALOG
// ═══════════════════════════════════════════════════════════════════════════

describe("product/catalog — discoverable action vocabulary", () => {
  it("lists every engine action, sorted", () => {
    const names = listActions().map((a) => a.action);
    expect(names).toContain("destroy_infrastructure");
    expect(names).toContain("kill_entity");
    expect(names).toContain("hold_public_rally");
    expect(names).toContain("grant_merchant_subsidy");
    expect([...names].sort()).toEqual(names);
  });

  it("reports the location constraint each action enforces", () => {
    expect(describeAction("hold_public_rally")!.locationMustEqualTarget).toBe(true);
    expect(describeAction("grant_merchant_subsidy")!.locationMustEqualTarget).toBe(true);
    expect(describeAction("destroy_infrastructure")!.locationMustEqualTarget).toBe(false);
  });

  it("reports allowed target kinds", () => {
    expect(describeAction("destroy_infrastructure")!.allowedTargets).toContain("infrastructure");
    expect(describeAction("hold_public_rally")!.allowedTargets).toContain("region");
  });

  it("is honest about unknown actions", () => {
    expect(describeAction("summon_dragon")).toBeUndefined();
    expect(isActionAvailable("summon_dragon")).toBe(false);
    expect(isActionAvailable("destroy_infrastructure")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INTERVENTION ERGONOMICS
// ═══════════════════════════════════════════════════════════════════════════

describe("product/intervention — spec validation", () => {
  it("rejects an unknown action and names the available ones", () => {
    const result = validateInterventionSpec({
      action: "summon_dragon",
      target: { type: "region", id: "RF" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("destroy_infrastructure");
  });

  it("rejects a target kind the action does not accept", () => {
    const result = validateInterventionSpec({
      action: "destroy_infrastructure",
      target: { type: "region", id: "RF" },
      location: "RF",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("cannot target");
  });

  it("rejects a rally whose location differs from its target", () => {
    const result = validateInterventionSpec({
      action: "hold_public_rally",
      target: { type: "region", id: "RF" },
      location: "PS",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("location to equal target.id");
  });

  it("rejects magnitude outside [0,1]", () => {
    expect(
      validateInterventionSpec({ ...DESTROY_BRIDGE, magnitude: 1.5 }).ok,
    ).toBe(false);
    expect(validateInterventionSpec({ ...DESTROY_BRIDGE, magnitude: 0.5 }).ok).toBe(true);
  });
});

describe("product/intervention — builder is ergonomics only", () => {
  it("emits an EMPTY causalDomains array (engine authors causal pressure)", () => {
    const rt = createGame();
    const built = buildIntervention(rt, DESTROY_BRIDGE);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.intervention.causalDomains).toEqual([]);
  });

  it("stamps engine bookkeeping from the world, not the caller", () => {
    const rt = createGame();
    step(rt, 4);
    const built = buildIntervention(rt, DESTROY_BRIDGE);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.intervention.tick).toBe(rt.world.tick);
    expect(built.intervention.provenance.submittedAtTick).toBe(rt.world.tick);
    expect(built.intervention.provenance.sequence).toBe(rt.world.interventionSeq);
    expect(built.intervention.actor).toBe("player");
    expect(built.intervention.magnitude).toBe(1.0);
  });

  it("defaults location to the target id", () => {
    const rt = createGame();
    const built = buildIntervention(rt, {
      action: "hold_public_rally",
      target: { type: "region", id: "RF" },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.intervention.location).toBe("RF");
  });

  it("returns build errors instead of throwing", () => {
    const rt = createGame();
    const built = buildIntervention(rt, {
      action: "nope",
      target: { type: "region", id: "RF" },
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE CORE LOOP: intervene -> advance -> observe
// ═══════════════════════════════════════════════════════════════════════════

describe("product — player action propagates to observable consequence", () => {
  it("destroying the bridge raises the grain price and marks it destroyed", () => {
    const rt = createGame();
    const priceBefore = grainPrice(rt);

    const applied = intervene(rt, DESTROY_BRIDGE);
    expect(applied.ok).toBe(true);
    expect(applied.errors).toEqual([]);

    step(rt, 5);

    expect(grainPrice(rt)).toBeGreaterThan(priceBefore);
    expect(inspect(rt).regions["RF"]!.infrastructure["grain_road"]!.intact).toBe(false);
  });

  it("repeating the destroy is rejected — idempotent rejection is preserved", () => {
    const rt = createGame();
    expect(intervene(rt, DESTROY_BRIDGE).ok).toBe(true);
    step(rt, 1);

    const second = intervene(rt, DESTROY_BRIDGE);
    expect(second.ok).toBe(false);
    expect(second.errors.length).toBeGreaterThan(0);
  });

  it("a failed build leaves the intervention sequence untouched", () => {
    const rt = createGame();
    const before = rt.world.interventionSeq;
    const result = intervene(rt, { action: "nope", target: { type: "region", id: "RF" } });
    expect(result.ok).toBe(false);
    expect(result.interventionSeq).toBe(before);
    expect(rt.world.interventionSeq).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EVENT DELIVERY
// ═══════════════════════════════════════════════════════════════════════════

describe("product/events — delivery semantics are preserved, not hidden", () => {
  it("polls events, acks them explicitly, then reports caught_up", () => {
    const rt = createGame();
    const stream = openEventStream(rt);

    intervene(rt, DESTROY_BRIDGE);
    step(rt, 5);

    const batch = stream.next();
    expect(batch.status).toBe("events");
    expect(batch.events.length).toBeGreaterThan(0);
    expect(batch.highestSeq).toBeGreaterThanOrEqual(0);

    expect(stream.ackBatch(batch).ok).toBe(true);
    expect(stream.next().status).toBe("caught_up");
  });

  it("reading does not consume — next() without ack redelivers", () => {
    const rt = createGame();
    const stream = openEventStream(rt);
    intervene(rt, DESTROY_BRIDGE);
    step(rt, 3);

    const first = stream.next();
    const second = stream.next();
    expect(first.status).toBe("events");
    expect(second.status).toBe("events");
    expect(second.events.length).toBe(first.events.length);
    // at-least-once is visible: the attempt counter increments
    expect(second.events[0]!.attempt).toBeGreaterThan(first.events[0]!.attempt);
  });

  it("drain delivers in non-decreasing streamSeq order and acks", () => {
    const rt = createGame();
    const stream = openEventStream(rt);
    intervene(rt, DESTROY_BRIDGE);
    step(rt, 5);

    const seen: number[] = [];
    const report = stream.drain((_event, meta) => seen.push(meta.streamSeq));

    expect(report.status).toBe("events");
    expect(report.delivered).toBeGreaterThan(0);
    expect(report.acked).toBe(true);
    expect(seen.length).toBe(report.delivered);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it("drain on an empty stream reports caught_up and does not ack", () => {
    const rt = createGame();
    const stream = openEventStream(rt);
    const report = stream.drain(() => {
      throw new Error("handler must not run for an empty batch");
    });
    expect(report.status).toBe("caught_up");
    expect(report.delivered).toBe(0);
    expect(report.acked).toBe(false);
  });

  it("ackBatch on an empty batch is a successful no-op", () => {
    const rt = createGame();
    const stream = openEventStream(rt);
    expect(stream.ackBatch(stream.next()).ok).toBe(true);
  });

  it("cursor advances only through acknowledgement", () => {
    const rt = createGame();
    const stream = openEventStream(rt);
    const start = stream.cursor().afterSeq;

    intervene(rt, DESTROY_BRIDGE);
    step(rt, 5);

    stream.next(); // read only
    expect(stream.cursor().afterSeq).toBe(start);

    stream.drain(() => {});
    expect(stream.cursor().afterSeq).toBeGreaterThan(start);
  });

  it("recover repositions the cursor via stateSync without pretending nothing happened", () => {
    const rt = createGame();
    const stream = openEventStream(rt);
    intervene(rt, DESTROY_BRIDGE);
    step(rt, 5);

    expect(stream.recover().ok).toBe(true);
    expect(stream.next().status).toBe("caught_up");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════

describe("product/save — save, load, deterministic continuation", () => {
  it("round-trips a world with an identical state hash", () => {
    const rt = createGame();
    intervene(rt, DESTROY_BRIDGE);
    step(rt, 4);

    const save = saveGame(rt, "test-save");
    const loaded = loadGame(save.data);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(inspect(loaded.runtime).stateHash).toBe(save.stateHash);
    expect(loaded.runtime.world.tick).toBe(save.tick);
    expect(loaded.migrated).toBe(false);
  });

  it("continuation is deterministic across save/load", () => {
    const rt = createGame();
    intervene(rt, DESTROY_BRIDGE);
    step(rt, 3);

    const save = saveGame(rt);
    const originalHash = step(rt, 5).stateHash;

    const loaded = loadGame(save.data);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(step(loaded.runtime, 5).stateHash).toBe(originalHash);
  });

  it("rejects malformed save data with errors, not an exception", () => {
    const result = loadGame("not-json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("loadWorld is an alias of loadGame", () => {
    const rt = createGame();
    const save = saveGame(rt);
    const viaAlias = loadWorld(save.data);
    expect(viaAlias.ok).toBe(true);
    if (!viaAlias.ok) return;
    expect(inspect(viaAlias.runtime).stateHash).toBe(save.stateHash);
  });

  it("inspectSave reads identity without building a runtime", () => {
    const rt = createGame();
    step(rt, 2);
    const save = saveGame(rt);

    const peek = inspectSave(save.data);
    expect(peek.ok).toBe(true);
    if (!peek.ok) return;
    expect(peek.checkpointId).toBe(save.checkpointId);
    expect(peek.tick).toBe(save.tick);
    expect(inspectSave("garbage").ok).toBe(false);
  });

  it("a loaded runtime starts with a fresh delivery cursor", () => {
    const rt = createGame();
    intervene(rt, DESTROY_BRIDGE);
    step(rt, 3);
    openEventStream(rt).drain(() => {});

    const loaded = loadGame(saveGame(rt).data);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    // Cursors describe a reader, not the world: a reload must not inherit one.
    const batch = openEventStream(loaded.runtime).next();
    expect(batch.status).toBe("events");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TIMELINES
// ═══════════════════════════════════════════════════════════════════════════

describe("product/timeline — branching and rewind", () => {
  it("reports genesis lineage for a new game", () => {
    const summary = timelineOf(createGame());
    expect(summary.origin).toBe("genesis");
    expect(summary.parentTimelineId).toBeNull();
    expect(summary.generation).toBe(0);
  });

  it("forking yields a distinct timeline and leaves the parent untouched", () => {
    const parent = createGame();
    step(parent, 2);
    const save = saveGame(parent);
    const parentTickBefore = parent.world.tick;
    const parentTimeline = timelineOf(parent).timelineId;

    const forked = forkGame(save.data, "B");
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;

    expect(timelineOf(forked.runtime).timelineId).not.toBe(parentTimeline);
    expect(timelineOf(forked.runtime).origin).toBe("fork");
    expect(timelineOf(forked.runtime).parentTimelineId).toBe(parentTimeline);
    expect(parent.world.tick).toBe(parentTickBefore);
  });

  it("divergent interventions produce causally distinct worlds", () => {
    const timelineA = createGame();
    step(timelineA, 1);
    const branchPoint = saveGame(timelineA, "branch-point");

    // A: destroy the bridge
    intervene(timelineA, DESTROY_BRIDGE);
    step(timelineA, 5);

    // B: from the same checkpoint, subsidise instead
    const forked = forkGame(branchPoint.data, "B");
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;
    const timelineB = forked.runtime;
    intervene(timelineB, SUBSIDY);
    step(timelineB, 5);

    const comparison = compareTimelines(timelineA, timelineB);
    expect(comparison.distinct).toBe(true);
    expect(comparison.stateHashEqual).toBe(false);
    expect(comparison.traceHashEqual).toBe(false);
    expect(comparison.differences.length).toBeGreaterThan(0);

    // the bridge is the observable divergence
    expect(inspect(timelineA).regions["RF"]!.infrastructure["grain_road"]!.intact).toBe(false);
    expect(inspect(timelineB).regions["RF"]!.infrastructure["grain_road"]!.intact).toBe(true);
  });

  it("comparing a runtime with itself reports no differences", () => {
    const rt = createGame();
    step(rt, 2);
    const comparison = compareTimelines(rt, rt);
    expect(comparison.distinct).toBe(false);
    expect(comparison.stateHashEqual).toBe(true);
    expect(comparison.traceHashEqual).toBe(true);
    expect(comparison.differences).toEqual([]);
  });

  it("rewinding restores the physical world and names the abandoned timeline", () => {
    const rt = createGame();
    step(rt, 2);
    const save = saveGame(rt, "rewind-point");
    const before = inspect(rt);
    const abandoned = timelineOf(rt).timelineId;

    intervene(rt, DESTROY_BRIDGE);
    step(rt, 6);
    expect(rt.world.tick).toBeGreaterThan(save.tick);

    const rewound = rewindGame(rt, save.data);
    expect(rewound.ok).toBe(true);
    if (!rewound.ok) return;

    expect(rewound.runtime.world.tick).toBe(save.tick);
    expect(rewound.abandonedTimelineId).toBe(abandoned);

    // The PHYSICAL world is restored exactly: the destroyed bridge is intact again
    // and the grain price is back to its pre-action value.
    const after = inspect(rewound.runtime);
    expect(after.regions["RF"]!.infrastructure["grain_road"]!.intact).toBe(true);
    expect(after.regions["RF"]!.prices["grain"]!).toBe(before.regions["RF"]!.prices["grain"]!);
  });

  it("a rewind takes a NEW timeline identity — it does not resurrect the old one", () => {
    const rt = createGame();
    step(rt, 2);
    const save = saveGame(rt, "rewind-point");
    const abandoned = timelineOf(rt).timelineId;

    intervene(rt, DESTROY_BRIDGE);
    step(rt, 4);

    const rewound = rewindGame(rt, save.data);
    expect(rewound.ok).toBe(true);
    if (!rewound.ok) return;

    const summary = timelineOf(rewound.runtime);
    expect(summary.origin).toBe("rewind");
    expect(summary.timelineId).not.toBe(abandoned);

    // Lineage is part of world identity, so a rewound world does NOT share the
    // checkpoint's stateHash even though its physics are identical. Reporting them
    // as the same world would let a save claim an ancestry it does not have.
    expect(inspect(rewound.runtime).stateHash).not.toBe(save.stateHash);
  });

  it("rewind rejects a checkpoint from another world", () => {
    const a = createGame({ seed: 1 });
    const b = createGame({ seed: 2 });
    step(b, 1);

    const result = rewindGame(a, saveGame(b).data);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("fork and rewind reject malformed save data", () => {
    expect(forkGame("garbage", "B").ok).toBe(false);
    expect(rewindGame(createGame(), "garbage").ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INSPECTION
// ═══════════════════════════════════════════════════════════════════════════

describe("product/inspect — what is the world, what changed", () => {
  it("accepts a runtime or a bare world", () => {
    const rt = createGame();
    expect(inspect(rt).stateHash).toBe(inspect(rt.world).stateHash);
  });

  it("whatChanged reports the grain price and is empty for identical views", () => {
    const rt = createGame();
    const before = inspect(rt);

    intervene(rt, DESTROY_BRIDGE);
    step(rt, 5);
    const after = inspect(rt);

    const changes = whatChanged(before, after);
    expect(changes.some((c) => c.path === "regions.RF.prices.grain")).toBe(true);
    expect(changes.some((c) => c.path === "tick")).toBe(true);
    expect(whatChanged(before, before)).toEqual([]);
  });

  it("whatChanged reports destroyed infrastructure health", () => {
    const rt = createGame();
    const before = inspect(rt);
    intervene(rt, DESTROY_BRIDGE);
    step(rt, 1);

    const changes = whatChanged(before, inspect(rt));
    expect(
      changes.some((c) => c.path === "regions.RF.infrastructure.grain_road.health"),
    ).toBe(true);
  });

  it("projects structure intactness rather than leaking raw internals", () => {
    const rt = createGame();
    const bridge = inspect(rt).regions["RF"]!.infrastructure["grain_road"]!;
    expect(bridge.intact).toBe(true);
    expect(bridge.health).toBeGreaterThan(0);
    expect(bridge.type.length).toBeGreaterThan(0);
  });

  it("recentEvents respects its limit and stays within the record", () => {
    const rt = createGame();
    intervene(rt, DESTROY_BRIDGE);
    step(rt, 8);

    expect(recentEvents(rt, 5).length).toBeLessThanOrEqual(5);
    expect(recentEvents(rt, 0)).toEqual([]);
    expect(recentEvents(rt).length).toBeLessThanOrEqual(20);
  });

  it("uses deterministic key ordering", () => {
    const view = inspect(createGame());
    const regionIds = Object.keys(view.regions);
    expect([...regionIds].sort()).toEqual(regionIds);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EXPLANATION
// ═══════════════════════════════════════════════════════════════════════════

describe("product/explain — why did this happen", () => {
  it("attributes the grain price to the destroy action", () => {
    const rt = createGame();
    intervene(rt, DESTROY_BRIDGE);
    step(rt, 5);

    const cause = why(rt, quantity.price("RF", "grain"));
    expect(cause.explained).toBe(true);
    expect(cause.quantity).toBe(quantity.price("RF", "grain"));
    expect(cause.rootActions.some((r) => r.action === "destroy_infrastructure")).toBe(true);
  });

  it("root actions are deduped and stably ordered", () => {
    const rt = createGame();
    intervene(rt, DESTROY_BRIDGE);
    step(rt, 5);

    const cause = why(rt, quantity.price("RF", "grain"));
    const ids = cause.rootActions.map((r) => r.interventionId);
    expect(new Set(ids).size).toBe(ids.length);

    const ticks = cause.rootActions.map((r) => r.tick);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
  });

  it("reports an untouched quantity as unexplained rather than inventing a cause", () => {
    const rt = createGame();
    step(rt, 2);
    const cause = why(rt, quantity.hostility("NOPE"));
    expect(cause.explained).toBe(false);
    expect(cause.rootActions).toEqual([]);
  });

  it("accepts a bare world as well as a runtime", () => {
    const rt = createGame();
    intervene(rt, DESTROY_BRIDGE);
    step(rt, 5);
    expect(why(rt.world, quantity.price("RF", "grain")).explained).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FULL EXTERNAL-DEVELOPER LOOP
// ═══════════════════════════════════════════════════════════════════════════

describe("product — the complete external developer loop", () => {
  it("runs create -> inspect -> intervene -> advance -> consume -> explain -> checkpoint -> fork -> rewind -> compare -> save -> reload", () => {
    // 1. create
    const rt = createGame({ seed: 42, consumerId: "game" });
    const stream = openEventStream(rt);

    // 2. inspect the initial world
    const initial = inspect(rt);
    expect(initial.tick).toBe(0);
    expect(initial.regions["RF"]!.infrastructure["grain_road"]!.intact).toBe(true);

    // 3. checkpoint BEFORE acting, so a branch can take a different path
    const branchPoint = saveGame(rt, "before-action");

    // 4. intervene
    expect(intervene(rt, DESTROY_BRIDGE).ok).toBe(true);

    // 5. advance
    step(rt, 5);

    // 6. consume events
    const consumed: number[] = [];
    const report = stream.drain((_e, meta) => consumed.push(meta.streamSeq));
    expect(report.acked).toBe(true);
    expect(consumed.length).toBeGreaterThan(0);

    // 7. inspect the consequence
    const afterAction = inspect(rt);
    expect(afterAction.regions["RF"]!.prices["grain"]!).toBeGreaterThan(
      initial.regions["RF"]!.prices["grain"]!,
    );
    expect(whatChanged(initial, afterAction).length).toBeGreaterThan(0);

    // 8. explain it
    expect(why(rt, quantity.price("RF", "grain")).rootActions.map((r) => r.action)).toContain(
      "destroy_infrastructure",
    );

    // 9. fork an alternate timeline from the branch point
    const forked = forkGame(branchPoint.data, "B");
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;
    const alternate = forked.runtime;
    expect(intervene(alternate, SUBSIDY).ok).toBe(true);
    step(alternate, 5);

    // 10. both timelines remain distinct
    const comparison = compareTimelines(rt, alternate);
    expect(comparison.distinct).toBe(true);
    expect(comparison.stateHashEqual).toBe(false);
    expect(comparison.differences.length).toBeGreaterThan(0);

    // 11. rewind the primary timeline
    const rewound = rewindGame(rt, branchPoint.data);
    expect(rewound.ok).toBe(true);
    if (!rewound.ok) return;
    expect(rewound.runtime.world.tick).toBe(branchPoint.tick);

    // 12. save and reload with deterministic continuation
    const finalSave = saveGame(alternate, "final");
    const expected = step(alternate, 3).stateHash;
    const reloaded = loadGame(finalSave.data);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(step(reloaded.runtime, 3).stateHash).toBe(expected);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BOUNDARY AUDIT
// ═══════════════════════════════════════════════════════════════════════════

describe("product — boundary audit", () => {
  it("contains no RNG, no wall-clock, and no causal randomness", () => {
    const dir = new URL("./", import.meta.url).pathname;
    const productDir = process.platform === "win32" && dir.startsWith("/") ? dir.slice(1) : dir;

    const files = readdirSync(productDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    const forbidden = ["Math.random", "randi", "randf", "randomize", "new Date("];
    const violations: string[] = [];

    for (const file of files) {
      if (file.endsWith(".test.ts")) continue;
      const source = readFileSync(join(productDir, file), "utf8");
      for (const pattern of forbidden) {
        if (source.includes(pattern)) violations.push(`${file}: ${pattern}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
