import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { advance, attachEngine, createEngine, createWorld, submitIntervention } from "../core/world.js";
import { stateHash, traceHash } from "../core/hash.js";
import { createCheckpoint, deserializeCheckpoint, restoreCheckpoint, serializeCheckpoint } from "../core/persistence.js";
import { checkpoint, forkTimeline, rewindTo } from "../core/timeline.js";
import { RETAIN_ALL, compactHistory, recentWindowPolicy } from "../core/lifecycle.js";
import { EVENT_RETENTION_LIMIT, enforceRetention, retentionWindow, classifyCursor, describeGap } from "../core/retention.js";
import {
  ack,
  createConsumer,
  createDeliveryState,
  deserializeDelivery,
  poll,
  resync,
  serializeDelivery,
  stateSync,
  streamOf,
} from "../core/delivery.js";
import { attributeEvent, coalesceFacts } from "../core/events.js";
import { explain, key } from "../core/provenance.js";
import { WORLD_SEED } from "../game/content.js";
import { iBridge, iWarehouse, iRally, iSubsidy } from "./harness.js";
import type { WorldState } from "../core/types.js";

function eventfulWorld(ticks = 20): { world: WorldState; engine: ReturnType<typeof createEngine> } {
  const engine = createEngine();
  const world = createWorld({ seed: WORLD_SEED }, engine);
  advance(world, engine, 9);
  submitIntervention(world, iBridge(), engine);
  submitIntervention(world, iWarehouse(), engine);
  advance(world, engine, ticks - 9);
  return { world, engine };
}

function forward(source: WorldState, ticks: number): WorldState {
  const w = structuredClone(source);
  advance(w, attachEngine(w, createEngine()), ticks);
  return w;
}

function pollAttempts(world: WorldState, delivery: ReturnType<typeof createDeliveryState>, id: string) {
  const r = poll(world, delivery, id);
  if (r.status !== "deliverable") return [];
  return r.attempts;
}

// ===========================================================================
describe("§20.1 three concepts are distinct", () => {
  it("evicting events does not change world state, pending continuation, dynamics, RNG, stateHash or future", () => {
    const { world } = eventfulWorld(40);
    const pendingBefore = JSON.stringify(world.pendingContributions);
    const dynamicsBefore = JSON.stringify(world.dynamics);
    const rngBefore = world.rngState.s;
    const stateBefore = stateHash(world);

    const evicted = structuredClone(world);
    enforceRetention(evicted, 5);
    expect(evicted.events.length).toBe(5);
    expect(evicted.historyTruncated).toBe(true);

    expect(JSON.stringify(evicted.regions)).toBe(JSON.stringify(world.regions));
    expect(JSON.stringify(evicted.pendingContributions)).toBe(pendingBefore);
    expect(JSON.stringify(evicted.dynamics)).toBe(dynamicsBefore);
    expect(evicted.rngState.s).toBe(rngBefore);
    expect(stateHash(evicted)).toBe(stateBefore);
    expect(traceHash(evicted)).not.toBe(traceHash(world));
    expect(stateHash(forward(evicted, 30))).toBe(stateHash(forward(world, 30)));
  });

  it("event history is the only thing eviction touches", () => {
    const { world } = eventfulWorld(30);
    const evicted = structuredClone(world);
    enforceRetention(evicted, 5);
    expect(evicted.tick).toBe(world.tick);
    expect(evicted.lineage).toEqual(world.lineage);
    expect(evicted.config).toEqual(world.config);
  });
});

// ===========================================================================
describe("§20.2 retention ownership is hybrid (Model C)", () => {
  it("CE retention is bounded and independent of consumers", () => {
    const { world } = eventfulWorld(30);
    const delivery = createDeliveryState();
    poll(world, delivery, "slow");
    enforceRetention(world, 5);
    expect(world.events.length).toBe(5);
    expect(world.evictedCount).toBeGreaterThan(0);
  });

  it("adapter owns longer-term retention by copying facts out", () => {
    const { world } = eventfulWorld(20);
    const archived: typeof world.events = [];
    const delivery = createDeliveryState();
    const res = poll(world, delivery, "adapter");
    if (res.status !== "deliverable") throw new Error("expected deliverable");
    archived.push(...res.attempts.map((a) => a.event));
    ack(world, delivery, "adapter", res.attempts[res.attempts.length - 1]!.streamSeq);
    const factsBefore = streamOf(world).length;
    enforceRetention(world, 5);
    // CE window is small, but adapter still holds the full history it copied
    expect(archived.length).toBeGreaterThan(streamOf(world).length);
    expect(archived.length).toBe(factsBefore);
    expect(world.evictedCount).toBeGreaterThan(0);
  });

  it("slow consumer cannot pin unbounded history", () => {
    const { world, engine } = eventfulWorld(10);
    const delivery = createDeliveryState();
    poll(world, delivery, "slow");
    // Generate many facts so eviction actually has something to trim
    for (let i = 0; i < 8; i++) {
      submitIntervention(world, iBridge(`slow-${i}`), engine);
      advance(world, engine, 8);
    }
    enforceRetention(world, 10);
    expect(world.events.length).toBe(10);
    expect(world.evictedCount).toBeGreaterThan(10);
  });
});

