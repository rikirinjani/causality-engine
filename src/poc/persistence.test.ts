import { describe, expect, it } from "vitest";
import { advance, attachEngine, createEngine, createWorld, submitIntervention, tick } from "../core/world.js";
import { configHash, stateHash, traceHash } from "../core/hash.js";
import {
  CHECKPOINT_FORMAT,
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
  validateCheckpoint,
  type CheckpointEnvelope,
} from "../core/persistence.js";
import { checkpoint, forkTimeline, noteDivergence, replayAbandoned, rewindTo } from "../core/timeline.js";
import { deriveCheckpointId, genesisLineage } from "../core/genealogy.js";
import { explain, key, PROVENANCE_LIMIT } from "../core/provenance.js";
import { makeConfig, uniformThresholds } from "../core/config.js";
import { WORLD_SEED } from "../game/content.js";
import { iBridge, iMerchant, iRally, iSubsidy, iWarehouse } from "./harness.js";
import type { WorldState } from "../core/types.js";

/**
 * Persistence, rewind and branching (docs/RECONNAISSANCE.md §17).
 * Every invariant established by this pass has a regression test here.
 */

/** A world holding UNRESOLVED causal work: pending pressure not yet merged into ledgers. */
function midTickWorld(): { world: WorldState; engine: ReturnType<typeof createEngine> } {
  const engine = createEngine();
  const world = createWorld({ seed: WORLD_SEED }, engine);
  advance(world, engine, 9);
  submitIntervention(world, iBridge(), engine);
  submitIntervention(world, iWarehouse(), engine);
  return { world, engine };
}

function continueFrom(source: WorldState, ticks: number): { state: string; trace: string; world: WorldState } {
  const world = structuredClone(source);
  const engine = attachEngine(world, createEngine());
  advance(world, engine, ticks);
  return { state: stateHash(world), trace: traceHash(world), world };
}

// ===========================================================================
describe("§17.1 persistence semantics", () => {
  it("unresolved causal work is genuine state: a mid-tick world does not hash like a settled one", () => {
    const { world } = midTickWorld();
    expect(Object.keys(world.pendingContributions).length).toBeGreaterThan(0);

    const settled = structuredClone(world);
    settled.pendingContributions = {};
    // If pendingContributions were omitted from stateHash, these would collide and a
    // mid-tick checkpoint would restore a plausible world that then evolves differently.
    expect(stateHash(settled)).not.toBe(stateHash(world));
  });

  it("intervention history is world state, not engine state, so it survives a restore", () => {
    const { world, engine } = midTickWorld();
    expect(world.interventionHistory).toHaveLength(2);

    const env = createCheckpoint(world);
    const restored = restoreCheckpoint(env);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.world.interventionHistory).toHaveLength(2);
    expect(restored.value.world.interventionHistory.map((i) => i.id)).toEqual(
      world.interventionHistory.map((i) => i.id),
    );

    // and a resumed engine sees the same record
    const e2 = attachEngine(restored.value.world, createEngine());
    expect(e2.accepted).toHaveLength(2);
    expect(engine.accepted).toHaveLength(2);
  });

  it("the event bus is transient: it is empty at a tick boundary, so nothing is lost", () => {
    const engine = createEngine();
    const world = createWorld({ seed: WORLD_SEED }, engine);
    advance(world, engine, 12);
    // bus drained into state.events every tick
    expect(engine.bus.collect()).toHaveLength(0);
  });

  it("a checkpoint never aliases the live world", () => {
    const { world, engine } = midTickWorld();
    const env = createCheckpoint(world);
    const capturedHash = env.identity.stateHash;
    advance(world, engine, 10);
    // continuing the live world must not retroactively change the saved artefact
    expect(stateHash(env.world)).toBe(capturedHash);
    expect(stateHash(world)).not.toBe(capturedHash);
  });

  it("a restored world is isolated from the checkpoint it came from", () => {
    const { world } = midTickWorld();
    const env = createCheckpoint(world);
    const r = restoreCheckpoint(env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const engine = attachEngine(r.value.world, createEngine());
    advance(r.value.world, engine, 10);
    expect(stateHash(env.world)).toBe(env.identity.stateHash);
  });
});

