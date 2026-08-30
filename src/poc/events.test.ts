import { describe, expect, it } from "vitest";
import { advance, attachEngine, createEngine, createWorld, submitIntervention } from "../core/world.js";
import { stateHash, traceHash } from "../core/hash.js";
import {
  attributeEvent,
  canonicalOrder,
  coalesceFacts,
  deriveEventId,
  EVENT_CATALOG,
  eventContentHash,
  factStream,
  fullRecord,
  isConsumerFact,
} from "../core/events.js";
import {
  ack,
  createConsumer,
  createDeliveryState,
  DELIVERY_GUARANTEE,

  disconnect,
  poll,
  reconnect,
  registerConsumer,
  resync,
  stateSync,
  streamOf,
} from "../core/delivery.js";
import { createCheckpoint, deserializeCheckpoint, restoreCheckpoint, serializeCheckpoint } from "../core/persistence.js";
import { checkpoint, forkTimeline, interventionsAfter, rewindTo } from "../core/timeline.js";
import { compactHistory, recentWindowPolicy, RESUME_ONLY } from "../core/lifecycle.js";
import { explain, key } from "../core/provenance.js";
import { WORLD_SEED } from "../game/content.js";
import { iBridge, iMerchant, iRally, iSubsidy, iWarehouse } from "./harness.js";
import type { WorldState } from "../core/types.js";

/**
 * Test helper: poll and return the attempts, failing loudly on any non-deliverable status.
 * Tests that specifically exercise gaps/disconnection use `poll` directly.
 */
function attempts(state: WorldState, delivery: ReturnType<typeof createDeliveryState>, id: string) {
  const r = poll(state, delivery, id);
  if (r.status === "gap") throw new Error(`unexpected gap: ${JSON.stringify(r.gap)}`);
  return r.attempts;
}

/**
 * Event stream: ontology, identity, ordering, delivery (docs/RECONNAISSANCE.md §19).
 */

function eventfulWorld(extraTicks = 6): { world: WorldState; engine: ReturnType<typeof createEngine> } {
  const engine = createEngine();
  const world = createWorld({ seed: WORLD_SEED }, engine);
  advance(world, engine, 9);
  submitIntervention(world, iBridge(), engine);
  submitIntervention(world, iWarehouse(), engine);
  advance(world, engine, extraTicks);
  return { world, engine };
}

function forward(source: WorldState, ticks: number): WorldState {
  const w = structuredClone(source);
  advance(w, attachEngine(w, createEngine()), ticks);
  return w;
}

// ===========================================================================
describe("§19.1 event ontology", () => {
  it("every emitted event type is catalogued and classified", () => {
    const { world } = eventfulWorld(10);
    const emitted = new Set(world.events.map((e) => e.type));
    expect(emitted.size).toBeGreaterThan(4);
    for (const type of emitted) {
      const spec = EVENT_CATALOG[type];
      expect(spec, `event type ${type} is not in EVENT_CATALOG`).toBeDefined();
      expect(["fact", "internal"]).toContain(spec!.kind);
      expect(spec!.meaning.length).toBeGreaterThan(10);
    }
  });

  it("engine-internal scheduling detail is NOT delivered as a world fact", () => {
    const { world } = eventfulWorld(8);
    const internal = world.events.filter((e) => !isConsumerFact(e));
    expect(internal.length).toBeGreaterThan(0);
    expect(internal.every((e) => e.type === "world.boundary_signal")).toBe(true);

    // the fact stream excludes them entirely
    expect(factStream(world).some((e) => e.type === "world.boundary_signal")).toBe(false);
    // but the full record retains them for debugging
    expect(fullRecord(world).some((e) => e.type === "world.boundary_signal")).toBe(true);
    expect(fullRecord(world).length).toBeGreaterThan(factStream(world).length);
  });

  it("no fact type is a command or a presentation hint", () => {
    // A fact describes what happened; it must not name a renderer action.
    const forbidden = ["play_", "render_", "show_", "spawn_vfx", "sound"];
    for (const spec of Object.values(EVENT_CATALOG)) {
      for (const word of forbidden) {
        expect(spec.type.includes(word)).toBe(false);
        expect(spec.meaning.toLowerCase().includes(word)).toBe(false);
      }
    }
  });

  it("payload shape is declared, so consumers know delta from level", () => {
    for (const spec of Object.values(EVENT_CATALOG)) {
      expect(["delta", "level", "signal"]).toContain(spec.shape);
    }
  });
});