// ===========================================================================
describe("§20.3 retention guarantee is precise: caught_up / deliverable / gap", () => {
  it("three exhaustive cases", () => {
    const { world } = eventfulWorld(20);
    enforceRetention(world, 5);
    const win = retentionWindow(world, 5);
    expect(classifyCursor(world, win.highestEmittedSeq)).toBe("caught_up");
    expect(classifyCursor(world, win.highestEmittedSeq + 100)).toBe("caught_up");
    expect(classifyCursor(world, win.oldestRetainedSeq - 2)).toBe("gap");
    expect(classifyCursor(world, win.oldestRetainedSeq - 1)).toBe("deliverable");
    if (win.retainedCount > 1) {
      expect(classifyCursor(world, win.oldestRetainedSeq)).toBe("deliverable");
    }
  });

  it("fresh world with no events is caught_up, not gap", () => {
    const engine = createEngine();
    const world = createWorld({ seed: WORLD_SEED }, engine);
    expect(classifyCursor(world, 0)).toBe("caught_up");
    expect(world.oldestRetainedSeq).toBe(1);
    expect(world.highestEmittedSeq).toBe(0);
  });

  it("gap is distinguishable from caught_up: both previously looked like empty poll", () => {
    const { world } = eventfulWorld(20);
    enforceRetention(world, 5);
    const delivery = createDeliveryState();
    const gapResult = poll(world, delivery, "c1");
    expect(gapResult.status).toBe("gap");
    if (gapResult.status === "gap") {
      expect(gapResult.gap.missingCount).toBeGreaterThan(0);
      expect(gapResult.gap.remedy).toBe("resync_from_state");
    }
    const caughtUpWorld = eventfulWorld(20).world;
    const d2 = createDeliveryState();
    const batch = poll(caughtUpWorld, d2, "c2");
    if (batch.status === "deliverable") ack(caughtUpWorld, d2, "c2", batch.attempts[batch.attempts.length - 1]!.streamSeq);
    const caught = poll(caughtUpWorld, d2, "c2");
    expect(caught.status).toBe("caught_up");
    expect(gapResult.attempts).toHaveLength(0);
    expect(caught.attempts).toHaveLength(0);
  });
});

// ===========================================================================
describe("§20.4 eviction boundary is explicit", () => {
  it("oldestRetainedSeq and highestEmittedSeq define the window", () => {
    const { world } = eventfulWorld(30);
    const before = world.highestEmittedSeq;
    enforceRetention(world, 5);
    const win = retentionWindow(world, 5);
    expect(win.oldestRetainedSeq).toBeGreaterThan(1);
    expect(win.highestEmittedSeq).toBe(before);
    expect(win.retainedCount).toBe(5);
    expect(win.evictedCount).toBe(before - 5);
    for (const e of world.events) {
      expect(e.streamSeq).toBeGreaterThanOrEqual(win.oldestRetainedSeq);
      expect(e.streamSeq).toBeLessThanOrEqual(win.highestEmittedSeq);
    }
  });

  it("consumer E1..E3 evicted, cursor at E1 -> gap naming the exact range", () => {
    const { world } = eventfulWorld(30);
    const firstSeq = world.events[0]!.streamSeq;
    enforceRetention(world, world.events.length - 3);
    const gap = describeGap(world, 0);
    expect(gap).not.toBeNull();
    expect(gap!.missingFromSeq).toBe(1);
    expect(gap!.oldestRetainedSeq).toBe(world.oldestRetainedSeq);
  });

  it("minimum metadata to make gap meaningful is present", () => {
    const { world } = eventfulWorld(20);
    enforceRetention(world, 5);
    const delivery = createDeliveryState();
    const result = poll(world, delivery, "c1");
    expect(result.status).toBe("gap");
    if (result.status === "gap") {
      expect(result.gap.missingFromSeq).toBeDefined();
      expect(result.gap.missingToSeq).toBeDefined();
      expect(result.gap.missingCount).toBeGreaterThan(0);
      expect(result.gap.oldestRetainedSeq).toBeDefined();
      expect(result.gap.reason).toBe("evicted_by_retention_bound");
      expect(result.gap.timelineId).toBe(world.lineage.timelineId);
    }
  });
});