// ===========================================================================
describe("§17.2 snapshot identity", () => {
  it("identity distinguishes 'same world, different history' from 'different world'", () => {
    // Two histories that reach the same world: same interventions, opposite submission order.
    const build = (reverse: boolean) => {
      const engine = createEngine();
      const world = createWorld({ seed: WORLD_SEED }, engine);
      advance(world, engine, 9);
      const list = [iBridge("i-bridge"), iWarehouse("i-warehouse")];
      for (const i of reverse ? [...list].reverse() : list) submitIntervention(world, i, engine);
      advance(world, engine, 5);
      return createCheckpoint(world);
    };
    const a = build(false);
    const b = build(true);

    expect(a.identity.stateHash).toBe(b.identity.stateHash); // same world
    expect(a.identity.traceHash).not.toBe(b.identity.traceHash); // different history
    expect(a.identity.checkpointId).not.toBe(b.identity.checkpointId); // distinct identity

    // and a genuinely different world differs in state too
    const engine = createEngine();
    const other = createWorld({ seed: WORLD_SEED }, engine);
    advance(other, engine, 9);
    submitIntervention(other, iBridge(), engine);
    advance(other, engine, 5);
    expect(createCheckpoint(other).identity.stateHash).not.toBe(a.identity.stateHash);
  });

  it("checkpointId is derived from content, not from a counter or a clock", () => {
    const { world } = midTickWorld();
    const a = createCheckpoint(world, "label-one");
    const b = createCheckpoint(world, "label-two");
    // identical world => identical id, regardless of label or call order
    expect(a.identity.checkpointId).toBe(b.identity.checkpointId);
    expect(a.identity.checkpointId).toBe(
      deriveCheckpointId(world.lineage.worldId, world.lineage.timelineId, world.tick, a.identity.stateHash, a.identity.traceHash),
    );
  });

  it("the label is metadata and never enters simulation identity", () => {
    const { world } = midTickWorld();
    const a = createCheckpoint(world, "");
    const b = createCheckpoint(world, "a very different label");
    expect(a.identity.stateHash).toBe(b.identity.stateHash);
    expect(a.identity.traceHash).toBe(b.identity.traceHash);
    expect(a.identity.configHash).toBe(b.identity.configHash);
    expect(a.identity.label).not.toBe(b.identity.label);
  });

  it("identity carries provenance completeness, so a truncated trace announces itself", () => {
    const { world } = midTickWorld();
    const env = createCheckpoint(world);
    const pc = env.identity.provenanceCheckpoint;
    expect(pc.nodeCount).toBe(world.provenance.length);
    expect(pc.provenanceSeq).toBe(world.provenanceSeq);
    expect(pc.interventionCount).toBe(world.interventionHistory.length);
    expect(pc.truncated).toBe(false);
    expect(pc.limits.provenance).toBe(PROVENANCE_LIMIT);
  });

  it("lineage is part of stateHash: a save cannot claim a different ancestry", () => {
    const { world } = midTickWorld();
    const before = stateHash(world);
    const tampered = structuredClone(world);
    tampered.lineage = { ...tampered.lineage, worldId: "W-forged" };
    expect(stateHash(tampered)).not.toBe(before);
  });

  it("configHash is separable so compatibility is checkable before reconstruction", () => {
    const { world } = midTickWorld();
    const env = createCheckpoint(world);
    expect(env.identity.configHash).toBe(configHash(world));
    // and it changes with tuning
    const other = structuredClone(world);
    other.config = makeConfig({ seed: WORLD_SEED, thresholds: uniformThresholds(0.9) });
    expect(configHash(other)).not.toBe(env.identity.configHash);
  });
});