// ===========================================================================
describe("§19.2 event identity", () => {
  it("identity is deterministic across repeated runs", () => {
    const a = eventfulWorld(6).world;
    const b = eventfulWorld(6).world;
    expect(a.events.map((e) => e.id)).toEqual(b.events.map((e) => e.id));
  });

  it("identity does NOT collide across unrelated timelines (regression)", () => {
    // The defect this pass opened with: a bare counter meant two forks of one checkpoint both
    // minted `ev-22` for different facts.
    // self-harness/failures/2026-08-31-architecture-event-id-collision-across-timelines.json
    const { world } = eventfulWorld(6);
    const cp = checkpoint(world, "fork");
    const a = forkTimeline(cp, "A");
    const b = forkTimeline(cp, "B");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    submitIntervention(a.value.world, iRally("ra"), a.value.engine);
    advance(a.value.world, a.value.engine, 4);
    submitIntervention(b.value.world, iRally("rb"), b.value.engine);
    advance(b.value.world, b.value.engine, 4);

    const idsA = new Set(a.value.world.events.filter((e) => e.tick > cp.identity.tick).map((e) => e.id));
    const newB = b.value.world.events.filter((e) => e.tick > cp.identity.tick);
    expect(newB.length).toBeGreaterThan(0);
    expect(newB.filter((e) => idsA.has(e.id))).toHaveLength(0);
  });

  it("identity survives insertion-order differences in the payload", () => {
    const a = deriveEventId("T-1", 5, 0, "economy.price_shock", "RF", { regionId: "RF", factor: 1.5 });
    const b = deriveEventId("T-1", 5, 0, "economy.price_shock", "RF", { factor: 1.5, regionId: "RF" });
    expect(a).toBe(b);
  });

  it("two genuinely distinct facts with identical content stay distinguishable", () => {
    // Same boundary signal reaching one region from two neighbours: identical payload except
    // position. Content-only identity would merge them.
    const a = deriveEventId("T-1", 5, 0, "world.boundary_signal", "PS", { pressure: 0.3 });
    const b = deriveEventId("T-1", 5, 1, "world.boundary_signal", "PS", { pressure: 0.3 });
    expect(a).not.toBe(b);
    expect(eventContentHash({ id: a, type: "world.boundary_signal", source: "x", regionId: "PS", data: { pressure: 0.3 }, tick: 5, ordinal: 0, streamSeq: 1 })).toBe(
      eventContentHash({ id: b, type: "world.boundary_signal", source: "x", regionId: "PS", data: { pressure: 0.3 }, tick: 5, ordinal: 1, streamSeq: 2 }),
    );
  });

  it("identity uses no clock, counter-of-history, pid or random source", () => {
    const { world } = eventfulWorld(6);
    for (const e of world.events) {
      expect(e.id).toMatch(/^E-[0-9a-f]{16}$/);
    }
    // the same world compacted still mints the same ids (identity is not a function of history length)
    const compacted = structuredClone(world);
    compactHistory(compacted, RESUME_ONLY);
    const again = forward(compacted, 3);
    const fresh = forward(world, 3);
    expect(again.events.map((e) => e.id)).toEqual(fresh.events.map((e) => e.id));
  });
});

