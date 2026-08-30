import { describe, expect, it } from "vitest";
import { advance, attachEngine, createEngine, createWorld, submitIntervention } from "../core/world.js";
import { configHash, sortKeys, stateHash, traceHash } from "../core/hash.js";
import { createCheckpoint, deserializeCheckpoint, serializeCheckpoint, validateCheckpoint } from "../core/persistence.js";
import { checkpoint, forkTimeline, interventionsAfter, replayAbandoned, rewindTo } from "../core/timeline.js";
import {
  canRewindTo,
  classifyCheckpoint,
  compactHistory,
  recentWindowPolicy,
  RESUME_ONLY,
  RETAIN_ALL,
  ancestorClosure,
} from "../core/lifecycle.js";
import { CURRENT_SCHEMA_VERSION, MIN_MIGRATABLE_SCHEMA_VERSION, migrateWorld } from "../core/migration.js";
import { explain, key } from "../core/provenance.js";
import { pendingCausesOf } from "../core/propagation.js";
import { WORLD_SEED } from "../game/content.js";
import { iBridge, iMerchant, iRally, iSubsidy, iWarehouse } from "./harness.js";
import type { WorldState } from "../core/types.js";

/**
 * History lifecycle: compaction, retention, schema migration, canonical serialization (§18).
 */

/** A world with real causal history and unresolved pending work. */
function historicWorld(totalTicks = 60): { world: WorldState; engine: ReturnType<typeof createEngine> } {
  const engine = createEngine();
  const world = createWorld({ seed: WORLD_SEED }, engine);
  advance(world, engine, 9);
  submitIntervention(world, iBridge(), engine);
  submitIntervention(world, iWarehouse(), engine);
  advance(world, engine, 10);
  submitIntervention(world, iRally(), engine);
  advance(world, engine, 10);
  submitIntervention(world, iSubsidy(), engine);
  advance(world, engine, Math.max(0, totalTicks - 29));
  // leave pending work outstanding at the capture point
  submitIntervention(world, iMerchant(), engine);
  return { world, engine };
}

function forward(source: WorldState, ticks: number): WorldState {
  const w = structuredClone(source);
  advance(w, attachEngine(w, createEngine()), ticks);
  return w;
}

// ===========================================================================
describe("§18.2 the four persistence layers are genuinely separate", () => {
  it("provenance ids no longer leak into world identity (regression)", () => {
    // THE defect this pass opened with: renumbering provenance ids changed stateHash, so
    // compaction and migration would have appeared to change the world.
    // self-harness/failures/2026-08-31-architecture-provenance-ids-leak-into-state-identity.json
    const { world } = historicWorld(20);
    const before = stateHash(world);

    const renamed = structuredClone(world);
    const map = new Map<string, string>();
    renamed.provenance.forEach((n, i) => map.set(n.id, `q${i + 1}`));
    renamed.provenance = renamed.provenance.map((n) => ({
      ...n,
      id: map.get(n.id)!,
      parents: n.parents.map((p) => map.get(p) ?? p),
    }));
    renamed.provenanceRefs = Object.fromEntries(
      Object.entries(renamed.provenanceRefs).map(([k, v]) => [k, map.get(v) ?? v]),
    );
    renamed.ledgerCauses = Object.fromEntries(
      Object.entries(renamed.ledgerCauses).map(([k, v]) => [k, v.map((c) => map.get(c) ?? c)]),
    );
    renamed.pendingCauses = Object.fromEntries(
      Object.entries(renamed.pendingCauses).map(([k, v]) => [k, v.map((c) => map.get(c) ?? c)]),
    );

    expect(stateHash(renamed)).toBe(before); // world unchanged
    expect(traceHash(renamed)).not.toBe(traceHash(world)); // history changed
  });

  it("pending buckets contain physics only; cause ids live on the trace side", () => {
    const { world } = historicWorld(20);
    for (const buckets of Object.values(world.pendingContributions)) {
      for (const entry of Object.values(buckets ?? {})) {
        if (!entry) continue;
        expect(entry).not.toHaveProperty("causes");
        for (const item of entry.items) expect(item).not.toHaveProperty("cause");
      }
    }
    // but the causes are still recoverable
    const causeKeys = Object.keys(world.pendingCauses);
    expect(causeKeys.length).toBeGreaterThan(0);
  });

  it("dropping ALL history leaves stateHash untouched and changes traceHash", () => {
    const { world } = historicWorld(30);
    const stripped = structuredClone(world);
    stripped.provenance = [];
    stripped.provenanceRefs = {};
    stripped.resolutionLog = [];
    stripped.diagnostics = [];
    stripped.interventionHistory = [];
    stripped.ledgerCauses = {};
    stripped.pendingCauses = {};
    // `events` is history too (§19.11 moved it out of stateHash), so dropping it is safe here.
    stripped.events = [];
    // `dynamics` is NOT history: the tick reads it, so it stays in stateHash.

    expect(stateHash(stripped)).toBe(stateHash(world));
    expect(traceHash(stripped)).not.toBe(traceHash(world));
  });

  it("pending causal work is NOT droppable: it changes stateHash", () => {
    const { world } = historicWorld(20);
    expect(Object.keys(world.pendingContributions).length).toBeGreaterThan(0);
    const withoutPending = structuredClone(world);
    withoutPending.pendingContributions = {};
    expect(stateHash(withoutPending)).not.toBe(stateHash(world));
  });
});