// ===========================================================================
describe("§17.3 mid-tick snapshot determinism (mandatory)", () => {
  it("captures active pressure, pending boundary signals and unresolved quota", () => {
    const { world, engine } = midTickWorld();
    // pending contributions exist BEFORE the tick that will merge them
    expect(Object.keys(world.pendingContributions).length).toBeGreaterThan(0);

    // advance one tick to also have in-flight boundary signals queued for the next tick
    advance(world, engine, 1);
    const hasPending = Object.keys(world.pendingContributions).length > 0;
    const hasLedger = Object.values(world.regions).some((r) => Object.keys(r.ledger).length > 0);
    expect(hasPending || hasLedger).toBe(true);
  });

  it("snapshot -> continue equals snapshot -> restore -> continue, bit for bit", () => {
    const { world } = midTickWorld();
    const env = createCheckpoint(world, "mid-tick");

    const continuous = continueFrom(world, 25);

    const restored = restoreCheckpoint(env);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const rw = restored.value.world;
    const re = attachEngine(rw, createEngine());
    advance(rw, re, 25);

    expect(stateHash(rw)).toBe(continuous.state);
    expect(traceHash(rw)).toBe(continuous.trace);
  });

  it("resolution decisions and diagnostics after a mid-tick restore are identical", () => {
    const { world } = midTickWorld();
    const env = createCheckpoint(world);
    const continuous = continueFrom(world, 30);

    const restored = restoreCheckpoint(env);
    if (!restored.ok) throw new Error("restore failed");
    const rw = restored.value.world;
    advance(rw, attachEngine(rw, createEngine()), 30);

    const sig = (w: WorldState) =>
      w.resolutionLog
        .map((d) => `${d.tick}:${d.regionId}:${d.domain}:${d.fired ? 1 : 0}:${d.origin}:${d.generation}:${d.pressure.toFixed(15)}`)
        .join("|");
    expect(sig(rw)).toBe(sig(continuous.world));

    const diag = (w: WorldState) => w.diagnostics.map((d) => `${d.tick}:${d.kind}:${d.signal ?? d.domain ?? ""}`).join("|");
    expect(diag(rw)).toBe(diag(continuous.world));
  });

  it("convergence classifications survive a mid-collapse restore", () => {
    const { world } = midTickWorld();
    const env = createCheckpoint(world);
    const continuous = continueFrom(world, 60);

    const restored = restoreCheckpoint(env);
    if (!restored.ok) throw new Error("restore failed");
    const rw = restored.value.world;
    advance(rw, attachEngine(rw, createEngine()), 60);

    const classes = (w: WorldState) =>
      Object.entries(w.dynamics)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `${k}=${v.classification}@${v.classifiedAtTick}:${v.stableCount}`)
        .join("|");
    expect(classes(rw)).toBe(classes(continuous.world));
    expect(classes(rw).length).toBeGreaterThan(50);
  });

  it("restoring mid-collapse also works after generated (not just primary) pressure exists", () => {
    const { world, engine } = midTickWorld();
    // run until the feedback loop has generated new causality
    advance(world, engine, 4);
    expect(world.provenance.some((n) => n.label === "economy_pressure_generated")).toBe(true);

    const env = createCheckpoint(world);
    const continuous = continueFrom(world, 25);
    const restored = restoreCheckpoint(env);
    if (!restored.ok) throw new Error("restore failed");
    const rw = restored.value.world;
    advance(rw, attachEngine(rw, createEngine()), 25);

    expect(stateHash(rw)).toBe(continuous.state);
    expect(traceHash(rw)).toBe(continuous.trace);
  });
});

// ===========================================================================
describe("§17.4 snapshot round-trip", () => {
  it("snapshot -> restore -> snapshot again yields an identical envelope identity", () => {
    const { world } = midTickWorld();
    const first = createCheckpoint(world, "first");
    const restored = restoreCheckpoint(first);
    if (!restored.ok) throw new Error("restore failed");
    const second = createCheckpoint(restored.value.world, "second");

    expect(second.identity.stateHash).toBe(first.identity.stateHash);
    expect(second.identity.traceHash).toBe(first.identity.traceHash);
    expect(second.identity.configHash).toBe(first.identity.configHash);
    expect(second.identity.checkpointId).toBe(first.identity.checkpointId);
    expect(second.identity.tick).toBe(first.identity.tick);
    expect(second.identity.rngState).toEqual(first.identity.rngState);
    // only the label differs, and it is not in identity-bearing fields
    expect(second.identity.label).not.toBe(first.identity.label);
  });

  it("serialize -> deserialize -> serialize is byte-stable", () => {
    const { world } = midTickWorld();
    const env = createCheckpoint(world, "stable");
    const text1 = serializeCheckpoint(env);
    const parsed = deserializeCheckpoint(text1);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const text2 = serializeCheckpoint(parsed.value);
    expect(text2).toBe(text1);
  });

  it("a deserialized checkpoint resumes identically to the in-memory one", () => {
    const { world } = midTickWorld();
    const env = createCheckpoint(world);
    const continuous = continueFrom(world, 20);

    const parsed = deserializeCheckpoint(serializeCheckpoint(env));
    if (!parsed.ok) throw new Error("deserialize failed");
    const restored = restoreCheckpoint(parsed.value);
    if (!restored.ok) throw new Error("restore failed");
    const rw = restored.value.world;
    advance(rw, attachEngine(rw, createEngine()), 20);

    expect(stateHash(rw)).toBe(continuous.state);
    expect(traceHash(rw)).toBe(continuous.trace);
  });
});