// ===========================================================================
describe("§19.3 ordering", () => {
  it("canonical order is total, deterministic, and independent of array order", () => {
    const { world } = eventfulWorld(8);
    const forwardOrder = canonicalOrder(world.events).map((e) => e.id);
    const shuffled = canonicalOrder([...world.events].reverse()).map((e) => e.id);
    expect(shuffled).toEqual(forwardOrder);
  });

  it("ticks are ordered, and within a tick regions group contiguously", () => {
    const { world } = eventfulWorld(10);
    const ordered = canonicalOrder(world.events);
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i]!.tick).toBeGreaterThanOrEqual(ordered[i - 1]!.tick);
    }
    // within one tick, region ids are non-decreasing
    const byTick = new Map<number, typeof ordered>();
    for (const e of ordered) {
      const list = byTick.get(e.tick) ?? [];
      list.push(e);
      byTick.set(e.tick, list);
    }
    for (const list of byTick.values()) {
      const facts = list.filter(isConsumerFact);
      for (let i = 1; i < facts.length; i++) {
        expect((facts[i]!.regionId ?? "") >= (facts[i - 1]!.regionId ?? "")).toBe(true);
      }
    }
  });

  it("ordering covers multi-domain, multi-region, boundary and generated causality", () => {
    const { world } = eventfulWorld(10);
    const domains = new Set(world.events.map((e) => EVENT_CATALOG[e.type]?.domain));
    expect(domains.size).toBeGreaterThanOrEqual(3);
    const regions = new Set(world.events.map((e) => e.regionId));
    expect(regions.size).toBeGreaterThanOrEqual(2);
    expect(world.events.some((e) => e.data["origin"] === "generated")).toBe(true);
    // and the order is still total
    const ordered = canonicalOrder(world.events);
    expect(new Set(ordered.map((e) => e.id)).size).toBe(ordered.length);
  });

  it("same-tick interventions produce a stable canonical order regardless of submission order", () => {
    const build = (reverse: boolean) => {
      const engine = createEngine();
      const world = createWorld({ seed: WORLD_SEED }, engine);
      advance(world, engine, 9);
      const list = [iBridge("i-bridge"), iWarehouse("i-warehouse")];
      for (const i of reverse ? [...list].reverse() : list) submitIntervention(world, i, engine);
      advance(world, engine, 3);
      return factStream(world);
    };
    const fwd = build(false);
    const rev = build(true);
    // identical facts, identical canonical order
    expect(rev.map((e) => `${e.tick}:${e.type}:${e.regionId}`)).toEqual(fwd.map((e) => `${e.tick}:${e.type}:${e.regionId}`));
  });
});

// ===========================================================================
describe("§19.4-19.5 delivery semantics, identity vs sequence", () => {
  it("CE declares at-least-once, and never claims exactly-once", () => {
    expect(DELIVERY_GUARANTEE).toBe("at-least-once");
  });

  it("eventId, streamSeq and attempt are three separate concerns", () => {
    const { world } = eventfulWorld(6);
    const delivery = createDeliveryState();
    const batch = attempts(world, delivery, "c1");
    expect(batch.length).toBeGreaterThan(0);
    let prev = 0;
    for (const attempt of batch) {
      expect(attempt.eventId).toMatch(/^E-/); // stable identity
      expect(attempt.streamSeq).toBeGreaterThan(prev); // monotonic stream coordinate
      expect(attempt.attempt).toBe(1); // delivery attempt number
      prev = attempt.streamSeq;
    }
  });

  it("redelivery is distinguishable from a new fact", () => {
    const { world } = eventfulWorld(6);
    const delivery = createDeliveryState();
    const first = attempts(world, delivery, "c1");
    const again = attempts(world, delivery, "c1"); // no ack in between

    expect(again.map((a) => a.eventId)).toEqual(first.map((a) => a.eventId)); // same identities
    expect(again.every((a) => a.attempt === 2)).toBe(true); // flagged as redelivery
    expect(first.every((a) => a.attempt === 1)).toBe(true);
  });
});