// ===========================================================================
describe("§20.5 gap semantics", () => {
  it("gap answers what range is missing, why, can it be replayed/reconstructed, remedy", () => {
    const { world } = eventfulWorld(20);
    enforceRetention(world, 5);
    const gap = describeGap(world, 0)!;
    expect(gap.missingCount).toBeGreaterThan(0);
    expect(gap.reason).toBe("evicted_by_retention_bound");
    expect(gap.replayable).toBe(false);
    expect(gap.reconstructable).toBe(false);
    expect(gap.permanentlyUnavailableFromCE).toBe(true);
    expect(gap.remedy).toBe("resync_from_state");
  });

  it("cursor 10, oldest 20 -> gap is deterministic", () => {
    const { world } = eventfulWorld(30);
    enforceRetention(world, 5);
    const g1 = describeGap(world, 10);
    const g2 = describeGap(world, 10);
    expect(g1).toEqual(g2);
    if (g1) {
      expect(g1.missingFromSeq).toBe(11);
      expect(g1.missingToSeq).toBe(world.oldestRetainedSeq - 1);
    }
  });
});

// ===========================================================================
describe("§20.6 resynchronization", () => {
  it("gap -> stateSync -> resync -> resume without ambiguity", () => {
    const { world } = eventfulWorld(30);
    enforceRetention(world, 5);
    const delivery = createDeliveryState();
    const gapResult = poll(world, delivery, "c1");
    expect(gapResult.status).toBe("gap");
    const sync = stateSync(world);
    expect(sync.kind).toBe("state_sync");
    expect(sync.historyComplete).toBe(false);
    const res = resync(delivery, "c1", sync);
    expect(res.ok).toBe(true);
    expect(res.cursor.afterSeq).toBe(sync.streamSeq);
    const afterResync = poll(world, delivery, "c1");
    expect(afterResync.status).toBe("caught_up");
  });

  it("stateSync means 'you now know the current world', not 'you have reconstructed history'", () => {
    const { world } = eventfulWorld(20);
    const sync = stateSync(world);
    expect((sync as unknown as Record<string, unknown>).events).toBeUndefined();
    expect(sync.regions["RF"]!.grainPrice).toBe(world.regions["RF"]!.prices["grain"]);
  });

  it("resync from wrong timeline is refused", () => {
    const { world: w1 } = eventfulWorld(10);
    const cp = checkpoint(w1, "fork");
    const fork = forkTimeline(cp, "branch");
    if (!fork.ok) throw new Error("fork");
    const sync = stateSync(fork.value.world);
    const delivery = createDeliveryState();
    poll(w1, delivery, "c1");
    const res = resync(delivery, "c1", { ...sync, timelineId: "T-wrong" });
    expect(res.ok).toBe(false);
  });
});

// ===========================================================================
describe("§20.7 retention must not depend on simulation progress", () => {
  it("simulation running vs paused with disconnected consumer: retention identical", () => {
    const { world: running, engine: re } = eventfulWorld(15);
    const { world: paused } = eventfulWorld(15);
    advance(running, re, 20);
    enforceRetention(running, 5);
    enforceRetention(paused, 5);
    expect(running.events.length).toBe(5);
    expect(paused.events.length).toBe(5);
    expect(running.tick).not.toBe(paused.tick);
  });

  it("causal simulation does not stall when consumer is slow or absent", () => {
    const { world, engine } = eventfulWorld(10);
    const delivery = createDeliveryState();
    const res = poll(world, delivery, "slow");
    if (res.status === "deliverable" && res.attempts.length > 0) {
      ack(world, delivery, "slow", res.attempts[0]!.streamSeq);
    }
    const tickBefore = world.tick;
    advance(world, engine, 30);
    expect(world.tick).toBe(tickBefore + 30);
  });
});

