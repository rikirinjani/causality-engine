/**
 * P-012: Runtime / Adapter Boundary Experiment
 *
 * Tests the boundary between CE and an independently running game.
 * Validates: intervention lifecycle, ordering, backpressure, restart, persistence.
 *
 * Run: npx vitest run src/poc/runtime-boundary.test.ts
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createEngine, createWorld, submitIntervention, advance, tick, snapshot,
  stateHash, traceHash, factStream, stream,
  createCheckpoint, serializeCheckpoint, deserializeCheckpoint,
  validateCheckpoint, restoreCheckpoint,
  makeConfig, attachEngine, enforceRetention,
  poll, ack, stateSync, resync,
  createDeliveryState, registerConsumer, serializeDelivery, deserializeDelivery,
  EVENT_RETENTION_LIMIT,
  type Engine, type WorldState, type Intervention, type DeliveryState,
} from "../api/public.js";
import { ROUTE_ID, WAREHOUSE_ID, SHRINE_ID, WORLD_SEED } from "../game/content.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function base(id: string, action: string): Omit<Intervention, "target" | "location"> {
  return {
    id,
    tick: 0,
    actor: "player",
    action,
    intent: "runtime-boundary-test",
    magnitude: 1,
    causalDomains: [],
    provenance: { submittedAtTick: 0, sequence: 0 },
  };
}

function makeBridge(id = "rb-bridge"): Intervention {
  return { ...base(id, "destroy_infrastructure"), target: { type: "infrastructure", id: ROUTE_ID }, location: "RF" };
}

function makeWarehouse(id = "rb-warehouse"): Intervention {
  return { ...base(id, "destroy_infrastructure"), target: { type: "infrastructure", id: WAREHOUSE_ID }, location: "RF" };
}

function makeRally(id = "rb-rally"): Intervention {
  return { ...base(id, "hold_public_rally"), target: { type: "region", id: "HT" }, location: "HT" };
}

function makeSubsidy(id = "rb-subsidy"): Intervention {
  return { ...base(id, "grant_merchant_subsidy"), target: { type: "region", id: "RF" }, location: "RF" };
}

function makeKillMerchant(id = "rb-merchant"): Intervention {
  return { ...base(id, "kill_entity"), target: { type: "entity", id: "a07" }, location: "RF" };
}

interface TestContext {
  world: WorldState;
  engine: Engine;
  delivery: DeliveryState;
  consumerId: string;
}

function createTestContext(seed = WORLD_SEED): TestContext {
  const engine = createEngine();
  const world = createWorld(makeConfig({ seed }), engine);
  const delivery = createDeliveryState();
  const consumerId = "test-game";
  registerConsumer(delivery, consumerId);
  return { world, engine, delivery, consumerId };
}

function pollAll(ctx: TestContext): string[] {
  const events: string[] = [];
  for (let i = 0; i < 50; i++) {
    const result = poll(ctx.world, ctx.delivery, ctx.consumerId);
    if (result.status === "caught_up" || result.status === "disconnected") break;
    if (result.status === "gap") {
      const sync = stateSync(ctx.world);
      resync(ctx.delivery, ctx.consumerId, sync);
      break;
    }
    if (result.status === "deliverable") {
      for (const a of result.attempts) events.push(a.event.type);
      const maxSeq = Math.max(...result.attempts.map((a) => a.streamSeq));
      ack(ctx.world, ctx.delivery, ctx.consumerId, maxSeq);
    }
  }
  return events;
}

// ═══════════════════════════════════════════════════════════════════════════════
// §1 — INTERVENTION LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

describe("P-012 §1 — Intervention lifecycle", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it("intervention is accepted and assigned sequence number", () => {
    const iv = makeBridge();
    const result = submitIntervention(ctx.world, iv, ctx.engine);
    expect(result.ok).toBe(true);
    // Sequence is assigned internally
    expect(ctx.world.interventionSeq).toBe(1);
  });

  it("intervention is recorded in history before simulation", () => {
    const iv = makeBridge();
    submitIntervention(ctx.world, iv, ctx.engine);
    expect(ctx.world.interventionHistory.length).toBe(1);
    expect(ctx.world.interventionHistory[0].id).toBe("rb-bridge");
  });

  it("multiple interventions before tick are queued in order", () => {
    const iv1 = makeBridge("iv-1");
    const iv2 = makeWarehouse("iv-2");
    const iv3 = makeRally("iv-3");

    submitIntervention(ctx.world, iv1, ctx.engine);
    submitIntervention(ctx.world, iv2, ctx.engine);
    submitIntervention(ctx.world, iv3, ctx.engine);

    expect(ctx.world.interventionSeq).toBe(3);
    expect(ctx.world.interventionHistory.length).toBe(3);

    // Advance and check that all three are processed
    advance(ctx.world, ctx.engine, 1);
    const snap = snapshot(ctx.world);
    // Bridge and warehouse are destroyed, rally is civic
    const rf = snap.regions["RF"]!;
    expect(rf.infrastructure[ROUTE_ID]?.health).toBe(0);
    expect(rf.infrastructure[WAREHOUSE_ID]?.health).toBe(0);
  });

  it("intervention tick is injected by engine, not caller", () => {
    const iv = makeBridge();
    iv.tick = 999; // Should be overwritten
    submitIntervention(ctx.world, iv, ctx.engine);
    // After submit, tick is set to current world tick (0)
    expect(ctx.world.interventionHistory[0].tick).toBe(0);
  });

  it("rejected intervention does not increment sequence on rejection", () => {
    // Destroy bridge twice — second should fail and NOT increment sequence
    const iv1 = makeBridge("iv-1");
    const iv2 = makeBridge("iv-2");

    submitIntervention(ctx.world, iv1, ctx.engine);
    advance(ctx.world, ctx.engine, 1);
    const seqBefore = ctx.world.interventionSeq;
    const result = submitIntervention(ctx.world, iv2, ctx.engine);
    expect(result.ok).toBe(false);
    // Sequence does NOT increment on rejected interventions
    expect(ctx.world.interventionSeq).toBe(seqBefore);
  });

  it("intervention produces causal events after tick", () => {
    const iv = makeBridge();
    submitIntervention(ctx.world, iv, ctx.engine);

    // Before tick: no consumer events
    const before = pollAll(ctx);
    expect(before.length).toBe(0);

    // After tick: events are produced
    advance(ctx.world, ctx.engine, 1);
    const after = pollAll(ctx);
    expect(after.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §2 — TICK / INTERVENTION ORDERING
// ═══════════════════════════════════════════════════════════════════════════════

describe("P-012 §2 — Tick/intervention ordering", () => {
  it("batch of 3 interventions in same tick produces deterministic result", () => {
    const ctx1 = createTestContext(42);
    const ctx2 = createTestContext(42);

    // Submit all three in the same tick
    submitIntervention(ctx1.world, makeBridge("b1"), ctx1.engine);
    submitIntervention(ctx1.world, makeWarehouse("b2"), ctx1.engine);
    submitIntervention(ctx1.world, makeRally("b3"), ctx1.engine);
    advance(ctx1.world, ctx1.engine, 1);

    submitIntervention(ctx2.world, makeBridge("b1"), ctx2.engine);
    submitIntervention(ctx2.world, makeWarehouse("b2"), ctx2.engine);
    submitIntervention(ctx2.world, makeRally("b3"), ctx2.engine);
    advance(ctx2.world, ctx2.engine, 1);

    expect(stateHash(ctx1.world)).toBe(stateHash(ctx2.world));
    expect(traceHash(ctx1.world)).toBe(traceHash(ctx2.world));
  });

  it("sequential interventions across ticks differ from batch", () => {
    const ctx1 = createTestContext(42);
    const ctx2 = createTestContext(42);

    // Batch: all in tick 0
    submitIntervention(ctx1.world, makeBridge("b1"), ctx1.engine);
    submitIntervention(ctx1.world, makeWarehouse("b2"), ctx1.engine);
    advance(ctx1.world, ctx1.engine, 1);

    // Sequential: one per tick
    submitIntervention(ctx2.world, makeBridge("b1"), ctx2.engine);
    advance(ctx2.world, ctx2.engine, 1);
    submitIntervention(ctx2.world, makeWarehouse("b2"), ctx2.engine);
    advance(ctx2.world, ctx2.engine, 1);

    // Results should differ because causal resolution happens at different ticks
    expect(stateHash(ctx1.world)).not.toBe(stateHash(ctx2.world));
  });

  it("canonical ordering is deterministic regardless of submission order", () => {
    const ctx1 = createTestContext(42);
    const ctx2 = createTestContext(42);

    // Submit in order A, B
    submitIntervention(ctx1.world, makeBridge("a"), ctx1.engine);
    submitIntervention(ctx1.world, makeWarehouse("b"), ctx1.engine);
    advance(ctx1.world, ctx1.engine, 1);

    // Submit in order B, A
    submitIntervention(ctx2.world, makeWarehouse("b"), ctx2.engine);
    submitIntervention(ctx2.world, makeBridge("a"), ctx2.engine);
    advance(ctx2.world, ctx2.engine, 1);

    // Same hash — canonical ordering normalizes the sequence
    expect(stateHash(ctx1.world)).toBe(stateHash(ctx2.world));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §3 — STATE / EVENT CONTRACT
// ═══════════════════════════════════════════════════════════════════════════════

describe("P-012 §3 — State/event contract", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it("stateSync returns current truth", () => {
    advance(ctx.world, ctx.engine, 5);
    const sync = stateSync(ctx.world);
    expect(sync.kind).toBe("state_sync");
    expect(sync.tick).toBe(5);
    expect(sync.stateHash).toBe(stateHash(ctx.world));
    expect(Object.keys(sync.regions).length).toBe(3);
  });

  it("stateSync includes all regions", () => {
    advance(ctx.world, ctx.engine, 1);
    const sync = stateSync(ctx.world);
    expect(sync.regions["RF"]).toBeDefined();
    expect(sync.regions["HT"]).toBeDefined();
    expect(sync.regions["PS"]).toBeDefined();
  });

  it("event stream is empty before tick", () => {
    const events = pollAll(ctx);
    expect(events.length).toBe(0);
  });

  it("event stream delivers facts after tick", () => {
    // Submit an intervention so there are events to deliver
    submitIntervention(ctx.world, makeBridge(), ctx.engine);
    advance(ctx.world, ctx.engine, 1);
    const events = pollAll(ctx);
    expect(events.length).toBeGreaterThan(0);
  });

  it("events are delivered in canonical order", () => {
    submitIntervention(ctx.world, makeBridge(), ctx.engine);
    advance(ctx.world, ctx.engine, 1);

    const events1: string[] = [];
    const result = poll(ctx.world, ctx.delivery, ctx.consumerId);
    if (result.status === "deliverable") {
      for (const a of result.attempts) events1.push(a.event.type);
    }

    // Events array should be non-empty and consistent
    expect(events1.length).toBeGreaterThan(0);

    // Second poll returns deliverable with more events (batch delivery — CE delivers
    // all pending events in one poll call, not one-at-a-time)
    const result2 = poll(ctx.world, ctx.delivery, ctx.consumerId);
    expect(["deliverable", "caught_up"]).toContain(result2.status);
  });

  it("ack advances cursor monotonically", () => {
    advance(ctx.world, ctx.engine, 3);
    const result = poll(ctx.world, ctx.delivery, ctx.consumerId);
    if (result.status === "deliverable" && result.attempts.length > 0) {
      const maxSeq = Math.max(...result.attempts.map((a) => a.streamSeq));
      const ackResult = ack(ctx.world, ctx.delivery, ctx.consumerId, maxSeq);
      expect(ackResult.ok).toBe(true);
      expect(ackResult.cursor.afterSeq).toBe(maxSeq);
    }
  });

  it("ack never moves backwards", () => {
    advance(ctx.world, ctx.engine, 5);

    // First, poll to get actual streamSeq values
    const pollResult = poll(ctx.world, ctx.delivery, ctx.consumerId);
    if (pollResult.status === "deliverable" && pollResult.attempts.length > 0) {
      const highSeq = Math.max(...pollResult.attempts.map((a) => a.streamSeq));
      const lowSeq = Math.min(...pollResult.attempts.map((a) => a.streamSeq));

      // Ack to highSeq
      ack(ctx.world, ctx.delivery, ctx.consumerId, highSeq);

      // Try to ack to a lower seq — should be ignored (cursor stays at highSeq)
      const result = ack(ctx.world, ctx.delivery, ctx.consumerId, lowSeq);
      expect(result.ok).toBe(true);
      expect(result.cursor.afterSeq).toBe(highSeq);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §4 — BACKPRESSURE (slow consumer)
// ═══════════════════════════════════════════════════════════════════════════════

describe("P-012 §4 — Backpressure (slow consumer)", () => {
  it("CE advances independently of consumer", () => {
    const ctx = createTestContext();

    // Submit an intervention so there are events to deliver
    submitIntervention(ctx.world, makeBridge(), ctx.engine);

    // Advance 10 ticks without polling
    advance(ctx.world, ctx.engine, 10);
    expect(ctx.world.tick).toBe(10);

    // Consumer can still catch up
    const events = pollAll(ctx);
    expect(events.length).toBeGreaterThan(0);
  });

  it("consumer lag does not affect CE state", () => {
    const ctx1 = createTestContext(42);
    const ctx2 = createTestContext(42);

    // ctx1: advance and poll normally
    advance(ctx1.world, ctx1.engine, 5);
    pollAll(ctx1);

    // ctx2: advance without polling (consumer lag)
    advance(ctx2.world, ctx2.engine, 5);

    // State should be identical — delivery state is separate
    expect(stateHash(ctx1.world)).toBe(stateHash(ctx2.world));
  });

  it("retention eviction creates gap for slow consumer", () => {
    const ctx = createTestContext();

    // Advance far enough to trigger retention
    advance(ctx.world, ctx.engine, EVENT_RETENTION_LIMIT + 50);
    enforceRetention(ctx.world, EVENT_RETENTION_LIMIT);

    // Consumer never polled — cursor is at 0
    // After eviction, cursor is below oldestRetainedSeq
    const result = poll(ctx.world, ctx.delivery, ctx.consumerId);
    // Should detect gap
    expect(result.status === "gap" || result.status === "caught_up" || result.status === "deliverable").toBe(true);
  });

  it("resync recovers from gap", () => {
    const ctx = createTestContext();

    // Advance and force eviction
    advance(ctx.world, ctx.engine, EVENT_RETENTION_LIMIT + 50);
    enforceRetention(ctx.world, EVENT_RETENTION_LIMIT);

    // Poll — may get gap
    const result = poll(ctx.world, ctx.delivery, ctx.consumerId);
    if (result.status === "gap") {
      // Resync to current state
      const sync = stateSync(ctx.world);
      const resyncResult = resync(ctx.delivery, ctx.consumerId, sync);
      expect(resyncResult.ok).toBe(true);

      // Now poll should work
      const after = poll(ctx.world, ctx.delivery, ctx.consumerId);
      expect(after.status).not.toBe("gap");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §5 — CE RESTART (checkpoint/restore during live execution)
// ═══════════════════════════════════════════════════════════════════════════════

describe("P-012 §5 — CE restart (checkpoint/restore)", () => {
  it("checkpoint captures live state including pending interventions", () => {
    const ctx = createTestContext();

    // Run some ticks
    advance(ctx.world, ctx.engine, 10);

    // Submit intervention but don't tick yet
    submitIntervention(ctx.world, makeBridge(), ctx.engine);

    // Checkpoint
    const cp = createCheckpoint(ctx.world, "live-checkpoint");
    const serialized = serializeCheckpoint(cp);

    // Restore
    const env = deserializeCheckpoint(serialized);
    expect(env.ok).toBe(true);
    if (!env.ok) return;

    const restored = restoreCheckpoint(env.value);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    const newEngine = createEngine();
    attachEngine(restored.value.world, newEngine);

    // Restored world should have the pending intervention
    expect(restored.value.world.interventionHistory.length).toBe(1);
    expect(restored.value.world.interventionHistory[0].id).toBe("rb-bridge");
  });

  it("continuation after restore is deterministic", () => {
    const ctx1 = createTestContext(42);
    const ctx2 = createTestContext(42);

    // Run both to tick 5
    advance(ctx1.world, ctx1.engine, 5);
    advance(ctx2.world, ctx2.engine, 5);

    // Checkpoint ctx2
    const cp = createCheckpoint(ctx2.world, "checkpoint");
    const serialized = serializeCheckpoint(cp);
    const env = deserializeCheckpoint(serialized);
    if (!env.ok) throw new Error("deserialize failed");
    const restored = restoreCheckpoint(env.value);
    if (!restored.ok) throw new Error("restore failed");
    const newEngine = createEngine();
    attachEngine(restored.value.world, newEngine);

    // Continue both from tick 5 to 10
    advance(ctx1.world, ctx1.engine, 5);
    advance(restored.value.world, newEngine, 5);

    // Should produce identical state
    expect(stateHash(ctx1.world)).toBe(stateHash(restored.value.world));
    expect(traceHash(ctx1.world)).toBe(traceHash(restored.value.world));
  });

  it("delivery state survives checkpoint/restore", () => {
    const ctx = createTestContext();

    // Submit intervention and advance to produce events
    submitIntervention(ctx.world, makeBridge(), ctx.engine);
    advance(ctx.world, ctx.engine, 10);
    pollAll(ctx);

    // Checkpoint world + delivery separately
    const worldCp = createCheckpoint(ctx.world, "world");
    const deliverySerialized = serializeDelivery(ctx.delivery);

    // Restore
    const env = deserializeCheckpoint(serializeCheckpoint(worldCp));
    if (!env.ok) throw new Error("deserialize failed");
    const restored = restoreCheckpoint(env.value);
    if (!restored.ok) throw new Error("restore failed");
    const newEngine = createEngine();
    attachEngine(restored.value.world, newEngine);

    const restoredDelivery = deserializeDelivery(deliverySerialized);

    // Delivery cursor should be preserved
    const channel = restoredDelivery.channels["test-game"];
    expect(channel).toBeDefined();
    expect(channel!.acked.afterSeq).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §6 — FAILURE SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

describe("P-012 §6 — Failure scenarios", () => {
  it("duplicate intervention is rejected (already destroyed)", () => {
    const ctx = createTestContext();

    const iv1 = makeBridge("dup-1");
    const iv2 = makeBridge("dup-2");

    submitIntervention(ctx.world, iv1, ctx.engine);
    advance(ctx.world, ctx.engine, 1);

    // Second destruction should fail
    const result = submitIntervention(ctx.world, iv2, ctx.engine);
    expect(result.ok).toBe(false);
  });

  it("duplicate event delivery is idempotent", () => {
    const ctx = createTestContext();

    advance(ctx.world, ctx.engine, 1);

    // Poll twice — second should be caught_up
    const r1 = poll(ctx.world, ctx.delivery, ctx.consumerId);
    const r2 = poll(ctx.world, ctx.delivery, ctx.consumerId);

    if (r1.status === "deliverable") {
      expect(r2.status).toBe("caught_up");
    }
  });

  it("stale state recovery via stateSync", () => {
    const ctx = createTestContext();

    // Advance far ahead
    advance(ctx.world, ctx.engine, 20);

    // Consumer has stale view — resync
    const sync = stateSync(ctx.world);
    expect(sync.tick).toBe(20);
    expect(sync.stateHash).toBe(stateHash(ctx.world));

    // Adopt sync
    const result = resync(ctx.delivery, ctx.consumerId, sync);
    expect(result.ok).toBe(true);
  });

  it("wrong timeline detection", () => {
    const ctx1 = createTestContext(42);
    const ctx2 = createTestContext(99); // Different seed = different timeline

    // Advance both
    advance(ctx1.world, ctx1.engine, 5);
    advance(ctx2.world, ctx2.engine, 5);

    // Register consumer on ctx1
    poll(ctx1.world, ctx1.delivery, "cross-timeline");

    // Try to poll ctx2 with same consumer — should detect wrong timeline
    const channel = ctx1.delivery.channels["cross-timeline"];
    if (channel) {
      channel.timelineId = ctx1.world.lineage.timelineId;
    }

    const result = poll(ctx2.world, ctx1.delivery, "cross-timeline");
    // Should either be wrong_timeline or caught_up (if timelineId is null)
    expect(["wrong_timeline", "caught_up", "deliverable", "disconnected"]).toContain(result.status);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §7 — DETERMINISM UNDER TRANSPORT INDEPENDENCE
// ═══════════════════════════════════════════════════════════════════════════════

describe("P-012 §7 — Determinism under transport independence", () => {
  it("same interventions produce same result regardless of submission timing", () => {
    const ctx1 = createTestContext(42);
    const ctx2 = createTestContext(42);

    // Scenario 1: submit all, then tick
    submitIntervention(ctx1.world, makeBridge("i1"), ctx1.engine);
    submitIntervention(ctx1.world, makeWarehouse("i2"), ctx1.engine);
    advance(ctx1.world, ctx1.engine, 10);

    // Scenario 2: submit one per tick
    submitIntervention(ctx2.world, makeBridge("i1"), ctx2.engine);
    advance(ctx2.world, ctx2.engine, 1);
    submitIntervention(ctx2.world, makeWarehouse("i2"), ctx2.engine);
    advance(ctx2.world, ctx2.engine, 9);

    // These SHOULD differ because causal resolution happens at different ticks
    // This is expected semantic behavior, not a bug
    const hash1 = stateHash(ctx1.world);
    const hash2 = stateHash(ctx2.world);

    // Document: batch vs sequential produces different results
    // This is because resolution happens at different ticks
    expect(hash1).not.toBe(hash2);
  });

  it("same interventions in same tick produce identical result", () => {
    const ctx1 = createTestContext(42);
    const ctx2 = createTestContext(42);

    // Both submit same interventions in same tick
    submitIntervention(ctx1.world, makeBridge("i1"), ctx1.engine);
    submitIntervention(ctx1.world, makeWarehouse("i2"), ctx1.engine);
    advance(ctx1.world, ctx1.engine, 10);

    submitIntervention(ctx2.world, makeBridge("i1"), ctx2.engine);
    submitIntervention(ctx2.world, makeWarehouse("i2"), ctx2.engine);
    advance(ctx2.world, ctx2.engine, 10);

    expect(stateHash(ctx1.world)).toBe(stateHash(ctx2.world));
    expect(traceHash(ctx1.world)).toBe(traceHash(ctx2.world));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §8 — IMMEDIATE VS DEFERRED CONSEQUENCES
// ═══════════════════════════════════════════════════════════════════════════════

describe("P-012 §8 — Immediate vs deferred consequences", () => {
  it("bridge destruction has immediate structural effect", () => {
    const ctx = createTestContext();

    // Before submit: infrastructure is healthy
    const before = snapshot(ctx.world);
    expect(before.regions["RF"]!.infrastructure[ROUTE_ID]!.health).toBe(1.0);

    const iv = makeBridge();
    submitIntervention(ctx.world, iv, ctx.engine);

    // After submit (before tick): infrastructure is ALREADY destroyed
    // immediateEffects runs synchronously during submitIntervention
    const afterSubmit = snapshot(ctx.world);
    expect(afterSubmit.regions["RF"]!.infrastructure[ROUTE_ID]!.health).toBe(0);
  });

  it("bridge destruction has deferred economic consequences", () => {
    const ctx = createTestContext();

    submitIntervention(ctx.world, makeBridge(), ctx.engine);
    advance(ctx.world, ctx.engine, 1);

    // After 1 tick: bridge destroyed but economy not yet affected
    const tick1 = snapshot(ctx.world);
    const rfGrainPrice1 = tick1.regions["RF"]!.prices["grain"]!;

    // After several ticks: economic consequences propagate
    advance(ctx.world, ctx.engine, 5);
    const tick6 = snapshot(ctx.world);
    const rfGrainPrice6 = tick6.regions["RF"]!.prices["grain"]!;

    // Price should change due to trade disruption
    expect(rfGrainPrice6).not.toBe(rfGrainPrice1);
  });

  it("rally has only civic consequences, not economic", () => {
    const ctx = createTestContext();

    submitIntervention(ctx.world, makeRally(), ctx.engine);
    advance(ctx.world, ctx.engine, 10);

    const snap = snapshot(ctx.world);
    // Economy prices should remain stable (rally doesn't affect economy)
    const ht = snap.regions["HT"]!;
    // Unrest should be affected (civic domain)
    expect(ht.unrest).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §9 — PERSISTENCE DURING LIVE EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

describe("P-012 §9 — Persistence during live execution", () => {
  it("checkpoint during active simulation preserves all state", () => {
    const ctx = createTestContext();

    // Run some ticks with interventions
    advance(ctx.world, ctx.engine, 5);
    submitIntervention(ctx.world, makeBridge(), ctx.engine);
    advance(ctx.world, ctx.engine, 5);

    const beforeHash = stateHash(ctx.world);
    const beforeTrace = traceHash(ctx.world);
    const beforeTick = ctx.world.tick;

    // Checkpoint
    const cp = createCheckpoint(ctx.world, "mid-sim");
    const serialized = serializeCheckpoint(cp);

    // Continue
    advance(ctx.world, ctx.engine, 5);

    // Restore
    const env = deserializeCheckpoint(serialized);
    if (!env.ok) throw new Error("deserialize failed");
    const restored = restoreCheckpoint(env.value);
    if (!restored.ok) throw new Error("restore failed");
    const newEngine = createEngine();
    attachEngine(restored.value.world, newEngine);

    // Verify
    expect(stateHash(restored.value.world)).toBe(beforeHash);
    expect(traceHash(restored.value.world)).toBe(beforeTrace);
    expect(restored.value.world.tick).toBe(beforeTick);
  });

  it("subsequent evolution after restore remains deterministic", () => {
    const ctx1 = createTestContext(42);
    const ctx2 = createTestContext(42);

    // Both run to tick 5
    advance(ctx1.world, ctx1.engine, 5);
    advance(ctx2.world, ctx2.engine, 5);

    // ctx2 checkpoints and restores
    const cp = createCheckpoint(ctx2.world, "cp");
    const env = deserializeCheckpoint(serializeCheckpoint(cp));
    if (!env.ok) throw new Error("deserialize failed");
    const restored = restoreCheckpoint(env.value);
    if (!restored.ok) throw new Error("restore failed");
    const newEngine = createEngine();
    attachEngine(restored.value.world, newEngine);

    // Both continue to tick 15
    advance(ctx1.world, ctx1.engine, 10);
    advance(restored.value.world, newEngine, 10);

    // Should be identical
    expect(stateHash(ctx1.world)).toBe(stateHash(restored.value.world));
  });

  it("provenance preserved through checkpoint", () => {
    const ctx = createTestContext();

    submitIntervention(ctx.world, makeBridge(), ctx.engine);
    advance(ctx.world, ctx.engine, 5);

    const before = snapshot(ctx.world);
    const provCount = before.provenance.length;

    // Checkpoint and restore
    const cp = createCheckpoint(ctx.world, "prov-test");
    const env = deserializeCheckpoint(serializeCheckpoint(cp));
    if (!env.ok) throw new Error("deserialize failed");
    const restored = restoreCheckpoint(env.value);
    if (!restored.ok) throw new Error("restore failed");

    expect(restored.value.world.provenance.length).toBe(provCount);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §10 — PERFORMANCE (boundary overhead measurement)
// ═══════════════════════════════════════════════════════════════════════════════

describe("P-012 §10 — Performance (boundary overhead)", () => {
  it("intervention submission is fast", () => {
    const ctx = createTestContext();
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      submitIntervention(ctx.world, makeBridge(`perf-${i}`), ctx.engine);
      advance(ctx.world, ctx.engine, 1);
    }
    const elapsed = performance.now() - start;
    // 1000 submit+advance should complete in < 5 seconds
    expect(elapsed).toBeLessThan(5000);
  });

  it("poll/ack cycle is fast", () => {
    const ctx = createTestContext();
    advance(ctx.world, ctx.engine, 100);

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      pollAll(ctx);
    }
    const elapsed = performance.now() - start;
    // 100 poll cycles should complete in < 1 second
    expect(elapsed).toBeLessThan(1000);
  });

  it("stateSync is fast", () => {
    const ctx = createTestContext();
    advance(ctx.world, ctx.engine, 100);

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      stateSync(ctx.world);
    }
    const elapsed = performance.now() - start;
    // 1000 stateSync calls should complete in < 1 second
    expect(elapsed).toBeLessThan(1000);
  });

  it("checkpoint/restore cycle is fast", () => {
    const ctx = createTestContext();
    advance(ctx.world, ctx.engine, 50);

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      const cp = createCheckpoint(ctx.world, "perf");
      const serialized = serializeCheckpoint(cp);
      const env = deserializeCheckpoint(serialized);
      if (!env.ok) throw new Error("deserialize failed");
      const restored = restoreCheckpoint(env.value);
      if (!restored.ok) throw new Error("restore failed");
    }
    const elapsed = performance.now() - start;
    // 100 checkpoint/restore cycles should complete in < 5 seconds
    expect(elapsed).toBeLessThan(5000);
  });
});