// ===========================================================================
describe("§19.6 acknowledgement and cursors", () => {
  it("acknowledging advances the cursor and stops redelivery", () => {
    const { world } = eventfulWorld(6);
    const delivery = createDeliveryState();
    const batch = attempts(world, delivery, "c1");
    const mid = batch[Math.floor(batch.length / 2)]!.streamSeq;
    const res = ack(world, delivery, "c1", mid);
    expect(res.ok).toBe(true);
    expect(res.cursor.afterSeq).toBe(mid);

    const next = attempts(world, delivery, "c1");
    expect(next.every((a) => a.streamSeq > mid)).toBe(true);
  });

  it("consumer crash before ack: CE replays exactly the unacknowledged tail", () => {
    const { world } = eventfulWorld(6);
    const delivery = createDeliveryState();
    const consumer = createConsumer("c1");

    const batch = attempts(world, delivery, "c1");
    // applies the first three, then "crashes" before acknowledging anything
    for (const a of batch.slice(0, 3)) consumer.apply(a);

    // restart: same channel, cursor never advanced
    const after = attempts(world, delivery, "c1");
    expect(after.map((a) => a.eventId)).toEqual(batch.map((a) => a.eventId));
    // the idempotent consumer recognises what it already applied
    const outcomes = after.map((a) => consumer.apply(a));
    expect(outcomes.slice(0, 3).every((o) => o === "duplicate")).toBe(true);
    expect(consumer.duplicatesSeen).toHaveLength(3);
  });

  it("ack lost then CE restarts: the world resumes and redelivers from the persisted cursor", () => {
    const { world } = eventfulWorld(6);
    const delivery = createDeliveryState();
    const batch = attempts(world, delivery, "c1");
    const upTo = batch[2]!.streamSeq;
    ack(world, delivery, "c1", upTo);

    // CE restarts: world is restored from a checkpoint, delivery state is a SEPARATE artefact
    const env = createCheckpoint(world, "with-undelivered");
    const restored = restoreCheckpoint(env);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    // delivery state survives independently (the consumer or adapter owns it)
    const resumed = attempts(restored.value.world, delivery, "c1");
    expect(resumed.every((a) => a.streamSeq > upTo)).toBe(true);
  });

  it("cursors never move backwards", () => {
    const { world } = eventfulWorld(6);
    const delivery = createDeliveryState();
    const batch = attempts(world, delivery, "c1");
    const high = batch[4]!.streamSeq;
    ack(world, delivery, "c1", high);
    const back = ack(world, delivery, "c1", batch[1]!.streamSeq);
    expect(back.ok).toBe(true);
    expect(back.cursor.afterSeq).toBe(high);
    expect(back.reason).toContain("never moves backwards");
  });

  it("acknowledging beyond the highest emitted sequence is refused", () => {
    const { world } = eventfulWorld(6);
    const delivery = createDeliveryState();
    const res = ack(world, delivery, "c1", world.highestEmittedSeq + 5);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("beyond the highest emitted");
  });
});

// ===========================================================================
describe("§19.7 duplicate delivery (mandatory)", () => {
  it("CE redelivers unacknowledged facts; the CONSUMER is responsible for idempotency", () => {
    const { world } = eventfulWorld(6);
    const delivery = createDeliveryState();
    const consumer = createConsumer("c1");

    const batch = attempts(world, delivery, "c1");
    expect(batch.length).toBeGreaterThan(0);
    const firstId = batch[0]!.eventId;
    expect(consumer.apply(batch[0]!)).toBe("applied");

    // crash before ack -> redelivery
    const redelivered = attempts(world, delivery, "c1");
    const same = redelivered.find((a) => a.eventId === firstId)!;
    expect(same.attempt).toBe(2);
    expect(consumer.apply(same)).toBe("duplicate");

    // CE did NOT suppress it — suppression is the consumer's job, using stable ids
    expect(consumer.applied.filter((id) => id === firstId)).toHaveLength(1);
  });

  it("duplicate delivery is visible, not hidden as an implementation detail", () => {
    const { world } = eventfulWorld(6);
    const delivery = createDeliveryState();
    attempts(world, delivery, "c1");
    attempts(world, delivery, "c1");
    const third = attempts(world, delivery, "c1");
    expect(third.every((a) => a.attempt === 3)).toBe(true);
  });
});

// ===========================================================================
describe("§19.8-19.9 slow and disconnected consumers", () => {
  it("a slow consumer does NOT stall the simulation", () => {
    const { world, engine } = eventfulWorld(4);
    const delivery = createDeliveryState();
    const batch = attempts(world, delivery, "slow");
    ack(world, delivery, "slow", batch[0]!.streamSeq); // acknowledges almost nothing

    const before = world.tick;
    advance(world, engine, 30);
    expect(world.tick).toBe(before + 30);
    expect(streamOf(world).length).toBeGreaterThan(2);
  });

  it("a disconnected consumer receives nothing and the world continues", () => {
    const { world, engine } = eventfulWorld(4);
    const delivery = createDeliveryState();
    registerConsumer(delivery, "c1");
    disconnect(delivery, "c1");

    advance(world, engine, 15);
    const whileOffline = poll(world, delivery, "c1");
    expect(whileOffline.status).toBe("disconnected");
    expect(whileOffline.attempts).toHaveLength(0);

    reconnect(delivery, "c1");
    const batch = attempts(world, delivery, "c1");
    expect(batch.length).toBeGreaterThan(0);
    expect(batch[0]!.streamSeq).toBe(1); // resumes from the very beginning of its cursor
  });

  it("a caught-up consumer reports caught_up, never a gap", () => {
    const { world } = eventfulWorld(6);
    const delivery = createDeliveryState();
    const batch = attempts(world, delivery, "c1");
    ack(world, delivery, "c1", batch[batch.length - 1]!.streamSeq);
    const result = poll(world, delivery, "c1");
    expect(result.status).toBe("caught_up");
    expect(result.attempts).toHaveLength(0);
  });
});