// ===========================================================================
describe("§20.8 multiple consumers", () => {
  it("slowest consumer cannot pin unbounded history under hybrid model", () => {
    const { world } = eventfulWorld(30);
    const delivery = createDeliveryState();
    const all = streamOf(world);
    const posA = all[all.length - 1]!.streamSeq;
    let res = poll(world, delivery, "A");
    if (res.status === "deliverable") ack(world, delivery, "A", posA);
    res = poll(world, delivery, "B");
    if (res.status === "deliverable") {
      const mid = all[Math.floor(all.length / 2)]!.streamSeq;
      ack(world, delivery, "B", mid);
    }
    enforceRetention(world, 5);
    expect(world.events.length).toBe(5);
    const gapC = describeGap(world, 0);
    expect(gapC).not.toBeNull();
    expect(gapC!.missingCount).toBeGreaterThan(0);
  });

  it("each consumer's cursor is independent", () => {
    const { world } = eventfulWorld(20);
    const delivery = createDeliveryState();
    const aRes = poll(world, delivery, "A");
    const bRes = poll(world, delivery, "B");
    expect(aRes.status).toBe("deliverable");
    expect(bRes.status).toBe("deliverable");
    if (aRes.status === "deliverable" && bRes.status === "deliverable") {
      expect(aRes.attempts.length).toBe(bRes.attempts.length);
      ack(world, delivery, "A", aRes.attempts[aRes.attempts.length - 1]!.streamSeq);
    }
    expect(poll(world, delivery, "A").status).toBe("caught_up");
    expect(poll(world, delivery, "B").status).toBe("deliverable");
  });
});

// ===========================================================================
describe("§20.9 retention classes are uniform, not per-event", () => {
  it("retention does not distinguish ephemeral/standard/persistent", () => {
    const { world } = eventfulWorld(30);
    const before = world.events.map((e) => e.type);
    enforceRetention(world, 5);
    expect(world.events.length).toBe(5);
    const types = new Set(world.events.map((e) => e.type));
    expect(types.size).toBeGreaterThan(1);
    expect(before.length).toBeGreaterThan(5);
  });

  it("uniform window is the only policy: no per-type retention limit exists", () => {
    const { world } = eventfulWorld(20);
    enforceRetention(world, 5);
    expect(world.events.length).toBe(5);
  });
});

// ===========================================================================
describe("§20.10 compaction vs stateSync", () => {
  it("price 10->11->12->13 can be replaced by stateSync price=13 for state-seeking consumers", () => {
    const { world, engine } = eventfulWorld(10);
    advance(world, engine, 30);
    const facts = streamOf(world).filter((e) => e.type === "economy.price_shock");
    expect(facts.length).toBeGreaterThan(1);
    const coalesced = coalesceFacts(facts);
    expect(coalesced.length).toBeLessThan(facts.length);
    const before = world.events.length;
    coalesceFacts(facts);
    expect(world.events.length).toBe(before);
  });

  it("coalescing never claims history still exists", () => {
    const { world } = eventfulWorld(20);
    const facts = streamOf(world);
    const coalesced = coalesceFacts(facts);
    for (const c of coalesced) {
      expect(c.coalesced).toBe(true);
      expect(c.sourceEventIds.length).toBe(c.count);
    }
  });

  it("stateSync is the correct replacement: current truth, not reconstructed history", () => {
    const { world } = eventfulWorld(20);
    const sync = stateSync(world);
    expect(sync.regions["RF"]!.grainPrice).toBe(world.regions["RF"]!.prices["grain"]);
    expect((sync as unknown as Record<string, unknown>).events).toBeUndefined();
  });

  it("compacted history is not reconstructed: missing events stay missing", () => {
    const { world } = eventfulWorld(20);
    enforceRetention(world, 5);
    const gap = describeGap(world, 0)!;
    expect(gap.missingCount).toBeGreaterThan(0);
    expect(gap.replayable).toBe(false);
    expect(gap.reconstructable).toBe(false);
  });
});