// ===========================================================================
describe("§18.13 MANDATORY: identical state + different retained history behaves identically", () => {
  it("a compacted world and a full world continue bit-identically under identical interventions", () => {
    const { world } = historicWorld(60);

    const full = structuredClone(world);
    const compact = structuredClone(world);
    const report = compactHistory(compact, recentWindowPolicy(5));
    expect(report.truncated).toBe(true);

    // Precondition the brief demands: same state at T despite different retained history.
    expect(stateHash(compact)).toBe(stateHash(full));
    expect(traceHash(compact)).not.toBe(traceHash(full));

    // Now continue both under identical further interventions.
    const runBoth = (w: WorldState) => {
      const e = attachEngine(w, createEngine());
      advance(w, e, 5);
      submitIntervention(w, iBridge("post-1"), e);
      advance(w, e, 15);
      submitIntervention(w, iSubsidy("post-2"), e);
      advance(w, e, 20);
      return w;
    };
    const fullOut = runBoth(full);
    const compactOut = runBoth(compact);

    expect(stateHash(compactOut)).toBe(stateHash(fullOut));
    // resolution decisions must match too — history is explanatory, not simulation input
    const sig = (w: WorldState) =>
      w.resolutionLog
        .filter((d) => d.tick > world.tick)
        .map((d) => `${d.tick}:${d.regionId}:${d.domain}:${d.fired ? 1 : 0}:${d.origin}:${d.pressure.toFixed(15)}`)
        .join("|");
    expect(sig(compactOut)).toBe(sig(fullOut));
  });

  it("even the most aggressive policy (RESUME_ONLY) preserves forward determinism", () => {
    const { world } = historicWorld(50);
    const full = structuredClone(world);
    const compact = structuredClone(world);
    compactHistory(compact, RESUME_ONLY);

    expect(stateHash(compact)).toBe(stateHash(full));
    expect(stateHash(forward(compact, 40))).toBe(stateHash(forward(full, 40)));
  });

  it("history is explanatory, not secretly simulation state: RNG stream also matches", () => {
    const { world } = historicWorld(40);
    const compact = structuredClone(world);
    compactHistory(compact, RESUME_ONLY);
    const a = forward(world, 25);
    const b = forward(compact, 25);
    expect(b.rngState.s).toBe(a.rngState.s);
    for (const id of Object.keys(a.entities).sort()) {
      expect(b.entities[id]!.attrs.workJitter).toBe(a.entities[id]!.attrs.workJitter);
    }
  });
});