// ===========================================================================
describe("§19.10 event loss and state recovery; event vs state", () => {
  it("a lossy consumer recovers via state sync instead of replaying every missed fact", () => {
    const { world, engine } = eventfulWorld(6);
    const delivery = createDeliveryState();
    registerConsumer(delivery, "lossy");
    advance(world, engine, 20);

    const sync = stateSync(world);
    expect(sync.kind).toBe("state_sync");
    expect(sync.stateHash).toBe(stateHash(world));
    // LEVELS, not transitions
    expect(typeof sync.regions["RF"]!.grainPrice).toBe("number");

    const res = resync(delivery, "lossy", sync);
    expect(res.ok).toBe(true);
    expect(res.cursor.afterSeq).toBe(sync.streamSeq);
    // nothing further is replayed: the consumer is current by construction
    expect(poll(world, delivery, "lossy").status).toBe("caught_up");
  });

  it("state sync tells current truth; the stream tells transitions", () => {
    const { world, engine } = eventfulWorld(4);
    advance(world, engine, 25);

    const priceFacts = factStream(world).filter((e) => e.type === "economy.price_shock");
    expect(priceFacts.length).toBeGreaterThan(0);
    for (const e of priceFacts) {
      // a delta fact carries a factor, not the resulting price
      expect(typeof e.data["factor"]).toBe("number");
      expect(e.data["price"]).toBeUndefined();
    }
    // the level lives in state sync
    const sync = stateSync(world);
    expect(sync.regions["RF"]!.grainPrice).toBeGreaterThan(0);
  });

  it("consumers are NOT required to fold events to learn the world (CE is not event-sourced)", () => {
    const { world, engine } = eventfulWorld(4);
    advance(world, engine, 20);
    // a consumer that applied ZERO events can still be fully correct via state sync
    const sync = stateSync(world);
    expect(sync.regions["RF"]!.grainPrice).toBe(world.regions["RF"]!.prices["grain"]);
    expect(sync.relations).toEqual(world.relations);
  });
});

// ===========================================================================
describe("§19.11 events, delivery state and stateHash", () => {
  it("consumer acknowledgement state cannot alter the simulated world", () => {
    const { world } = eventfulWorld(6);
    const before = stateHash(world);
    const beforeTrace = traceHash(world);

    const delivery = createDeliveryState();
    poll(world, delivery, "c1");
    ack(world, delivery, "c1", 2);
    disconnect(delivery, "c1");
    poll(world, delivery, "c2");

    expect(stateHash(world)).toBe(before);
    expect(traceHash(world)).toBe(beforeTrace);
  });

  it("delivery state is not part of WorldState at all", () => {
    const { world } = eventfulWorld(4);
    expect(world as unknown as Record<string, unknown>).not.toHaveProperty("delivery");
    expect(world as unknown as Record<string, unknown>).not.toHaveProperty("cursors");
    expect(world as unknown as Record<string, unknown>).not.toHaveProperty("channels");
  });

  it("the fact record is HISTORY: excluded from stateHash, included in traceHash", () => {
    const { world } = eventfulWorld(6);
    const dropped = structuredClone(world);
    dropped.events = [];
    expect(stateHash(dropped)).toBe(stateHash(world));
    expect(traceHash(dropped)).not.toBe(traceHash(world));
  });

  it("two physically identical worlds in different timelines compare equal on physics", () => {
    // This is what broke when timeline-scoped event ids were inside stateHash.
    const { world } = eventfulWorld(0);
    const cp = checkpoint(world, "fork");
    const runOrder = (label: string, reverse: boolean) => {
      const f = forkTimeline(cp, label);
      if (!f.ok) throw new Error("fork failed");
      const list = [iBridge("i-bridge"), iWarehouse("i-warehouse")];
      for (const i of reverse ? [...list].reverse() : list) submitIntervention(f.value.world, i, f.value.engine);
      advance(f.value.world, f.value.engine, 12);
      return f.value.world;
    };
    const a = runOrder("a", false);
    const b = runOrder("b", true);
    const physical = (w: WorldState) => {
      const c = structuredClone(w);
      c.lineage = { ...c.lineage, timelineId: "T-x", parentTimelineId: null, parentCheckpointId: null, forkTick: null, generation: 0 };
      return stateHash(c);
    };
    expect(physical(a)).toBe(physical(b));
    expect(traceHash(a)).not.toBe(traceHash(b));
  });

  it("the engine never reads the fact record: forward evolution is unaffected by emptying it", () => {
    const { world } = eventfulWorld(6);
    const emptied = structuredClone(world);
    emptied.events = [];
    expect(stateHash(forward(emptied, 25))).toBe(stateHash(forward(world, 25)));
  });
});