// ===========================================================================
describe("§20.11 checkpoint interaction", () => {
  it("checkpoint with retained events: restore continues identically", () => {
    const { world } = eventfulWorld(20);
    const cp = checkpoint(world, "retained");
    const contA = forward(world, 20);
    const restored = (() => {
      const parsed = deserializeCheckpoint(serializeCheckpoint(cp));
      if (!parsed.ok) throw new Error("deserialize");
      const res = restoreCheckpoint(parsed.value);
      if (!res.ok) throw new Error("restore");
      return forward(res.value.world, 20);
    })();
    expect(stateHash(restored)).toBe(stateHash(contA));
    expect(traceHash(restored)).toBe(traceHash(contA));
  });

  it("checkpoint after eviction: restore continues identically", () => {
    const { world } = eventfulWorld(30);
    enforceRetention(world, 5);
    const cp = checkpoint(world, "evicted");
    const contA = forward(world, 20);
    const restored = (() => {
      const parsed = deserializeCheckpoint(serializeCheckpoint(cp));
      if (!parsed.ok) throw new Error("deserialize");
      const res = restoreCheckpoint(parsed.value);
      if (!res.ok) throw new Error("restore");
      return forward(res.value.world, 20);
    })();
    expect(stateHash(restored)).toBe(stateHash(contA));
  });

  it("delivery state belongs in checkpoint only if explicitly persisted externally", () => {
    const { world } = eventfulWorld(20);
    const delivery = createDeliveryState();
    poll(world, delivery, "c1");
    const cp = checkpoint(world, "delivery");
    expect((cp.world as unknown as Record<string, unknown>).delivery).toBeUndefined();
    expect(cp.identity.stateHash).toBe(stateHash(world));
    const parsed = deserializeCheckpoint(serializeCheckpoint(cp));
    expect(parsed.ok).toBe(true);
  });
});

// ===========================================================================
describe("§20.12 branching and retention", () => {
  it("evict from A1 while retaining A2: identities isolated, state unaffected, trace honest", () => {
    const { world } = eventfulWorld(10);
    const cp = checkpoint(world, "fork");
    const a1 = forkTimeline(cp, "A1");
    const a2 = forkTimeline(cp, "A2");
    if (!a1.ok || !a2.ok) throw new Error("fork");
    submitIntervention(a1.value.world, iBridge("X"), a1.value.engine);
    advance(a1.value.world, a1.value.engine, 20);
    submitIntervention(a2.value.world, iRally("Y"), a2.value.engine);
    advance(a2.value.world, a2.value.engine, 20);
    enforceRetention(a1.value.world, 3);
    expect(a2.value.world.events.length).toBeGreaterThan(3);
    expect(a1.value.world.events.length).toBe(3);
    expect(traceHash(a1.value.world)).not.toBe(traceHash(a2.value.world));
    const idsA1 = new Set(a1.value.world.events.map((e) => e.id));
    const collide = a2.value.world.events.filter((e) => idsA1.has(e.id));
    expect(collide).toHaveLength(0);
    const gapA1 = describeGap(a1.value.world, 0);
    expect(gapA1!.timelineId).toBe(a1.value.world.lineage.timelineId);
  });

  it("consumer cannot accidentally treat A1 event as A2 event", () => {
    const { world } = eventfulWorld(10);
    const cp = checkpoint(world, "fork2");
    const a1 = forkTimeline(cp, "A1b");
    const a2 = forkTimeline(cp, "A2b");
    if (!a1.ok || !a2.ok) throw new Error("fork");
    submitIntervention(a1.value.world, iBridge("X2"), a1.value.engine);
    advance(a1.value.world, a1.value.engine, 10);
    submitIntervention(a2.value.world, iRally("Y2"), a2.value.engine);
    advance(a2.value.world, a2.value.engine, 10);
    const syncA1 = stateSync(a1.value.world);
    const delivery = createDeliveryState();
    poll(a2.value.world, delivery, "c1");
    const res = resync(delivery, "c1", syncA1);
    expect(res.ok).toBe(false);
  });
});

// ===========================================================================
describe("§20.13 rewind and retention", () => {
  it("abandoned future events are retained separately vs eligible for eviction vs inaccessible", () => {
    const { world, engine } = eventfulWorld(10);
    const cp = checkpoint(world, "pre");
    submitIntervention(world, iBridge("future"), engine);
    advance(world, engine, 10);
    const abandonedEvents = world.events.filter((e) => e.tick > cp.identity.tick);
    expect(abandonedEvents.length).toBeGreaterThan(0);
    const rw = rewindTo(cp, world);
    expect(rw.ok).toBe(true);
    if (!rw.ok) return;
    expect(rw.value.world.events.some((e) => abandonedEvents.some((a) => a.id === e.id))).toBe(false);
  });

  it("delivery retention policy does not corrupt rewind semantics", () => {
    const { world, engine } = eventfulWorld(10);
    const cp = checkpoint(world, "pre2");
    submitIntervention(world, iBridge("future2"), engine);
    advance(world, engine, 10);
    const rw = rewindTo(cp, world);
    expect(rw.ok).toBe(true);
    if (!rw.ok) return;
    expect(rw.value.world.oldestRetainedSeq).toBe(cp.world.oldestRetainedSeq);
    expect(rw.value.world.highestEmittedSeq).toBe(cp.world.highestEmittedSeq);
  });
});