// ===========================================================================
describe("§18.4 compaction semantics", () => {
  it("RETAIN_ALL is a no-op: compaction is always opt-in", () => {
    const { world } = historicWorld(40);
    const before = { state: stateHash(world), trace: traceHash(world) };
    const report = compactHistory(world, RETAIN_ALL);
    expect(report.truncated).toBe(false);
    expect(report.retentionBoundaryTick).toBeNull();
    expect(stateHash(world)).toBe(before.state);
    expect(traceHash(world)).toBe(before.trace);
    expect(world.historyTruncated).toBe(false);
  });

  it("a semantic policy retains what explains the present, not merely what is recent", () => {
    const { world } = historicWorld(60);
    const compact = structuredClone(world);
    compactHistory(compact, recentWindowPolicy(3));

    // An old node that the CURRENT state still cites must survive despite being old.
    const refIds = new Set(Object.values(compact.provenanceRefs));
    const retainedIds = new Set(compact.provenance.map((n) => n.id));
    for (const id of refIds) {
      if (Object.values(world.provenanceRefs).includes(id)) {
        expect(retainedIds.has(id)).toBe(true);
      }
    }
    // and root causes survive
    const rootsBefore = world.provenance.filter((n) => n.kind === "intervention").map((n) => n.id);
    for (const id of rootsBefore) expect(retainedIds.has(id)).toBe(true);
  });

  it("compaction reports its retention boundary and what it cost", () => {
    const { world } = historicWorld(60);
    const report = compactHistory(world, recentWindowPolicy(5));
    expect(report.retentionBoundaryTick).not.toBeNull();
    expect(report.provenance.after).toBeLessThan(report.provenance.before);
    expect(report.lost.some((l) => l.capability === "full_explanation")).toBe(true);
  });

  it("discarding intervention history is allowed but reports the exact capabilities lost", () => {
    const { world } = historicWorld(40);
    const report = compactHistory(world, RESUME_ONLY);
    expect(report.interventions.after).toBe(0);
    const lostCaps = report.lost.map((l) => l.capability);
    expect(lostCaps).toContain("replay_from_seed");
    expect(lostCaps).toContain("replay_abandoned_future");
  });

  it("no synthetic provenance is created: compaction only ever removes", () => {
    const { world } = historicWorld(50);
    const originalIds = new Set(world.provenance.map((n) => n.id));
    const compact = structuredClone(world);
    compactHistory(compact, recentWindowPolicy(4));
    for (const n of compact.provenance) expect(originalIds.has(n.id)).toBe(true);
  });
});