// ===========================================================================
describe("§19.12 events and persistence", () => {
  it("undelivered facts survive checkpoint and restore", () => {
    const { world } = eventfulWorld(6);
    const pendingCount = streamOf(world).length;
    expect(pendingCount).toBeGreaterThan(0);

    const env = createCheckpoint(world, "undelivered");
    const parsed = deserializeCheckpoint(serializeCheckpoint(env));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const restored = restoreCheckpoint(parsed.value);
    if (!restored.ok) throw new Error("restore failed");

    expect(streamOf(restored.value.world).map((e) => e.id)).toEqual(streamOf(world).map((e) => e.id));
  });

  it("restore + resume delivers no duplicates beyond the documented at-least-once guarantee", () => {
    const { world } = eventfulWorld(6);
    const delivery = createDeliveryState();
    const consumer = createConsumer("c1");

    const batch = attempts(world, delivery, "c1");
    for (const a of batch) consumer.apply(a);
    ack(world, delivery, "c1", batch[batch.length - 1]!.streamSeq);

    const env = createCheckpoint(world);
    const restored = restoreCheckpoint(env);
    if (!restored.ok) throw new Error("restore failed");

    const afterRestore = poll(restored.value.world, delivery, "c1");
    expect(afterRestore.status).toBe("caught_up"); // nothing redelivered: cursor was acknowledged
    expect(consumer.duplicatesSeen).toHaveLength(0);
  });

  it("checkpointing does not weaken hashes to accommodate delivery", () => {
    const { world } = eventfulWorld(6);
    const delivery = createDeliveryState();
    poll(world, delivery, "c1");
    const env = createCheckpoint(world);
    // identity is unchanged by the fact that a consumer polled
    expect(env.identity.stateHash).toBe(stateHash(world));
    expect(env.identity.traceHash).toBe(traceHash(world));
  });
});

// ===========================================================================
describe("§19.13 events and branching", () => {
  it("branch fact identities are isolated even for identical content", () => {
    const { world } = eventfulWorld(0);
    const cp = checkpoint(world, "fork");
    const a = forkTimeline(cp, "A");
    const b = forkTimeline(cp, "B");
    if (!a.ok || !b.ok) return;

    // IDENTICAL intervention in both branches -> identical fact content
    submitIntervention(a.value.world, iBridge("same"), a.value.engine);
    submitIntervention(b.value.world, iBridge("same"), b.value.engine);
    advance(a.value.world, a.value.engine, 5);
    advance(b.value.world, b.value.engine, 5);

    const factsA = factStream(a.value.world).filter((e) => e.tick > cp.identity.tick);
    const factsB = factStream(b.value.world).filter((e) => e.tick > cp.identity.tick);
    expect(factsA.length).toBeGreaterThan(0);
    expect(factsA.length).toBe(factsB.length);

    // same content...
    expect(factsB.map(eventContentHash)).toEqual(factsA.map(eventContentHash));
    // ...different identity
    const idsA = new Set(factsA.map((e) => e.id));
    expect(factsB.filter((e) => idsA.has(e.id))).toHaveLength(0);
  });

  it("converged worlds may still have divergent event histories", () => {
    const { world } = eventfulWorld(0);
    const cp = checkpoint(world, "fork");
    const runOrder = (label: string, reverse: boolean) => {
      const f = forkTimeline(cp, label);
      if (!f.ok) throw new Error("fork failed");
      const list = [iBridge("i-bridge"), iWarehouse("i-warehouse")];
      for (const i of reverse ? [...list].reverse() : list) submitIntervention(f.value.world, i, f.value.engine);
      advance(f.value.world, f.value.engine, 12);
      return f.value.world;
    };
    const a = runOrder("a", false);
    const b = runOrder("b", true);

    const physical = (w: WorldState) => {
      const c = structuredClone(w);
      c.lineage = { ...c.lineage, timelineId: "T-x", parentTimelineId: null, parentCheckpointId: null, forkTick: null, generation: 0 };
      return stateHash(c);
    };
    expect(physical(a)).toBe(physical(b)); // same world
    expect(traceHash(a)).not.toBe(traceHash(b)); // different history, including facts
  });
});