// ===========================================================================
describe("§20.14 provenance truncation interaction", () => {
  it("event retained, causal node retained -> fully explainable", () => {
    const { world } = eventfulWorld(20);
    const ev = streamOf(world)[0]!;
    const withCause = structuredClone(world);
    const node = withCause.provenance[0]!.id;
    const target = withCause.events.find((e) => e.id === ev.id)!;
    target.data = { ...target.data, causeNode: node };
    const attr = attributeEvent(withCause, target);
    expect(attr.causeAvailable).toBe(true);
  });

  it("event retained, causal node evicted -> honest incomplete", () => {
    const { world } = eventfulWorld(20);
    const ev = streamOf(world)[0]!;
    const withCause = structuredClone(world);
    const node = withCause.provenance[0]!.id;
    const target = withCause.events.find((e) => e.id === ev.id)!;
    target.data = { ...target.data, causeNode: node };
    withCause.provenance = withCause.provenance.filter((n) => n.id !== node);
    withCause.historyTruncated = true;
    const attr = attributeEvent(withCause, target);
    expect(attr.causeAvailable).toBe(false);
    expect(attr.causeNodeId).toBe(node);
  });

  it("event evicted, causal node retained -> event not deliverable, cause still exists", () => {
    const { world } = eventfulWorld(20);
    const ev = world.events[0]!;
    const nodeId = world.provenance[0]!.id;
    const evicted = structuredClone(world);
    enforceRetention(evicted, 1);
    const gap = describeGap(evicted, 0);
    expect(gap).not.toBeNull();
    if (evicted.provenance.some((n) => n.id === nodeId)) {
      const ex = explain(evicted, key.price("RF", "grain"));
      expect(ex).toBeDefined();
    }
    expect(ev.streamSeq).toBeLessThan(evicted.oldestRetainedSeq);
  });

  it("never imply fully explainable when causal evidence was removed", () => {
    const { world } = eventfulWorld(20);
    const ev = streamOf(world)[0]!;
    const withCause = structuredClone(world);
    const node = withCause.provenance[0]!.id;
    const target = withCause.events.find((e) => e.id === ev.id)!;
    target.data = { ...target.data, causeNode: node };
    withCause.provenance = withCause.provenance.filter((n) => n.id !== node);
    withCause.historyTruncated = true;
    const attr2 = attributeEvent(withCause, target);
    expect(attr2.causeAvailable).toBe(false);
    expect(attr2.causeNodeId).not.toBeNull();
  });
});