// ===========================================================================
describe("§17.8 RNG persistence", () => {
  it("RNG is actually consumed after restore, and produces identical draws", () => {
    const { world } = midTickWorld();
    // agents consume exactly one draw each per tick, so any tick consumes RNG
    const before = world.rngState.s;
    const env = createCheckpoint(world);

    const continuous = continueFrom(world, 15);
    expect(continuous.world.rngState.s).not.toBe(before); // randomness really was consumed

    const restored = restoreCheckpoint(env);
    if (!restored.ok) throw new Error("restore failed");
    const rw = restored.value.world;
    advance(rw, attachEngine(rw, createEngine()), 15);

    expect(rw.rngState.s).toBe(continuous.world.rngState.s);
    // and the RNG-derived agent attributes match exactly
    for (const id of Object.keys(rw.entities).sort()) {
      expect(rw.entities[id]!.attrs.workJitter).toBe(continuous.world.entities[id]!.attrs.workJitter);
    }
  });

  it("a restored world whose RNG register was tampered with diverges (proving it is load-bearing)", () => {
    const { world } = midTickWorld();
    const env = createCheckpoint(world);
    const continuous = continueFrom(world, 10);

    const tampered = structuredClone(env.world);
    tampered.rngState = { s: (tampered.rngState.s + 1) >>> 0 };
    advance(tampered, attachEngine(tampered, createEngine()), 10);

    expect(stateHash(tampered)).not.toBe(continuous.state);
  });

  it("attachEngine reconstructs the live RNG from persisted state alone", () => {
    const { world } = midTickWorld();
    const env = createCheckpoint(world);
    const restored = restoreCheckpoint(env);
    if (!restored.ok) throw new Error("restore failed");
    const engine = attachEngine(restored.value.world, createEngine());
    expect(engine.rng.state().s).toBe(env.world.rngState.s);
  });
});