// ===========================================================================
describe("§19.14 events and rewind", () => {
  it("facts after the rewind point leave the live timeline but stay addressable in the abandoned one", () => {
    const { world, engine } = eventfulWorld(4);
    const cp = checkpoint(world, "rewind-point");
    const factsAtCheckpoint = new Set(cp.world.events.map((e) => e.id));

    submitIntervention(world, iRally("post"), engine);
    advance(world, engine, 8);
    const laterFacts = world.events.filter((e) => !factsAtCheckpoint.has(e.id));
    expect(laterFacts.length).toBeGreaterThan(0);
    const abandonedIds = laterFacts.map((e) => e.id);

    const rw = rewindTo(cp, world);
    expect(rw.ok).toBe(true);
    if (!rw.ok) return;

    // gone from the live timeline
    const liveIds = new Set(rw.value.world.events.map((e) => e.id));
    expect(abandonedIds.filter((id) => liveIds.has(id))).toHaveLength(0);
    // and the abandoned timeline is still referenceable with its interventions
    expect(rw.value.world.lineage.abandonedTimelines[0]!.interventionIds).toContain("post");
  });

  it("re-generated facts after a rewind receive NEW identities (new timeline)", () => {
    const { world, engine } = eventfulWorld(4);
    const cp = checkpoint(world, "rp");
    submitIntervention(world, iRally("post"), engine);
    advance(world, engine, 6);
    const originalIds = new Set(world.events.map((e) => e.id));

    const rw = rewindTo(cp, world);
    if (!rw.ok) return;
    // replay the SAME action on the rewound (new) timeline
    submitIntervention(rw.value.world, iRally("post"), rw.value.engine);
    advance(rw.value.world, rw.value.engine, 6);

    const newFacts = rw.value.world.events.filter((e) => e.tick > cp.identity.tick);
    expect(newFacts.length).toBeGreaterThan(0);
    // identity is timeline-scoped, so these are new ids even though content matches
    expect(newFacts.filter((e) => originalIds.has(e.id))).toHaveLength(0);
  });

  it("replaying an abandoned future on its ORIGINAL timeline reproduces the original ids", () => {
    // Identity is a function of (timeline, tick, ordinal, content) — so a faithful replay of
    // the same timeline reproduces the same fact ids exactly.
    const { world, engine } = eventfulWorld(4);
    const cp = checkpoint(world, "rp");
    submitIntervention(world, iRally("post"), engine);
    advance(world, engine, 6);
    const expectedIds = world.events.map((e) => e.id);

    const replay = structuredClone(cp.world);
    const replayEngine = attachEngine(replay, createEngine());
    for (const i of interventionsAfter(cp, world)) submitIntervention(replay, i, replayEngine);
    advance(replay, replayEngine, 6);

    expect(replay.events.map((e) => e.id)).toEqual(expectedIds);
  });
});

// ===========================================================================
describe("§19.15 event compaction / coalescing", () => {
  it("delta facts of the same type and region coalesce into one summary", () => {
    const { world, engine } = eventfulWorld(4);
    advance(world, engine, 30);
    const shocks = factStream(world).filter((e) => e.type === "economy.price_shock");
    expect(shocks.length).toBeGreaterThan(1);

    const coalesced = coalesceFacts(shocks);
    expect(coalesced.length).toBeLessThan(shocks.length);
    for (const c of coalesced) {
      expect(c.coalesced).toBe(true);
      expect(c.count).toBeGreaterThan(0);
      expect(c.sourceEventIds).toHaveLength(c.count);
      expect(typeof c.aggregate["factor"]).toBe("number");
    }
  });

  it("signal facts are NOT coalesced: they are not quantities", () => {
    const { world, engine } = eventfulWorld(4);
    advance(world, engine, 20);
    const coalesced = coalesceFacts(factStream(world));
    expect(coalesced.some((c) => c.type === "economy.trade_disruption")).toBe(false);
  });

  it("coalescing never mutates the authoritative record or provenance", () => {
    const { world, engine } = eventfulWorld(4);
    advance(world, engine, 20);
    const eventsBefore = JSON.stringify(world.events);
    const provBefore = JSON.stringify(world.provenance);
    coalesceFacts(factStream(world));
    expect(JSON.stringify(world.events)).toBe(eventsBefore);
    expect(JSON.stringify(world.provenance)).toBe(provBefore);
  });

  it("a coalesced summary stays traceable to the facts it replaced", () => {
    const { world, engine } = eventfulWorld(4);
    advance(world, engine, 25);
    const facts = factStream(world);
    const ids = new Set(facts.map((e) => e.id));
    for (const c of coalesceFacts(facts)) {
      for (const id of c.sourceEventIds) expect(ids.has(id)).toBe(true);
    }
  });
});