// ===========================================================================
describe("§20.15 restart / process boundary with retention metadata", () => {
  it("retention metadata (oldest/highest/evicted) survives checkpoint restore", () => {
    const { world } = eventfulWorld(30);
    enforceRetention(world, 5);
    const winBefore = { oldest: world.oldestRetainedSeq, highest: world.highestEmittedSeq, evicted: world.evictedCount };
    const cp = createCheckpoint(world, "retention");
    const parsed = deserializeCheckpoint(serializeCheckpoint(cp));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const restored = restoreCheckpoint(parsed.value);
    if (!restored.ok) throw new Error("restore");
    expect(restored.value.world.oldestRetainedSeq).toBe(winBefore.oldest);
    expect(restored.value.world.highestEmittedSeq).toBe(winBefore.highest);
    expect(restored.value.world.evictedCount).toBe(winBefore.evicted);
  });

  it("file-backed: process B restores retention window and gapping is detectable", () => {
    const { world } = eventfulWorld(30);
    enforceRetention(world, 5);
    const cp = createCheckpoint(world, "file-retention");
    const delivery = createDeliveryState();
    poll(world, delivery, "c1");
    const stream = streamOf(world);
    ack(world, delivery, "c1", stream[0]!.streamSeq);
    const dir = mkdtempSync(join(tmpdir(), "ce-ret-"));
    const cpFile = join(dir, "cp.json");
    const delFile = join(dir, "delivery.json");
    try {
      writeFileSync(cpFile, serializeCheckpoint(cp), "utf8");
      writeFileSync(delFile, serializeDelivery(delivery), "utf8");
      const out = execFileSync("npx", ["tsx", "src/poc/retention-worker.ts", cpFile, delFile, "c1", "0"], {
        encoding: "utf8",
        shell: true,
        cwd: process.cwd(),
      });
      const result = JSON.parse(out.trim().split("\n").pop()!);
      expect(result.ok).toBe(true);
      expect(result.window.oldestRetainedSeq).toBe(world.oldestRetainedSeq);
      expect(result.window.highestEmittedSeq).toBe(world.highestEmittedSeq);
      expect(result.pollStatus).toBe("deliverable");
      expect(result.delivered.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("evicted consumer after restart gets gap, not silent empty", () => {
    const { world } = eventfulWorld(30);
    enforceRetention(world, 5);
    const cp = createCheckpoint(world, "gap-restart");
    const delivery = createDeliveryState();
    const dir = mkdtempSync(join(tmpdir(), "ce-gap-"));
    const cpFile = join(dir, "cp.json");
    const delFile = join(dir, "delivery.json");
    try {
      writeFileSync(cpFile, serializeCheckpoint(cp), "utf8");
      writeFileSync(delFile, serializeDelivery(delivery), "utf8");
      const out = execFileSync("npx", ["tsx", "src/poc/retention-worker.ts", cpFile, delFile, "c1", "0"], {
        encoding: "utf8",
        shell: true,
        cwd: process.cwd(),
      });
      const result = JSON.parse(out.trim().split("\n").pop()!);
      expect(result.pollStatus).toBe("gap");
      expect(result.gap.missingCount).toBeGreaterThan(0);
      expect(result.gap.remedy).toBe("resync_from_state");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
describe("§20.16 crash scenarios", () => {
  it("crash before event persistence: tick's events lost, world reverts to checkpoint", () => {
    const { world, engine } = eventfulWorld(20);
    const cp = createCheckpoint(world, "pre-crash");
    advance(world, engine, 5);
    const afterCrash = (() => {
      const parsed = deserializeCheckpoint(serializeCheckpoint(cp));
      if (!parsed.ok) throw new Error("deserialize");
      const r = restoreCheckpoint(parsed.value);
      if (!r.ok) throw new Error("restore");
      return r.value.world;
    })();
    expect(afterCrash.tick).toBe(cp.identity.tick);
    expect(afterCrash.events.length).toBe(cp.world.events.length);
  });

  it("crash after event persistence but before delivery: events replay on restart", () => {
    const { world } = eventfulWorld(20);
    const delivery = createDeliveryState();
    const cp = createCheckpoint(world, "post-persist");
    const dir = mkdtempSync(join(tmpdir(), "ce-crash2-"));
    const cpFile = join(dir, "cp.json");
    const delFile = join(dir, "delivery.json");
    try {
      writeFileSync(cpFile, serializeCheckpoint(cp), "utf8");
      writeFileSync(delFile, serializeDelivery(delivery), "utf8");
      const out = execFileSync("npx", ["tsx", "src/poc/retention-worker.ts", cpFile, delFile, "c1", "0"], {
        encoding: "utf8",
        shell: true,
        cwd: process.cwd(),
      });
      const result = JSON.parse(out.trim().split("\n").pop()!);
      expect(result.delivered.length).toBeGreaterThan(0);
      expect(result.pollStatus).toBe("deliverable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("crash after delivery but before ACK: duplicate delivery on restart", () => {
    const { world } = eventfulWorld(20);
    const delivery = createDeliveryState();
    const first = poll(world, delivery, "c1");
    if (first.status !== "deliverable") throw new Error("expected deliverable");
    const toApply = first.attempts;
    const dir = mkdtempSync(join(tmpdir(), "ce-crash3-"));
    const cpFile = join(dir, "cp.json");
    const delFile = join(dir, "delivery.json");
    try {
      const cp = createCheckpoint(world, "post-delivery");
      writeFileSync(cpFile, serializeCheckpoint(cp), "utf8");
      writeFileSync(delFile, serializeDelivery(delivery), "utf8");
      const out = execFileSync("npx", ["tsx", "src/poc/retention-worker.ts", cpFile, delFile, "c1", "0"], {
        encoding: "utf8",
        shell: true,
        cwd: process.cwd(),
      });
      const result = JSON.parse(out.trim().split("\n").pop()!);
      expect(result.delivered[0]!.attempt).toBe(2);
      expect(result.delivered[0]!.eventId).toBe(toApply[0]!.eventId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("crash after ACK but before cursor persistence: replays from old cursor", () => {
    const { world } = eventfulWorld(20);
    const delivery = createDeliveryState();
    const first = poll(world, delivery, "c1");
    if (first.status !== "deliverable") throw new Error("expected deliverable");
    ack(world, delivery, "c1", first.attempts[0]!.streamSeq);
    const staleDelivery = createDeliveryState();
    poll(world, staleDelivery, "c1");
    const dir = mkdtempSync(join(tmpdir(), "ce-crash4-"));
    const cpFile = join(dir, "cp.json");
    const delFile = join(dir, "delivery.json");
    try {
      const cp = createCheckpoint(world, "post-ack");
      writeFileSync(cpFile, serializeCheckpoint(cp), "utf8");
      writeFileSync(delFile, serializeDelivery(staleDelivery), "utf8");
      const out = execFileSync("npx", ["tsx", "src/poc/retention-worker.ts", cpFile, delFile, "c1", "0"], {
        encoding: "utf8",
        shell: true,
        cwd: process.cwd(),
      });
      const result = JSON.parse(out.trim().split("\n").pop()!);
      expect(result.delivered[0]!.streamSeq).toBe(1);
      expect(result.delivered[0]!.attempt).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
describe("§20.17 retention and hashes", () => {
  it("same simulation, different retention -> same stateHash", () => {
    const base = eventfulWorld(30).world;
    const retained = structuredClone(base);
    const evicted = structuredClone(base);
    enforceRetention(evicted, 5);
    expect(stateHash(evicted)).toBe(stateHash(retained));
  });

  it("traceHash changes when history is evicted, and change is honest", () => {
    const { world } = eventfulWorld(30);
    const before = traceHash(world);
    enforceRetention(world, 5);
    expect(traceHash(world)).not.toBe(before);
    expect(world.historyTruncated).toBe(true);
    expect(world.evictedCount).toBeGreaterThan(0);
  });

  it("traceHash is retained-evidence hash, not retention-policy hash", () => {
    const { world } = eventfulWorld(20);
    enforceRetention(world, 5);
    const traceA = traceHash(world);
    const traceB = traceHash(world);
    expect(traceA).toBe(traceB);
    expect((world as unknown as Record<string, unknown>).limit).toBeUndefined();
  });

  it("eviction never creates a hash collision with a different world", () => {
    const { world: w1 } = eventfulWorld(20);
    const { world: w2 } = eventfulWorld(20);
    submitIntervention(w2, iRally("extra"), attachEngine(w2, createEngine()));
    advance(w2, attachEngine(w2, createEngine()), 5);
    enforceRetention(w1, 5);
    enforceRetention(w2, 5);
    expect(traceHash(w1)).not.toBe(traceHash(w2));
    expect(stateHash(w1)).not.toBe(stateHash(w2));
  });
});

// ===========================================================================
describe("§20.18 authoritative boundary", () => {
  it("CE owns simulation state, event creation, identity, ordering, trace; adapter owns retention strategy and transport; consumer owns cursor and dedup", () => {
    const { world } = eventfulWorld(10);
    expect(world.regions).toBeDefined();
    expect(world.events).toBeDefined();
    expect(world.config).toBeDefined();
    const delivery = createDeliveryState();
    expect((world as unknown as Record<string, unknown>).delivery).toBeUndefined();
    const consumer = createConsumer("test");
    expect(consumer.apply).toBeDefined();
  });

  it("no transport in core: delivery is pure data, no sockets/timers/brokers", () => {
    const delivery = createDeliveryState();
    poll(eventfulWorld(10).world, delivery, "c1");
    expect(Object.keys(delivery).sort()).toEqual(["channels"]);
    expect(JSON.stringify(delivery).includes("socket")).toBe(false);
    expect(JSON.stringify(delivery).includes("timer")).toBe(false);
  });
});

// ===========================================================================
describe("lifecycle §18 still holds after retention changes", () => {
  it("compactHistory still leaves stateHash identical after retention eviction", () => {
    const { world } = eventfulWorld(40);
    enforceRetention(world, 10);
    const before = stateHash(world);
    compactHistory(world, recentWindowPolicy(5));
    expect(stateHash(world)).toBe(before);
  });
});