// ===========================================================================
describe("§18.6 truncation attack — six cases", () => {
  it("Case 1: old provenance evicted, current world state retained", () => {
    const { world } = historicWorld(60);
    const compact = structuredClone(world);
    compactHistory(compact, recentWindowPolicy(3));
    expect(compact.provenance.length).toBeLessThan(world.provenance.length);
    expect(stateHash(compact)).toBe(stateHash(world));
  });

  it("Case 2: parent evicted while child remains -> incomplete, with the gap named", () => {
    const { world } = historicWorld(40);
    const damaged = structuredClone(world);
    const refKey = key.price("RF", "grain");
    const startId = damaged.provenanceRefs[refKey]!;
    const node = damaged.provenance.find((n) => n.id === startId)!;
    expect(node.parents.length).toBeGreaterThan(0);
    const parentId = node.parents[0]!;
    damaged.provenance = damaged.provenance.filter((n) => n.id !== parentId);
    damaged.historyTruncated = true;

    const ex = explain(damaged, refKey);
    expect(ex.explained).toBe(true); // the child is still there
    expect(ex.incomplete).toBe(true); // but the chain is broken
    expect(ex.danglingParents).toContain(parentId);
  });

  it("Case 3: multiple generations evicted -> still incomplete, never silently shortened", () => {
    const { world } = historicWorld(40);
    const damaged = structuredClone(world);
    const refKey = key.price("RF", "grain");
    const closure = ancestorClosure(damaged, [damaged.provenanceRefs[refKey]!]);
    const startId = damaged.provenanceRefs[refKey]!;
    // drop everything in the closure except the entry point
    damaged.provenance = damaged.provenance.filter((n) => n.id === startId || !closure.has(n.id));
    damaged.historyTruncated = true;

    const ex = explain(damaged, refKey);
    expect(ex.incomplete).toBe(true);
    expect(ex.roots).toHaveLength(0); // no roots reachable
    expect(ex.danglingParents.length).toBeGreaterThan(0);
  });

  it("Case 4: a branch created AFTER truncation inherits the truncation honestly", () => {
    const { world } = historicWorld(50);
    const compact = structuredClone(world);
    compactHistory(compact, recentWindowPolicy(3));
    const cp = createCheckpoint(compact, "compacted");
    expect(cp.identity.provenanceCheckpoint.truncated).toBe(true);

    const fork = forkTimeline(cp, "post-compaction");
    expect(fork.ok).toBe(true);
    if (!fork.ok) return;
    expect(fork.value.world.historyTruncated).toBe(true);
    // the fork does not regain the discarded history
    expect(fork.value.world.provenance.length).toBe(compact.provenance.length);
  });

  it("Case 5: rewind target predates retained history -> state restorable, history flagged", () => {
    const { world, engine } = historicWorld(30);
    const earlyCp = checkpoint(world, "early");
    advance(world, engine, 30);

    const compact = structuredClone(world);
    compactHistory(compact, recentWindowPolicy(2));

    // The checkpoint itself is untouched by later compaction, so rewind is allowed...
    const verdict = canRewindTo(true, earlyCp.identity.tick, compact.tick, !earlyCp.world.historyTruncated);
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) return;
    expect(verdict.historyComplete).toBe(true);

    const rw = rewindTo(earlyCp, compact);
    expect(rw.ok).toBe(true);
    if (!rw.ok) return;
    expect(rw.value.world.tick).toBe(earlyCp.identity.tick);
  });

  it("Case 6: explain() across the retention boundary distinguishes 'no cause' from 'no evidence'", () => {
    const { world } = historicWorld(50);

    // (a) a quantity that genuinely never had a cause
    const untouched = explain(world, key.unrest("PS"));
    expect(untouched.explained).toBe(false);
    expect(untouched.incomplete).toBe(false); // honestly: nothing caused it

    // (b) the same shape of answer after its evidence was discarded
    const compact = structuredClone(world);
    compactHistory(compact, recentWindowPolicy(1));
    const refKey = key.price("RF", "grain");
    const damaged = structuredClone(compact);
    const startId = damaged.provenanceRefs[refKey];
    if (startId) damaged.provenance = damaged.provenance.filter((n) => n.id !== startId);
    const lost = explain(damaged, refKey);
    expect(lost.explained).toBe(false);
    expect(lost.incomplete).toBe(true); // cause existed; evidence gone
    expect(lost.danglingParents.length).toBeGreaterThan(0);

    // The two cases are DISTINGUISHABLE, which is the whole point.
    expect(untouched.incomplete).not.toBe(lost.incomplete);
  });

  it("a rewind that would need discarded history to reconstruct a tick is refused", () => {
    const verdict = canRewindTo(false, 20, 100, false);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.reason).toContain("will not reconstruct");
  });
});