// ===========================================================================
describe("§19.16 causal attribution", () => {
  it("a fact references its cause rather than embedding the provenance graph", () => {
    const { world } = eventfulWorld(6);
    for (const e of factStream(world)) {
      // no fact carries a nested graph
      expect(e.data["provenance"]).toBeUndefined();
      expect(e.data["nodes"]).toBeUndefined();
      const attribution = attributeEvent(world, e);
      expect(attribution.eventId).toBe(e.id);
      expect(typeof attribution.tick).toBe("number");
    }
  });

  it("attribution reports honestly when the referenced node has been evicted", () => {
    const { world } = eventfulWorld(6);
    const ev = factStream(world)[0]!;
    const withCause = structuredClone(world);
    const anyNode = withCause.provenance[0]!.id;
    // attach a cause reference, then evict the node it points at
    const target = withCause.events.find((e) => e.id === ev.id)!;
    target.data = { ...target.data, causeNode: anyNode };

    expect(attributeEvent(withCause, target).causeAvailable).toBe(true);
    withCause.provenance = withCause.provenance.filter((n) => n.id !== anyNode);
    withCause.historyTruncated = true;
    const after = attributeEvent(withCause, target);
    expect(after.causeNodeId).toBe(anyNode);
    expect(after.causeAvailable).toBe(false); // honest: cause named, evidence gone
  });

  it("a fact with no cause reference says so rather than inventing one", () => {
    const { world } = eventfulWorld(6);
    const ev = factStream(world)[0]!;
    const a = attributeEvent(world, ev);
    expect(a.causeNodeId).toBeNull();
    expect(a.causeAvailable).toBe(false);
  });

  it("deeper causal questions are answered by explain(), not by fattening events", () => {
    const { world } = eventfulWorld(8);
    const ex = explain(world, key.price("RF", "grain"));
    expect(ex.explained).toBe(true);
    expect(ex.roots.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
describe("§19.17 consumer failure model boundary", () => {
  it("CE guarantees identity, order and replay; the consumer guarantees idempotency", () => {
    const { world } = eventfulWorld(6);
    const delivery = createDeliveryState();

    // A NON-idempotent consumer double-applies on redelivery. CE does not prevent this.
    let applications = 0;
    const naive = { apply: () => { applications += 1; } };

    const first = attempts(world, delivery, "naive");
    for (const _ of first) naive.apply();
    const second = attempts(world, delivery, "naive"); // no ack -> redelivery
    for (const _ of second) naive.apply();

    expect(applications).toBe(first.length + second.length);
    // ...whereas an idempotent consumer using the stable ids is correct
    const good = createConsumer("good");
    const a = attempts(world, delivery, "good");
    for (const x of a) good.apply(x);
    const b = attempts(world, delivery, "good");
    for (const x of b) good.apply(x);
    expect(good.applied).toHaveLength(a.length);
  });

  it("multiple independent consumers do not interfere with each other", () => {
    const { world } = eventfulWorld(6);
    const delivery = createDeliveryState();
    const fast = attempts(world, delivery, "fast");
    ack(world, delivery, "fast", fast[fast.length - 1]!.streamSeq);

    const slow = attempts(world, delivery, "slow");
    expect(slow.length).toBe(fast.length); // slow consumer still sees everything
    expect(poll(world, delivery, "fast").status).toBe("caught_up");
  });

  it("no transport infrastructure is present in the core", () => {
    // The delivery layer is pure data + pure functions: no sockets, timers, brokers or queues.
    const delivery = createDeliveryState();
    expect(Object.keys(delivery)).toEqual(["channels"]);
    const channel = registerConsumer(delivery, "c1");
    expect(Object.keys(channel).sort()).toEqual([
      "acked",
      "attempts",
      "connected",
      "consumerId",
      "inFlight",
      "timelineId",
    ]);
  });
});