// ===========================================================================
describe("§17.9 configuration identity and compatibility", () => {
  it("restoring under the SAME config is allowed and changes nothing", () => {
    const { world } = midTickWorld();
    const env = createCheckpoint(world);
    const r = restoreCheckpoint(env, { config: structuredClone(world.config) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.migrated).toBe(false);
    expect(stateHash(r.value.world)).toBe(env.identity.stateHash);
  });

  it("restoring under a DIFFERENT config is REJECTED by default", () => {
    const { world } = midTickWorld();
    const env = createCheckpoint(world);
    const r = restoreCheckpoint(env, { config: makeConfig({ seed: WORLD_SEED, thresholds: uniformThresholds(0.9) }) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("incompatible_config");
  });

  it("explicit migration is permitted but assigns a NEW timeline identity", () => {
    const { world } = midTickWorld();
    const env = createCheckpoint(world);
    const newConfig = makeConfig({ seed: WORLD_SEED, thresholds: uniformThresholds(0.9) });
    const r = restoreCheckpoint(env, { config: newConfig, configPolicy: "migrate" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.migrated).toBe(true);
    expect(r.value.world.lineage.origin).toBe("migration");
    expect(r.value.world.lineage.timelineId).not.toBe(world.lineage.timelineId);
    expect(r.value.world.lineage.parentTimelineId).toBe(world.lineage.timelineId);
    // the migrated world is honestly a different world identity
    expect(stateHash(r.value.world)).not.toBe(env.identity.stateHash);
    // and the caller is warned, not left to guess
    expect(r.warnings.some((w) => w.code === "incompatible_config")).toBe(true);
  });

  it("a config change is never silent: migration is opt-in and labelled", () => {
    const { world } = midTickWorld();
    const env = createCheckpoint(world);
    const rejected = restoreCheckpoint(env, { config: makeConfig({ seed: WORLD_SEED, ledgerDecayPerTick: 0.5 }) });
    expect(rejected.ok).toBe(false);
    const migrated = restoreCheckpoint(env, {
      config: makeConfig({ seed: WORLD_SEED, ledgerDecayPerTick: 0.5 }),
      configPolicy: "migrate",
    });
    expect(migrated.ok).toBe(true);
  });
});

// ===========================================================================
describe("§17.10 invalid snapshot handling — explicit failure, no silent repair", () => {
  const validEnvelope = (): CheckpointEnvelope => {
    const { world } = midTickWorld();
    return createCheckpoint(world);
  };

  it("rejects non-JSON", () => {
    const r = deserializeCheckpoint("{ not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe("not_json");
  });

  it("rejects a non-object payload", () => {
    const r = validateCheckpoint([1, 2, 3]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe("not_an_object");
  });

  it("rejects the wrong format tag", () => {
    const env = { ...validEnvelope(), format: "something-else" };
    const r = validateCheckpoint(env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe("wrong_format");
  });

  it("rejects a future format version rather than guessing", () => {
    const env = { ...validEnvelope(), formatVersion: 999 };
    const r = validateCheckpoint(env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe("unsupported_format_version");
  });

  it("rejects a missing required field and NAMES it", () => {
    const env = validEnvelope() as unknown as Record<string, unknown>;
    const world = { ...(env.world as Record<string, unknown>) };
    delete world.pendingContributions;
    const r = validateCheckpoint({ ...env, world });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "missing_field" && e.detail?.field === "pendingContributions")).toBe(true);
    }
  });

  it("rejects an invalid tick", () => {
    const env = validEnvelope();
    const broken = structuredClone(env) as CheckpointEnvelope;
    (broken.world as unknown as Record<string, unknown>).tick = -5;
    const r = validateCheckpoint(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "invalid_tick")).toBe(true);
  });

  it("rejects an invalid RNG state", () => {
    const broken = structuredClone(validEnvelope());
    broken.world.rngState = { s: -1 } as { s: number };
    const r = validateCheckpoint(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "invalid_rng_state")).toBe(true);
  });

  it("rejects a tampered state hash instead of recomputing it", () => {
    const broken = structuredClone(validEnvelope());
    broken.world.tradeVolume = broken.world.tradeVolume + 1; // world changed, identity did not
    const r = validateCheckpoint(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "state_hash_mismatch")).toBe(true);
  });

  it("rejects a tampered causal history (traceHash mismatch)", () => {
    const broken = structuredClone(validEnvelope());
    // Erase the record of what was done to this world while leaving the world itself intact.
    // This is the attack the state/trace split must catch: the physical situation is
    // untouched, so stateHash still matches; only the history was rewritten.
    expect(broken.world.interventionHistory.length).toBeGreaterThan(0);
    broken.world.interventionHistory = [];
    const r = validateCheckpoint(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "trace_hash_mismatch")).toBe(true);
      // and stateHash is untouched, proving the two hashes catch different tampering
      expect(r.errors.some((e) => e.code === "state_hash_mismatch")).toBe(false);
    }
  });

  it("rejects malformed provenance", () => {
    const broken = structuredClone(validEnvelope());
    (broken.world.provenance as unknown as unknown[]) = [{ id: "x" }];
    const r = validateCheckpoint(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "malformed_provenance")).toBe(true);
  });

  it("rejects a malformed ledger", () => {
    const broken = structuredClone(validEnvelope());
    broken.world.regions["RF"]!.ledger.economy = Number.NaN;
    const r = validateCheckpoint(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "malformed_ledger")).toBe(true);
  });

  it("rejects a checkpointId that is not derivable from its own contents", () => {
    const broken = structuredClone(validEnvelope());
    broken.identity.checkpointId = "C-deadbeef";
    const r = validateCheckpoint(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "checkpoint_id_mismatch")).toBe(true);
  });

  it("reports EVERY problem, not only the first", () => {
    const broken = structuredClone(validEnvelope()) as unknown as Record<string, unknown>;
    const world = { ...(broken.world as Record<string, unknown>) };
    delete world.dynamics;
    delete world.diagnostics;
    const r = validateCheckpoint({ ...broken, world });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(1);
  });

  it("NEVER repairs: a rejected checkpoint yields no world at all", () => {
    const broken = structuredClone(validEnvelope());
    broken.world.tradeVolume += 1;
    const r = validateCheckpoint(broken);
    expect(r.ok).toBe(false);
    expect("value" in r).toBe(false);
  });
});