// ===========================================================================
describe("§18.7 replay guarantees are bounded by retained information", () => {
  it("full history: every capability available", () => {
    const { world } = historicWorld(40);
    const c = classifyCheckpoint(world);
    expect(c.class).toBe("full");
    expect(c.capabilities).toContain("replay_from_seed");
    expect(c.capabilities).toContain("full_explanation");
    expect(c.lost).toHaveLength(0);
  });

  it("bounded provenance: continuation survives, full explanation does not", () => {
    const { world } = historicWorld(50);
    compactHistory(world, recentWindowPolicy(3));
    const c = classifyCheckpoint(world);
    expect(c.class).toBe("resume");
    expect(c.capabilities).toContain("exact_continuation");
    expect(c.capabilities).toContain("exact_replay_from_checkpoint");
    expect(c.capabilities).toContain("branch_creation");
    expect(c.lost.map((l) => l.capability)).toContain("full_explanation");
  });

  it("discarded interventions: replay-from-seed and abandoned-future replay become impossible", () => {
    const { world } = historicWorld(40);
    compactHistory(world, RESUME_ONLY);
    const c = classifyCheckpoint(world);
    const lost = c.lost.map((l) => l.capability);
    expect(lost).toContain("replay_from_seed");
    expect(lost).toContain("replay_abandoned_future");
    expect(c.capabilities).toContain("exact_continuation");
  });

  it("classification is DERIVED from the payload, so a label cannot contradict it", () => {
    const { world } = historicWorld(30);
    expect(classifyCheckpoint(world).class).toBe("full");
    world.historyTruncated = true;
    expect(classifyCheckpoint(world).class).toBe("resume");
  });

  it("abandoned-future replay genuinely fails once its interventions are gone", () => {
    const { world, engine } = historicWorld(30);
    const cp = checkpoint(world, "pre-future");

    // Use an action that is actually ACCEPTED at this point. An earlier version of this test
    // used another bridge destruction, which was rejected as already-destroyed — so the
    // "abandoned future" contained no interventions and both replays trivially matched.
    // A test whose scenario is empty proves nothing.
    const accepted = submitIntervention(world, iRally("future-rally"), engine);
    expect(accepted.ok).toBe(true);
    advance(world, engine, 4);
    const accepted2 = submitIntervention(world, iMerchant("future-kill", "a08"), engine);
    expect(accepted2.ok).toBe(true);
    advance(world, engine, 8);

    const abandonedInterventions = interventionsAfter(cp, world);
    expect(abandonedInterventions.length).toBe(2); // the scenario is non-empty
    const targetTick = world.tick;
    const expected = stateHash(world);

    // with the records: exact re-derivation
    const withRecords = replayAbandoned(cp, abandonedInterventions, (w, e, i) => {
      submitIntervention(w, i, e);
    }, targetTick);
    expect(withRecords.ok).toBe(true);
    if (withRecords.ok) expect(withRecords.value.stateHash).toBe(expected);

    // without them: the replay runs but produces a DIFFERENT world, and cannot pretend otherwise
    const withoutRecords = replayAbandoned(cp, [], (w, e, i) => {
      submitIntervention(w, i, e);
    }, targetTick);
    expect(withoutRecords.ok).toBe(true);
    if (withoutRecords.ok) expect(withoutRecords.value.stateHash).not.toBe(expected);
  });
});

// ===========================================================================
describe("§18.9 branching after compaction", () => {
  it("both branches resume identically from a compacted checkpoint", () => {
    const { world } = historicWorld(50);
    compactHistory(world, recentWindowPolicy(4));
    const cp = createCheckpoint(world, "compact-fork-point");

    const a = forkTimeline(cp, "a");
    const b = forkTimeline(cp, "b");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    advance(a.value.world, a.value.engine, 20);
    advance(b.value.world, b.value.engine, 20);

    const physical = (w: WorldState) => {
      const c = structuredClone(w);
      c.lineage = { ...c.lineage, timelineId: "T-x", parentTimelineId: null, parentCheckpointId: null, forkTick: null, generation: 0 };
      return stateHash(c);
    };
    // no interventions: identical evolution from the same compacted origin
    expect(physical(a.value.world)).toBe(physical(b.value.world));
  });

  it("genealogy remains correct and shared retained history stays shared", () => {
    const { world } = historicWorld(40);
    compactHistory(world, recentWindowPolicy(5));
    const cp = createCheckpoint(world);
    const retainedTrace = traceHash(world);

    const a = forkTimeline(cp, "a");
    const b = forkTimeline(cp, "b");
    if (!a.ok || !b.ok) return;

    expect(a.value.world.lineage.parentCheckpointId).toBe(cp.identity.checkpointId);
    expect(b.value.world.lineage.parentCheckpointId).toBe(cp.identity.checkpointId);
    expect(traceHash(a.value.world)).toBe(retainedTrace);
    expect(traceHash(b.value.world)).toBe(retainedTrace);
  });

  it("diverging interventions diverge state; discarded history is not fabricated", () => {
    const { world } = historicWorld(40);
    compactHistory(world, recentWindowPolicy(3));
    const survivingIds = new Set(world.provenance.map((n) => n.id));
    const cp = createCheckpoint(world);

    const a = forkTimeline(cp, "a");
    const b = forkTimeline(cp, "b");
    if (!a.ok || !b.ok) return;
    submitIntervention(a.value.world, iBridge("XA"), a.value.engine);
    advance(a.value.world, a.value.engine, 15);
    submitIntervention(b.value.world, iRally("YB"), b.value.engine);
    advance(b.value.world, b.value.engine, 15);

    expect(stateHash(a.value.world)).not.toBe(stateHash(b.value.world));
    // no branch invented history: every pre-fork node id was already present
    for (const n of a.value.world.provenance) {
      if (n.tick <= cp.identity.tick) expect(survivingIds.has(n.id)).toBe(true);
    }
  });

  it("explanations in a post-compaction branch identify the retention boundary", () => {
    const { world } = historicWorld(50);
    const report = compactHistory(world, recentWindowPolicy(3));
    const cp = createCheckpoint(world);
    const fork = forkTimeline(cp, "explain-boundary");
    if (!fork.ok) return;
    advance(fork.value.world, fork.value.engine, 10);

    expect(fork.value.world.historyTruncated).toBe(true);
    expect(report.retentionBoundaryTick).not.toBeNull();
    // a checkpoint of the branch still declares the truncation
    expect(createCheckpoint(fork.value.world).identity.provenanceCheckpoint.truncated).toBe(true);
  });
});

// ===========================================================================
describe("§18.11-18.12 schema versioning and migration", () => {
  /** Build a v5-shaped payload from a current world by re-inlining cause ids. */
  function downgradeToV5(world: WorldState): Record<string, unknown> {
    const raw = structuredClone(world) as unknown as Record<string, unknown>;
    const pending = raw.pendingContributions as Record<string, Record<string, Record<string, unknown>>>;
    for (const [regionId, buckets] of Object.entries(pending)) {
      for (const [domain, entry] of Object.entries(buckets)) {
        const causes = (world.pendingCauses[`${regionId}:${domain}`] ?? []).slice();
        entry.causes = causes;
        const items = entry.items as Array<Record<string, unknown>>;
        entry.items = items.map((it, i) => ({ ...it, cause: causes[i % Math.max(1, causes.length)] ?? "" }));
      }
    }
    delete raw.pendingCauses;
    raw.schemaVersion = 5;
    return raw;
  }

  it("A. a valid old snapshot migrates successfully through every registered step", () => {
    const { world } = historicWorld(25);
    const v5 = downgradeToV5(world);
    const result = migrateWorld(v5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.path).toEqual([5, 6, 7]);
    expect(result.value.world.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

    // The v5->v6 step is LOSSLESS: the cause ids exist in the payload and are relocated.
    const step56 = result.value.notes.find((n) => n.fromVersion === 5)!;
    expect(step56.change).toBe("relocate_pending_cause_ids");
    expect(step56.lossy).toBe(false);
    expect(Object.keys(result.value.world.pendingCauses).length).toBeGreaterThan(0);

    // The v6->v7 step is LOSSY: a v6 payload has no record of how many events were evicted.
    const step67 = result.value.notes.find((n) => n.fromVersion === 6)!;
    expect(step67.change).toBe("assign_stream_coordinates");
    expect(step67.lossy).toBe(true);

    // A path containing any lossy step is reported incomplete overall.
    expect(result.value.completeness).toBe("incomplete");
  });

  it("B. an unsupported old schema fails explicitly rather than best-effort", () => {
    const { world } = historicWorld(15);
    const ancient = { ...(structuredClone(world) as unknown as Record<string, unknown>), schemaVersion: 1 };
    const result = migrateWorld(ancient);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe("schema_too_old");
    expect(result.errors[0]!.detail?.oldestSupported).toBe(MIN_MIGRATABLE_SCHEMA_VERSION);
  });

  it("B2. a snapshot from a FUTURE schema is refused, not downgraded", () => {
    const { world } = historicWorld(15);
    const future = { ...(structuredClone(world) as unknown as Record<string, unknown>), schemaVersion: 99 };
    const result = migrateWorld(future);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe("schema_from_future");
  });

  it("C. a corrupted old snapshot is rejected", () => {
    expect(migrateWorld(null).ok).toBe(false);
    expect(migrateWorld([1, 2, 3]).ok).toBe(false);
    expect(migrateWorld({ schemaVersion: "five" }).ok).toBe(false);
    expect(migrateWorld({}).ok).toBe(false);
    const r = migrateWorld({ schemaVersion: -1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe("unknown_schema_version");
  });

  it("D. the same semantic snapshot encoded differently keeps its canonical identity", () => {
    const { world } = historicWorld(25);
    const expectedState = stateHash(world);

    const v5a = downgradeToV5(world);
    // re-encode with shuffled top-level key order
    const shuffled: Record<string, unknown> = {};
    for (const k of Object.keys(v5a).sort().reverse()) shuffled[k] = v5a[k];

    const a = migrateWorld(v5a);
    const b = migrateWorld(shuffled);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(stateHash(a.value.world)).toBe(stateHash(b.value.world));
    expect(stateHash(a.value.world)).toBe(expectedState);
  });

  it("migration RECOMPUTES hashes rather than trusting the old ones", () => {
    const { world } = historicWorld(20);
    const v5 = downgradeToV5(world);
    const migrated = migrateWorld(v5);
    if (!migrated.ok) throw new Error("migration failed");
    // a checkpoint made from the migrated world validates against freshly derived hashes
    const cp = createCheckpoint(migrated.value.world);
    expect(validateCheckpoint(cp).ok).toBe(true);
  });

  it("migration does not change simulation meaning: forward evolution is unchanged", () => {
    const { world } = historicWorld(25);
    const v5 = downgradeToV5(world);
    const migrated = migrateWorld(v5);
    if (!migrated.ok) throw new Error("migration failed");

    expect(stateHash(migrated.value.world)).toBe(stateHash(world));
    expect(stateHash(forward(migrated.value.world, 20))).toBe(stateHash(forward(world, 20)));
  });

  it("§18.10 migration never forges provenance, and a lossy step reports incomplete", () => {
    const { world } = historicWorld(20);
    const v5 = downgradeToV5(world);
    const before = (v5.provenance as unknown[]).length;
    const migrated = migrateWorld(v5);
    if (!migrated.ok) throw new Error("migration failed");

    // node count unchanged: nothing was manufactured
    expect(migrated.value.world.provenance.length).toBe(before);

    // The v6->v7 step CANNOT recover how many events a v6 world had already evicted, so it
    // refuses to invent a number and marks the result incomplete instead. The world itself
    // carries the flag, so downstream code and every later checkpoint inherit the admission.
    expect(migrated.value.completeness).toBe("incomplete");
    expect(migrated.value.world.historyTruncated).toBe(true);
    const lossy = migrated.value.notes.filter((n) => n.lossy);
    expect(lossy).toHaveLength(1);
    expect(String(lossy[0]!.detail?.note)).toContain("unrecoverable");
  });

  it("a migration cannot be mistaken for a configuration change", () => {
    const { world } = historicWorld(20);
    const v5 = downgradeToV5(world);
    const migrated = migrateWorld(v5);
    if (!migrated.ok) throw new Error("migration failed");
    // config is untouched by a schema migration
    expect(configHash(migrated.value.world)).toBe(configHash(world));
    expect(migrated.value.world.config).toEqual(world.config);
  });
});

// ===========================================================================
describe("§18.4 what is NOT compactable — traps that look safe", () => {
  it("convergence traces are CONTINUATION state: they are in stateHash and cannot be dropped", () => {
    // The original trap: dropping `dynamics` left stateHash identical (§18 build), so it looked
    // compactable — while actually changing which diagnostics the world later reports. §19.11
    // closed the hole by moving `dynamics` INTO stateHash, so the trap is now unreachable:
    // dropping it changes world identity outright, which is the honest signal.
    const engine = createEngine();
    const world = createWorld({ seed: WORLD_SEED }, engine);
    advance(world, engine, 9);
    submitIntervention(world, iBridge(), engine);
    submitIntervention(world, iWarehouse(), engine);
    advance(world, engine, 5); // capture mid-trajectory

    const withDynamics = structuredClone(world);
    const withoutDynamics = structuredClone(world);
    withoutDynamics.dynamics = {};

    // dropping it is now visible in world identity
    expect(stateHash(withoutDynamics)).not.toBe(stateHash(withDynamics));

    const a = forward(withDynamics, 60);
    const b = forward(withoutDynamics, 60);

    // the underlying reason it must not be dropped: the ANALYSIS diverges
    const diag = (w: WorldState) => w.diagnostics.map((d) => `${d.tick}:${d.kind}:${d.signal ?? ""}`).join("|");
    expect(diag(b)).not.toBe(diag(a));
    expect(a.dynamics["RF:stock:grain"]!.classification).toBe("converged_at_bound");
    expect(b.dynamics["RF:stock:grain"]!.classification).toBe("converged");
  });

  it("compactHistory leaves dynamics and the fact record untouched", () => {
    const { world } = historicWorld(60);
    const dynamicsBefore = JSON.stringify(world.dynamics);
    const eventsBefore = JSON.stringify(world.events);
    compactHistory(world, RESUME_ONLY);
    expect(JSON.stringify(world.dynamics)).toBe(dynamicsBefore);
    expect(JSON.stringify(world.events)).toBe(eventsBefore);
  });

  it("the fact record is HISTORY, not world identity: dropping it is state-safe", () => {
    // Reversed from the §18 build, where `events` sat in stateHash. §19.11 established that
    // the buffer is a record of facts (history), while delivery obligation lives outside the
    // world in DeliveryState. The engine never reads it, so the future is unaffected.
    const { world } = historicWorld(40);
    expect(world.events.length).toBeGreaterThan(0);
    const dropped = structuredClone(world);
    dropped.events = [];

    expect(stateHash(dropped)).toBe(stateHash(world));
    expect(traceHash(dropped)).not.toBe(traceHash(world));

    const a = forward(world, 25);
    const b = forward(dropped, 25);
    expect(stateHash(b)).toBe(stateHash(a));
  });
});

// ===========================================================================
describe("§18.13 canonical serialization", () => {
  it("object insertion order does not affect identity", () => {
    const { world } = historicWorld(20);
    const reordered = structuredClone(world);
    // rebuild regions with reversed key order
    const regions: Record<string, (typeof world.regions)[string]> = {};
    for (const k of Object.keys(world.regions).sort().reverse()) regions[k] = reordered.regions[k]!;
    reordered.regions = regions;
    // and rebuild one region's stocks with reversed key order
    const rf = reordered.regions["RF"]!;
    const stocks: Record<string, number> = {};
    for (const k of Object.keys(rf.stocks).sort().reverse()) stocks[k] = rf.stocks[k]!;
    rf.stocks = stocks;

    expect(stateHash(reordered)).toBe(stateHash(world));
  });

  it("provenance ARRAY order is semantically meaningful and stays meaningful", () => {
    const { world } = historicWorld(20);
    const shuffled = structuredClone(world);
    shuffled.provenance = [...shuffled.provenance].reverse();
    // arrays are order-sensitive by design: provenance order records emission sequence
    expect(traceHash(shuffled)).not.toBe(traceHash(world));
    // ...and it does not touch world identity
    expect(stateHash(shuffled)).toBe(stateHash(world));
  });

  it("sortKeys is recursive, so nested insertion order cannot leak into a hash", () => {
    const a = { outer: { b: 1, a: 2 }, list: [{ y: 1, x: 2 }] };
    const b = { list: [{ x: 2, y: 1 }], outer: { a: 2, b: 1 } };
    expect(JSON.stringify(sortKeys(a))).toBe(JSON.stringify(sortKeys(b)));
  });

  it("cause-id arrays are canonically sorted, so arrival order cannot leak", () => {
    const engine = createEngine();
    const world = createWorld({ seed: WORLD_SEED }, engine);
    advance(world, engine, 5);
    submitIntervention(world, iBridge("b"), engine);
    submitIntervention(world, iWarehouse("w"), engine);
    const causes = pendingCausesOf(world, "RF", "economy");
    expect(causes).toEqual([...causes].sort());
  });

  it("serialize -> deserialize -> serialize is byte-stable after compaction", () => {
    const { world } = historicWorld(40);
    compactHistory(world, recentWindowPolicy(5));
    const env = createCheckpoint(world, "compact");
    const t1 = serializeCheckpoint(env);
    const parsed = deserializeCheckpoint(t1);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeCheckpoint(parsed.value)).toBe(t1);
  });

  it("a compacted checkpoint still validates and resumes exactly", () => {
    const { world } = historicWorld(50);
    const expected = stateHash(forward(world, 20));
    compactHistory(world, recentWindowPolicy(3));
    const env = createCheckpoint(world, "compact-resume");
    const parsed = deserializeCheckpoint(serializeCheckpoint(env));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings.some((w) => w.message.includes("TRUNCATED"))).toBe(true);
    expect(stateHash(forward(parsed.value.world, 20))).toBe(expected);
  });
});
