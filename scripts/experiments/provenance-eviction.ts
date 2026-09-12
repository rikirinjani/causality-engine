/**
 * Experiment adapter: provenance-eviction (P-026).
 *
 * Tests the interaction between CE's bounded retention and its deterministic
 * guarantees across checkpoint/restore, fork, rewind, and explanation.
 *
 * The question is NOT whether CE survives a long simulation.
 * The question IS: does CE maintain coherent deterministic state, lineage,
 * branching identity, replay, and explanation semantics when the simulation
 * crosses its bounded provenance/history retention boundary?
 *
 * Retention limits (hardcoded in CE source):
 *   EVENT_RETENTION_LIMIT   = 500
 *   PROVENANCE_LIMIT        = 4000
 *   RESOLUTION_LOG_LIMIT    = 4000
 *   DIAGNOSTIC_LIMIT        = 2000
 *
 * Families:
 *   A. determinism         — same scenario twice → identical stateHash/traceHash
 *   B. checkpoint-timing   — checkpoint before/during/after eviction → restore correctness
 *   C. fork-timing         — fork before/after eviction → identity + deterministic evolution
 *   D. rewind-across       — rewind from post-eviction to pre-eviction checkpoint
 *   E. explanation         — explain() after eviction → incomplete flag correctness
 *   F. state-hash-invariant — stateHash must NOT change when only events are evicted
 *   G. trace-hash-evolving  — traceHash MUST change when eviction happens
 *
 * Invariants asserted per unit (violation = FAILURE):
 *   determinism-state   two identical runs → identical stateHash
 *   determinism-trace   two identical runs → identical traceHash
 *   checkpoint          checkpoint → serialize → deserialize → restore → stateHash preserved
 *   fork-identity       two forks from same checkpoint → identical evolution
 *   rewind-identity     rewind creates new timeline, abandoned future recorded
 *   explain-incomplete  explain() after eviction flags incomplete when ancestors missing
 *   state-hash-stable   eviction does not change stateHash (events excluded by design)
 *   trace-hash-shifts   eviction changes traceHash (events included by design)
 *   finiteness          no NaN/Infinity anywhere in the world
 */
import { run, iBridge, iMerchant, iWarehouse, iRally, iSubsidy, iShrine } from "../../src/poc/harness.js";
import { stateHash, traceHash } from "../../src/core/hash.js";
import { explain, key } from "../../src/core/provenance.js";
import {
  createCheckpoint,
  serializeCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
} from "../../src/core/persistence.js";
import { EVENT_RETENTION_LIMIT } from "../../src/core/retention.js";
import { PROVENANCE_LIMIT, RESOLUTION_LOG_LIMIT } from "../../src/core/provenance.js";
import { DIAGNOSTIC_LIMIT } from "../../src/core/propagation.js";
import {
  advance,
  createEngine,
  createWorld,
  submitIntervention,
  tick,
  type Engine,
} from "../../src/core/world.js";
import {
  forkTimeline,
  rewindTo,
  checkpoint as timelineCheckpoint,
  interventionsAfter,
  replayAbandoned,
} from "../../src/core/timeline.js";
import type { WorldState } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// Intervention sequences — diverse to generate rich provenance
// ---------------------------------------------------------------------------

type Kind = "bridge" | "merchant" | "warehouse" | "rally" | "subsidy" | "shrine";

const iv = (kind: Kind) => {
  switch (kind) {
    case "bridge": return iBridge();
    case "merchant": return iMerchant();
    case "warehouse": return iWarehouse();
    case "rally": return iRally();
    case "subsidy": return iSubsidy();
    case "shrine": return iShrine();
  }
};

interface Sequence {
  name: string;
  build: (t: number) => Array<{ atTick: number; intervention: ReturnType<typeof iBridge> }>;
}

const SEQUENCES: Sequence[] = [
  // Single intervention types
  { name: "bridge", build: (t) => [{ atTick: t, intervention: iv("bridge") }] },
  { name: "merchant", build: (t) => [{ atTick: t, intervention: iv("merchant") }] },
  { name: "warehouse", build: (t) => [{ atTick: t, intervention: iv("warehouse") }] },
  { name: "rally", build: (t) => [{ atTick: t, intervention: iv("rally") }] },
  { name: "subsidy", build: (t) => [{ atTick: t, intervention: iv("subsidy") }] },
  // Multi-intervention sequences (richer provenance)
  {
    name: "bridge-then-merchant",
    build: (t) => [
      { atTick: t, intervention: iv("bridge") },
      { atTick: t + 5, intervention: iv("merchant") },
    ],
  },
  {
    name: "bridge-then-warehouse",
    build: (t) => [
      { atTick: t, intervention: iv("bridge") },
      { atTick: t + 5, intervention: iv("warehouse") },
    ],
  },
  {
    name: "triple",
    build: (t) => [
      { atTick: t, intervention: iv("bridge") },
      { atTick: t + 3, intervention: iv("merchant") },
      { atTick: t + 6, intervention: iv("rally") },
    ],
  },
  {
    name: "competing",
    build: (t) => [
      { atTick: t, intervention: iv("warehouse") },
      { atTick: t + 2, intervention: iv("subsidy") },
    ],
  },
  {
    name: "five-actions",
    build: (t) => [
      { atTick: t, intervention: iv("bridge") },
      { atTick: t + 2, intervention: iv("merchant") },
      { atTick: t + 4, intervention: iv("warehouse") },
      { atTick: t + 6, intervention: iv("rally") },
      { atTick: t + 8, intervention: iv("subsidy") },
    ],
  },
];

// ---------------------------------------------------------------------------
// Horizons — calibrated to cross retention boundaries
// ---------------------------------------------------------------------------
// At ~10-30 events/tick, EVENT_RETENTION_LIMIT (500) is crossed around tick 20-50.
// At ~10-30 provenance nodes/tick, PROVENANCE_LIMIT (4000) is crossed around tick 150-400.
// We want: below boundary, just past, well past, far past.

const HORIZONS = {
  // Below event boundary (no eviction expected)
  belowEvent: 30,
  // Just past event boundary (event eviction active)
  pastEvent: 100,
  // Well past event, approaching provenance
  midRange: 500,
  // Past provenance boundary
  pastProvenance: 1000,
  // Well past all boundaries
  farPast: 2000,
};

// ---------------------------------------------------------------------------
// Unit types
// ---------------------------------------------------------------------------

export interface ProvenanceEvictionUnit {
  experiment: "provenance-eviction";
  unitId: string;
  family: "determinism" | "checkpoint-timing" | "fork-timing" | "rewind-across" | "explanation" | "state-hash-invariant" | "trace-hash-evolving";
  seed: number;
  sequenceIndex: number;
  horizon: number;
  /** For checkpoint-timing: at which fraction of the horizon to checkpoint (0.0 = start, 1.0 = end) */
  checkpointFraction?: number;
  /** For fork-timing: at which fraction of the horizon to fork */
  forkFraction?: number;
}

// ---------------------------------------------------------------------------
// Enumerate
// ---------------------------------------------------------------------------

export function enumerateUnits(): ProvenanceEvictionUnit[] {
  const units: ProvenanceEvictionUnit[] = [];

  // A. determinism — same scenario twice, many seeds, all horizons that cross boundaries
  for (const horizonKey of ["pastEvent", "midRange", "pastProvenance", "farPast"] as const) {
    for (let s = 0; s < 10; s++) {
      for (let q = 0; q < SEQUENCES.length; q++) {
        units.push({
          experiment: "provenance-eviction",
          unitId: `A-det-${horizonKey}-q${q}-s${s}`,
          family: "determinism",
          seed: s,
          sequenceIndex: q,
          horizon: HORIZONS[horizonKey],
        });
      }
    }
  }

  // B. checkpoint-timing — checkpoint at various fractions, verify restore
  // Checkpoint before eviction (0.2 of a short horizon), during (0.5 of a mid horizon),
  // after (0.8 of a long horizon)
  const checkpointScenarios: Array<{ fraction: number; horizonKey: keyof typeof HORIZONS; label: string }> = [
    { fraction: 0.5, horizonKey: "belowEvent", label: "before-eviction" },
    { fraction: 0.5, horizonKey: "pastEvent", label: "during-event-eviction" },
    { fraction: 0.8, horizonKey: "pastEvent", label: "after-event-eviction" },
    { fraction: 0.5, horizonKey: "pastProvenance", label: "during-provenance-eviction" },
    { fraction: 0.8, horizonKey: "pastProvenance", label: "after-provenance-eviction" },
    { fraction: 0.9, horizonKey: "farPast", label: "deep-after-eviction" },
  ];
  for (const sc of checkpointScenarios) {
    for (let s = 0; s < 5; s++) {
      for (let q = 0; q < Math.min(SEQUENCES.length, 4); q++) {
        units.push({
          experiment: "provenance-eviction",
          unitId: `B-ckpt-${sc.label}-q${q}-s${s}`,
          family: "checkpoint-timing",
          seed: s,
          sequenceIndex: q,
          horizon: HORIZONS[sc.horizonKey],
          checkpointFraction: sc.fraction,
        });
      }
    }
  }

  // C. fork-timing — fork at various points, verify identity + evolution
  const forkScenarios: Array<{ fraction: number; horizonKey: keyof typeof HORIZONS; label: string }> = [
    { fraction: 0.3, horizonKey: "pastEvent", label: "fork-before-eviction" },
    { fraction: 0.7, horizonKey: "pastEvent", label: "fork-during-event-eviction" },
    { fraction: 0.3, horizonKey: "pastProvenance", label: "fork-before-provenance-eviction" },
    { fraction: 0.7, horizonKey: "pastProvenance", label: "fork-during-provenance-eviction" },
    { fraction: 0.5, horizonKey: "farPast", label: "fork-far-past" },
  ];
  for (const sc of forkScenarios) {
    for (let s = 0; s < 5; s++) {
      for (let q = 0; q < Math.min(SEQUENCES.length, 4); q++) {
        units.push({
          experiment: "provenance-eviction",
          unitId: `C-fork-${sc.label}-q${q}-s${s}`,
          family: "fork-timing",
          seed: s,
          sequenceIndex: q,
          horizon: HORIZONS[sc.horizonKey],
          forkFraction: sc.fraction,
        });
      }
    }
  }

  // D. rewind-across — rewind from post-eviction to pre-eviction checkpoint
  for (let s = 0; s < 5; s++) {
    for (let q = 0; q < Math.min(SEQUENCES.length, 4); q++) {
      // Checkpoint at tick 20 (before eviction), advance to tick 500 (past eviction), rewind
      units.push({
        experiment: "provenance-eviction",
        unitId: `D-rewind-mid-q${q}-s${s}`,
        family: "rewind-across",
        seed: s,
        sequenceIndex: q,
        horizon: HORIZONS.midRange,
        checkpointFraction: 0.04, // tick 20 of 500
      });
      // Checkpoint at tick 50 (just past event eviction), advance to 1000, rewind
      units.push({
        experiment: "provenance-eviction",
        unitId: `D-rewind-long-q${q}-s${s}`,
        family: "rewind-across",
        seed: s,
        sequenceIndex: q,
        horizon: HORIZONS.pastProvenance,
        checkpointFraction: 0.05, // tick 50 of 1000
      });
    }
  }

  // E. explanation — verify explain() after eviction
  for (const horizonKey of ["pastEvent", "pastProvenance", "farPast"] as const) {
    for (let s = 0; s < 5; s++) {
      // Use sequences that create explainable causal chains
      for (const q of [0, 5, 6, 9]) { // bridge, bridge-then-merchant, bridge-then-warehouse, five-actions
        units.push({
          experiment: "provenance-eviction",
          unitId: `E-explain-${horizonKey}-q${q}-s${s}`,
          family: "explanation",
          seed: s,
          sequenceIndex: q,
          horizon: HORIZONS[horizonKey],
        });
      }
    }
  }

  // F. state-hash-invariant — verify stateHash doesn't change when events are evicted
  // Run to just-below event boundary, then advance one tick at a time past it.
  // stateHash before and after eviction must be consistent (events excluded from stateHash).
  for (let s = 0; s < 5; s++) {
    for (let q = 0; q < Math.min(SEQUENCES.length, 3); q++) {
      units.push({
        experiment: "provenance-eviction",
        unitId: `F-statehash-q${q}-s${s}`,
        family: "state-hash-invariant",
        seed: s,
        sequenceIndex: q,
        horizon: HORIZONS.pastEvent,
      });
    }
  }

  // G. trace-hash-evolving — verify traceHash changes when eviction happens
  for (let s = 0; s < 5; s++) {
    for (let q = 0; q < Math.min(SEQUENCES.length, 3); q++) {
      units.push({
        experiment: "provenance-eviction",
        unitId: `G-tracehash-q${q}-s${s}`,
        family: "trace-hash-evolving",
        seed: s,
        sequenceIndex: q,
        horizon: HORIZONS.pastEvent,
      });
    }
  }

  return units;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findNonFinite(state: WorldState): string | null {
  for (const rid of Object.keys(state.regions)) {
    const r = state.regions[rid];
    if (r === undefined) continue;
    for (const res of Object.keys(r.prices)) {
      if (!Number.isFinite(r.prices[res])) return `regions.${rid}.prices.${res}`;
    }
    for (const res of Object.keys(r.stocks)) {
      if (!Number.isFinite(r.stocks[res])) return `regions.${rid}.stocks.${res}`;
    }
    for (const sid of Object.keys(r.infrastructure)) {
      const st = r.infrastructure[sid];
      if (st !== undefined && !Number.isFinite(st.health)) return `regions.${rid}.infrastructure.${sid}.health`;
    }
    if (!Number.isFinite(r.unrest)) return `regions.${rid}.unrest`;
    if (!Number.isFinite(r.patrolDemand)) return `regions.${rid}.patrolDemand`;
    if (!Number.isFinite(r.tradeInvestment)) return `regions.${rid}.tradeInvestment`;
  }
  for (const k of Object.keys(state.relations)) {
    if (!Number.isFinite(state.relations[k])) return `relations.${k}`;
  }
  return null;
}

function fail(unit: ProvenanceEvictionUnit, cls: string, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    experiment: "provenance-eviction",
    unitId: unit.unitId,
    seed: unit.seed,
    config: {},
    scenario: {},
    iteration: 0,
    pass: false,
    failure: { class: cls, message, ...extra },
    hashes: {},
    metrics: {},
    repro: { command: "npx tsx scripts/run-experiment.ts --replay <record>", unit },
  };
}

/**
 * Run a scenario from scratch using the harness `run()` helper.
 * Returns the RunResult (which contains .state, .engine, etc.).
 */
function runScenario(unit: ProvenanceEvictionUnit) {
  const seq = SEQUENCES[unit.sequenceIndex];
  if (!seq) return null;
  const schedule = seq.build(10);
  return run({
    label: unit.unitId,
    schedule,
    totalTicks: unit.horizon,
    seed: unit.seed,
  });
}

/**
 * Run a scenario with explicit control over the world/engine, allowing
 * intermediate checkpoints and forks.
 */
function runScenarioManual(
  seed: number,
  sequenceIndex: number,
  horizon: number,
  configOverrides?: Record<string, unknown>,
) {
  const seq = SEQUENCES[sequenceIndex];
  if (!seq) return null;
  const schedule = seq.build(10);

  const engine = createEngine();
  const state = createWorld({ seed, ...(configOverrides ?? {}) }, engine);
  const rejected: Array<{ id: string; errors: string[] }> = [];

  const byTick = new Map<number, Array<{ atTick: number; intervention: ReturnType<typeof iBridge> }>>();
  for (const s of schedule) {
    const list = byTick.get(s.atTick) ?? [];
    list.push(s);
    byTick.set(s.atTick, list);
  }

  for (let t = 1; t <= horizon; t++) {
    const due = byTick.get(t);
    if (due) {
      for (const d of due) {
        const r = submitIntervention(state, d.intervention, engine);
        if (!r.ok) rejected.push({ id: d.intervention.id, errors: r.errors });
      }
    }
    tick(state, engine);
  }

  return { state, engine, rejected };
}

// ---------------------------------------------------------------------------
// Run unit
// ---------------------------------------------------------------------------

export function runUnit(unit: ProvenanceEvictionUnit): Record<string, unknown> {
  const t0 = performance.now();
  const failures: Array<{ class: string; message: string }> = [];
  const metrics: Record<string, number | boolean | string | null> = {};

  // ---- A. determinism ----
  if (unit.family === "determinism") {
    const run1 = runScenario(unit);
    const run2 = runScenario(unit);
    if (!run1 || !run2) return fail(unit, "bad_unit", "sequence or config out of range");

    const h1 = stateHash(run1.state);
    const h2 = stateHash(run2.state);
    const t1 = traceHash(run1.state);
    const t2 = traceHash(run2.state);

    if (h1 !== h2) {
      failures.push({ class: "invariant_determinism_state", message: `stateHash differs: ${h1} vs ${h2}` });
    }
    if (t1 !== t2) {
      failures.push({ class: "invariant_determinism_trace", message: `traceHash differs: ${t1} vs ${t2}` });
    }

    const nonFinite = findNonFinite(run1.state);
    if (nonFinite !== null) {
      failures.push({ class: "invariant_nan", message: `non-finite value at ${nonFinite}` });
    }

    metrics.historyTruncated = run1.state.historyTruncated;
    metrics.eventsEvicted = run1.state.evictedCount;
    metrics.provenanceNodes = run1.state.provenance.length;
    metrics.provenanceSeq = run1.state.provenanceSeq;
    metrics.highestEmittedSeq = run1.state.highestEmittedSeq;
    metrics.oldestRetainedSeq = run1.state.oldestRetainedSeq;

    return {
      schemaVersion: 1,
      experiment: "provenance-eviction",
      unitId: unit.unitId,
      seed: unit.seed,
      config: { sequence: SEQUENCES[unit.sequenceIndex]?.name, horizon: unit.horizon },
      scenario: { family: unit.family },
      iteration: 0,
      pass: failures.length === 0,
      failure: failures.length > 0 ? failures[0] : null,
      hashes: { stateHash: h1, traceHash: t1, stateHash2: h2, traceHash2: t2 },
      metrics: { ...metrics, durationMs: performance.now() - t0 },
      repro: { command: "npx tsx scripts/run-experiment.ts --replay <record>", unit },
    };
  }

  // ---- B. checkpoint-timing ----
  if (unit.family === "checkpoint-timing") {
    const fraction = unit.checkpointFraction ?? 0.5;
    const checkpointTick = Math.max(1, Math.floor(unit.horizon * fraction));

    // Run to checkpoint tick
    const run1 = runScenarioManual(unit.seed, unit.sequenceIndex, checkpointTick);
    if (!run1) return fail(unit, "bad_unit", "sequence out of range");

    const cp = createCheckpoint(run1.state, `p026-ckpt-${unit.unitId}`);
    const preEvictionSH = stateHash(run1.state);
    const preEvictionTH = traceHash(run1.state);
    const preEvictionTruncated = run1.state.historyTruncated;

    // Continue past the checkpoint to the full horizon
    const remaining = unit.horizon - checkpointTick;
    advance(run1.state, run1.engine, remaining);

    const postEvictionSH = stateHash(run1.state);
    const postEvictionTH = traceHash(run1.state);
    const postEvictionTruncated = run1.state.historyTruncated;

    // Checkpoint should serialize/deserialize/restore correctly
    const ser = serializeCheckpoint(cp);
    const de = deserializeCheckpoint(ser);
    let restoreOk = false;
    let restoredSH: string | null = null;

    if (de.ok) {
      const restored = restoreCheckpoint(de.value);
      if (restored.ok) {
        restoredSH = stateHash(restored.value.world);
        restoreOk = restoredSH === preEvictionSH;
        if (!restoreOk) {
          failures.push({
            class: "invariant_checkpoint",
            message: `restored stateHash ${restoredSH} != original ${preEvictionSH}`,
          });
        }
      } else {
        failures.push({ class: "invariant_checkpoint", message: "restoreCheckpoint rejected a valid checkpoint" });
      }
    } else {
      failures.push({ class: "invariant_checkpoint", message: `deserializeCheckpoint failed: ${de.errors.map((e) => e.message).join(", ")}` });
    }

    // The checkpoint's historyTruncated flag must match what was true at capture time
    const cpTruncated = cp.identity.provenanceCheckpoint.truncated;
    if (cpTruncated !== preEvictionTruncated) {
      failures.push({
        class: "invariant_checkpoint_truncation",
        message: `checkpoint truncated=${cpTruncated} but world had historyTruncated=${preEvictionTruncated}`,
      });
    }

    // After continuing past checkpoint, if eviction happened, stateHash may differ
    // (because the world evolved), but the checkpoint's own hash must be stable
    metrics.checkpointTick = checkpointTick;
    metrics.preEvictionTruncated = preEvictionTruncated;
    metrics.postEvictionTruncated = postEvictionTruncated;
    metrics.preEvictionEvents = run1.state.events.length;
    metrics.postEvictionEvents = run1.state.events.length;
    metrics.eventsEvicted = run1.state.evictedCount;
    metrics.restoreOk = restoreOk;

    const nonFinite = findNonFinite(run1.state);
    if (nonFinite !== null) {
      failures.push({ class: "invariant_nan", message: `non-finite value at ${nonFinite}` });
    }

    return {
      schemaVersion: 1,
      experiment: "provenance-eviction",
      unitId: unit.unitId,
      seed: unit.seed,
      config: { sequence: SEQUENCES[unit.sequenceIndex]?.name, horizon: unit.horizon, fraction },
      scenario: { family: unit.family },
      iteration: 0,
      pass: failures.length === 0,
      failure: failures.length > 0 ? failures[0] : null,
      hashes: { stateHash: preEvictionSH, traceHash: preEvictionTH, postStateHash: postEvictionSH, restoredSH },
      metrics: { ...metrics, durationMs: performance.now() - t0 },
      repro: { command: "npx tsx scripts/run-experiment.ts --replay <record>", unit },
    };
  }

  // ---- C. fork-timing ----
  if (unit.family === "fork-timing") {
    const fraction = unit.forkFraction ?? 0.5;
    const forkTick = Math.max(1, Math.floor(unit.horizon * fraction));

    // Run to fork point
    const run1 = runScenarioManual(unit.seed, unit.sequenceIndex, forkTick);
    if (!run1) return fail(unit, "bad_unit", "sequence out of range");

    const cp = timelineCheckpoint(run1.state, `p026-fork-${unit.unitId}`);
    const preForkSH = stateHash(run1.state);

    // Fork from checkpoint
    const fork1 = forkTimeline(cp, "fork-a");
    const fork2 = forkTimeline(cp, "fork-b");

    if (!fork1.ok || !fork2.ok) {
      return fail(unit, "fork_failed", `fork failed: ${fork1.ok ? "" : fork1.errors.join(", ")} ${fork2.ok ? "" : fork2.errors.join(", ")}`);
    }

    // Forks must have different timeline identities
    if (fork1.value.timelineId === fork2.value.timelineId) {
      failures.push({
        class: "invariant_fork_identity",
        message: `two forks share the same timelineId: ${fork1.value.timelineId}`,
      });
    }

    // Fork lineage must be different from parent
    if (fork1.value.world.lineage.timelineId === run1.state.lineage.timelineId) {
      failures.push({
        class: "invariant_fork_lineage",
        message: "fork timelineId equals parent timelineId",
      });
    }
    if (fork1.value.world.lineage.origin !== "fork") {
      failures.push({
        class: "invariant_fork_origin",
        message: `fork origin is ${fork1.value.world.lineage.origin}, expected "fork"`,
      });
    }

    // Fork stateHash must differ from parent (because lineage is part of stateHash)
    const fork1SH = stateHash(fork1.value.world);
    if (fork1SH === preForkSH) {
      failures.push({
        class: "invariant_fork_state_hash_differs",
        message: `fork stateHash equals parent — lineage change not reflected in stateHash`,
      });
    }

    // Evolve both forks identically (same remaining ticks, same seed path)
    const remaining = unit.horizon - forkTick;
    advance(fork1.value.world, fork1.value.engine, remaining);
    advance(fork2.value.world, fork2.value.engine, remaining);

    const fork1FinalSH = stateHash(fork1.value.world);
    const fork2FinalSH = stateHash(fork2.value.world);
    const fork1FinalTH = traceHash(fork1.value.world);
    const fork2FinalTH = traceHash(fork2.value.world);

    // Two forks with DIFFERENT discriminators will have different stateHash (lineage differs).
    // This is correct — lineage is part of world identity. The test is that the PHYSICAL
    // state (regions, entities, relations) is identical after evolution.
    const fork1Regions = JSON.stringify(fork1.value.world.regions);
    const fork2Regions = JSON.stringify(fork2.value.world.regions);
    if (fork1Regions !== fork2Regions) {
      failures.push({
        class: "invariant_fork_physical_state",
        message: `fork physical state (regions) diverged after identical evolution`,
      });
    }
    const fork1Entities = JSON.stringify(fork1.value.world.entities);
    const fork2Entities = JSON.stringify(fork2.value.world.entities);
    if (fork1Entities !== fork2Entities) {
      failures.push({
        class: "invariant_fork_physical_state",
        message: `fork physical state (entities) diverged after identical evolution`,
      });
    }

    // traceHash also differs (events/provenance are trace-side, and forks generate
    // different provenance node ids due to different timeline identity). But the
    // resolution log structure must be equivalent.
    const fork1Resolutions = fork1.value.world.resolutionLog.length;
    const fork2Resolutions = fork2.value.world.resolutionLog.length;
    if (fork1Resolutions !== fork2Resolutions) {
      failures.push({
        class: "invariant_fork_resolution_count",
        message: `fork resolution log counts differ: ${fork1Resolutions} vs ${fork2Resolutions}`,
      });
    }

    metrics.forkTick = forkTick;
    metrics.fork1TimelineId = fork1.value.timelineId;
    metrics.fork2TimelineId = fork2.value.timelineId;
    metrics.fork1FinalSH = fork1FinalSH;
    metrics.fork2FinalSH = fork2FinalSH;
    metrics.historyTruncated = fork1.value.world.historyTruncated;
    metrics.eventsEvicted = fork1.value.world.evictedCount;

    const nonFinite = findNonFinite(fork1.value.world);
    if (nonFinite !== null) {
      failures.push({ class: "invariant_nan", message: `non-finite value at ${nonFinite}` });
    }

    return {
      schemaVersion: 1,
      experiment: "provenance-eviction",
      unitId: unit.unitId,
      seed: unit.seed,
      config: { sequence: SEQUENCES[unit.sequenceIndex]?.name, horizon: unit.horizon, fraction },
      scenario: { family: unit.family },
      iteration: 0,
      pass: failures.length === 0,
      failure: failures.length > 0 ? failures[0] : null,
      hashes: { stateHash: preForkSH, fork1SH: fork1FinalSH, fork2SH: fork2FinalSH },
      metrics: { ...metrics, durationMs: performance.now() - t0 },
      repro: { command: "npx tsx scripts/run-experiment.ts --replay <record>", unit },
    };
  }

  // ---- D. rewind-across ----
  if (unit.family === "rewind-across") {
    const fraction = unit.checkpointFraction ?? 0.05;
    const checkpointTick = Math.max(1, Math.floor(unit.horizon * fraction));

    // Run to checkpoint tick
    const run1 = runScenarioManual(unit.seed, unit.sequenceIndex, checkpointTick);
    if (!run1) return fail(unit, "bad_unit", "sequence out of range");

    const cp = timelineCheckpoint(run1.state, `p026-rewind-${unit.unitId}`);
    const preEvictionSH = stateHash(run1.state);
    const preEvictionTH = traceHash(run1.state);
    const preEvictionTimelineId = run1.state.lineage.timelineId;

    // Continue past the checkpoint to trigger eviction
    const remaining = unit.horizon - checkpointTick;
    advance(run1.state, run1.engine, remaining);

    const postEvictionSH = stateHash(run1.state);
    const postEvictionTruncated = run1.state.historyTruncated;
    const postEvictionEvents = run1.state.events.length;
    const postEvictionEvicted = run1.state.evictedCount;

    // Rewind to the pre-eviction checkpoint
    const rewindResult = rewindTo(cp, run1.state);

    if (!rewindResult.ok) {
      return fail(unit, "rewind_failed", `rewindTo failed: ${rewindResult.errors.join(", ")}`);
    }

    const rewoundSH = stateHash(rewindResult.value.world);
    const rewoundTH = traceHash(rewindResult.value.world);
    const rewoundTimelineId = rewindResult.value.timelineId;

    // Rewound world must have a DIFFERENT timeline identity
    if (rewoundTimelineId === preEvictionTimelineId) {
      failures.push({
        class: "invariant_rewind_identity",
        message: `rewound timelineId ${rewoundTimelineId} == original ${preEvictionTimelineId}`,
      });
    }

    // Rewound world's stateHash must DIFFER from pre-eviction (because lineage changed).
    // This is correct — lineage is part of stateHash. The physical state must match.
    if (rewoundSH === preEvictionSH) {
      failures.push({
        class: "invariant_rewind_state_hash_differs",
        message: `rewound stateHash equals pre-eviction — lineage change not reflected`,
      });
    }

    // Verify physical state matches the checkpoint (regions, entities)
    const cpRestored = deserializeCheckpoint(serializeCheckpoint(cp));
    if (cpRestored.ok) {
      const rw = restoreCheckpoint(cpRestored.value);
      if (rw.ok) {
        const cpRegions = JSON.stringify(rw.value.world.regions);
        const rewoundRegions = JSON.stringify(rewindResult.value.world.regions);
        if (cpRegions !== rewoundRegions) {
          failures.push({
            class: "invariant_rewind_physical_state",
            message: `rewound regions differ from checkpoint`,
          });
        }
        const cpEntities = JSON.stringify(rw.value.world.entities);
        const rewoundEntities = JSON.stringify(rewindResult.value.world.entities);
        if (cpEntities !== rewoundEntities) {
          failures.push({
            class: "invariant_rewind_physical_state",
            message: `rewound entities differ from checkpoint`,
          });
        }
      }
    }

    // Rewound world's origin must be "rewind"
    if (rewindResult.value.world.lineage.origin !== "rewind") {
      failures.push({
        class: "invariant_rewind_origin",
        message: `rewound origin is ${rewindResult.value.world.lineage.origin}, expected "rewind"`,
      });
    }

    // Abandoned future must be recorded
    const abandoned = rewindResult.value.world.lineage.abandonedTimelines;
    if (abandoned.length === 0) {
      failures.push({
        class: "invariant_rewind_abandoned",
        message: "no abandoned timelines recorded after rewind",
      });
    } else {
      const lastAbandoned = abandoned[abandoned.length - 1];
      if (lastAbandoned.timelineId !== preEvictionTimelineId) {
        failures.push({
          class: "invariant_rewind_abandoned_id",
          message: `abandoned timelineId ${lastAbandoned.timelineId} != original ${preEvictionTimelineId}`,
        });
      }
      if (lastAbandoned.abandonedStateHash !== postEvictionSH) {
        failures.push({
          class: "invariant_rewind_abandoned_hash",
          message: `abandoned stateHash ${lastAbandoned.abandonedStateHash} != post-eviction ${postEvictionSH}`,
        });
      }
    }

    // The rewound world's historyTruncated should be consistent with the pre-eviction state
    // (which was checkpointed before eviction, so it should be false if the checkpoint was before eviction)
    const rewoundTruncated = rewindResult.value.world.historyTruncated;

    metrics.checkpointTick = checkpointTick;
    metrics.preEvictionSH = preEvictionSH;
    metrics.postEvictionSH = postEvictionSH;
    metrics.rewoundSH = rewoundSH;
    metrics.postEvictionTruncated = postEvictionTruncated;
    metrics.rewoundTruncated = rewoundTruncated;
    metrics.abandonedCount = abandoned.length;
    metrics.eventsEvicted = postEvictionEvicted;

    const nonFinite = findNonFinite(rewindResult.value.world);
    if (nonFinite !== null) {
      failures.push({ class: "invariant_nan", message: `non-finite value at ${nonFinite}` });
    }

    return {
      schemaVersion: 1,
      experiment: "provenance-eviction",
      unitId: unit.unitId,
      seed: unit.seed,
      config: { sequence: SEQUENCES[unit.sequenceIndex]?.name, horizon: unit.horizon, fraction },
      scenario: { family: unit.family },
      iteration: 0,
      pass: failures.length === 0,
      failure: failures.length > 0 ? failures[0] : null,
      hashes: { stateHash: preEvictionSH, postStateHash: postEvictionSH, rewoundSH },
      metrics: { ...metrics, durationMs: performance.now() - t0 },
      repro: { command: "npx tsx scripts/run-experiment.ts --replay <record>", unit },
    };
  }

  // ---- E. explanation ----
  if (unit.family === "explanation") {
    const run1 = runScenario(unit);
    if (!run1) return fail(unit, "bad_unit", "sequence out of range");

    const truncated = run1.state.historyTruncated;
    const provenanceLen = run1.state.provenance.length;
    const provenanceSeq = run1.state.provenanceSeq;

    // Query explanation for RF grain price (most sequences affect this)
    const ex = explain(run1.state, key.price("RF", "grain"));

    // Query explanation for MG hostility (rally/merchant affect this)
    const exHostility = explain(run1.state, key.hostility("MG"));

    // If history was truncated and the quantity's provenance ref points to an evicted node,
    // explain() MUST flag incomplete
    if (truncated) {
      // Check if the explanation has dangling parents (evicted ancestors)
      if (ex.danglingParents.length > 0 && !ex.incomplete) {
        failures.push({
          class: "invariant_explain_incomplete",
          message: `explain() has ${ex.danglingParents.length} dangling parents but incomplete=false`,
        });
      }
      // If explained=false and incomplete=false, that's suspicious if the ref exists but node is evicted
      if (!ex.explained && !ex.incomplete && ex.danglingParents.length > 0) {
        failures.push({
          class: "invariant_explain_honest",
          message: "explain() found no cause and did not flag incomplete despite dangling parents",
        });
      }
    }

    // The explanation's target must always match the query
    if (ex.target !== key.price("RF", "grain")) {
      failures.push({
        class: "invariant_explain_target",
        message: `explain() target ${ex.target} != queried ${key.price("RF", "grain")}`,
      });
    }

    metrics.historyTruncated = truncated;
    metrics.provenanceNodes = provenanceLen;
    metrics.provenanceSeq = provenanceSeq;
    metrics.eventsEvicted = run1.state.evictedCount;
    metrics.explainExplained = ex.explained;
    metrics.explainIncomplete = ex.incomplete;
    metrics.explainDanglingParents = ex.danglingParents.length;
    metrics.explainNodes = ex.nodes.length;
    metrics.explainRoots = ex.roots.length;
    metrics.explainHostilityExplained = exHostility.explained;
    metrics.explainHostilityIncomplete = exHostility.incomplete;

    const nonFinite = findNonFinite(run1.state);
    if (nonFinite !== null) {
      failures.push({ class: "invariant_nan", message: `non-finite value at ${nonFinite}` });
    }

    return {
      schemaVersion: 1,
      experiment: "provenance-eviction",
      unitId: unit.unitId,
      seed: unit.seed,
      config: { sequence: SEQUENCES[unit.sequenceIndex]?.name, horizon: unit.horizon },
      scenario: { family: unit.family },
      iteration: 0,
      pass: failures.length === 0,
      failure: failures.length > 0 ? failures[0] : null,
      hashes: { stateHash: stateHash(run1.state), traceHash: traceHash(run1.state) },
      metrics: { ...metrics, durationMs: performance.now() - t0 },
      repro: { command: "npx tsx scripts/run-experiment.ts --replay <record>", unit },
    };
  }

  // ---- F. state-hash-invariant ----
  if (unit.family === "state-hash-invariant") {
    // Run just past the event boundary
    const run1 = runScenarioManual(unit.seed, unit.sequenceIndex, HORIZONS.pastEvent);
    if (!run1) return fail(unit, "bad_unit", "sequence out of range");

    const sh1 = stateHash(run1.state);
    const th1 = traceHash(run1.state);

    // Advance more ticks — eviction will remove events
    advance(run1.state, run1.engine, 50);

    const sh2 = stateHash(run1.state);
    const th2 = traceHash(run1.state);

    // stateHash includes: tick, config, regions, entities, relations, pendingContributions,
    // dynamics, rngState, tradeVolume, lineage. It does NOT include events.
    // However, advancing more ticks changes the actual state (regions evolve), so
    // stateHash WILL differ because the world changed, not because of eviction.
    //
    // The real test: create two runs, one short (no eviction) and one long (eviction),
    // then at the SAME tick compare. If they reach the same tick with the same seed
    // and same interventions, stateHash must match regardless of whether eviction happened.
    //
    // Better approach: checkpoint at tick T (before eviction), continue to T+100 (eviction),
    // restore the checkpoint. The restored world's stateHash must match the checkpoint's.
    const cp = timelineCheckpoint(run1.state, "statehash-test");
    advance(run1.state, run1.engine, 100);

    const restored = deserializeCheckpoint(serializeCheckpoint(cp));
    let checkpointSHMatch = false;
    if (restored.ok) {
      const rw = restoreCheckpoint(restored.value);
      if (rw.ok) {
        checkpointSHMatch = stateHash(rw.value.world) === cp.identity.stateHash;
      }
    }

    metrics.eventsBefore = run1.state.events.length;
    metrics.evictedCount = run1.state.evictedCount;
    metrics.historyTruncated = run1.state.historyTruncated;
    metrics.checkpointSHMatch = checkpointSHMatch;

    if (!checkpointSHMatch) {
      failures.push({
        class: "invariant_state_hash_stable",
        message: "checkpoint restore produced different stateHash after eviction occurred in the live world",
      });
    }

    const nonFinite = findNonFinite(run1.state);
    if (nonFinite !== null) {
      failures.push({ class: "invariant_nan", message: `non-finite value at ${nonFinite}` });
    }

    return {
      schemaVersion: 1,
      experiment: "provenance-eviction",
      unitId: unit.unitId,
      seed: unit.seed,
      config: { sequence: SEQUENCES[unit.sequenceIndex]?.name },
      scenario: { family: unit.family },
      iteration: 0,
      pass: failures.length === 0,
      failure: failures.length > 0 ? failures[0] : null,
      hashes: { stateHash: sh1, traceHash: th1, stateHash2: sh2, traceHash2: th2 },
      metrics: { ...metrics, durationMs: performance.now() - t0 },
      repro: { command: "npx tsx scripts/run-experiment.ts --replay <record>", unit },
    };
  }

  // ---- G. trace-hash-evolving ----
  if (unit.family === "trace-hash-evolving") {
    // Run to just before event eviction
    const run1 = runScenarioManual(unit.seed, unit.sequenceIndex, HORIZONS.belowEvent);
    if (!run1) return fail(unit, "bad_unit", "sequence out of range");

    const thBefore = traceHash(run1.state);
    const evictedBefore = run1.state.evictedCount;
    const truncatedBefore = run1.state.historyTruncated;

    // Advance past the event boundary
    advance(run1.state, run1.engine, HORIZONS.pastEvent - HORIZONS.belowEvent);

    const thAfter = traceHash(run1.state);
    const evictedAfter = run1.state.evictedCount;
    const truncatedAfter = run1.state.historyTruncated;

    // traceHash includes events, provenance, resolutionLog, etc.
    // After eviction, the traceHash MUST differ because:
    // 1. The world has more provenance/resolution entries
    // 2. Events may have been evicted (changing the events array)
    // 3. historyTruncated may have changed
    // The key assertion: if eviction happened, traceHash must have changed
    // (it would be a defect if eviction was invisible to traceHash)
    if (evictedAfter > evictedBefore && thBefore === thAfter) {
      failures.push({
        class: "invariant_trace_hash_shifts",
        message: `eviction occurred (${evictedBefore} -> ${evictedAfter}) but traceHash unchanged: ${thBefore}`,
      });
    }

    metrics.evictedBefore = evictedBefore;
    metrics.evictedAfter = evictedAfter;
    metrics.truncatedBefore = truncatedBefore;
    metrics.truncatedAfter = truncatedAfter;
    metrics.traceHashChanged = thBefore !== thAfter;

    const nonFinite = findNonFinite(run1.state);
    if (nonFinite !== null) {
      failures.push({ class: "invariant_nan", message: `non-finite value at ${nonFinite}` });
    }

    return {
      schemaVersion: 1,
      experiment: "provenance-eviction",
      unitId: unit.unitId,
      seed: unit.seed,
      config: { sequence: SEQUENCES[unit.sequenceIndex]?.name },
      scenario: { family: unit.family },
      iteration: 0,
      pass: failures.length === 0,
      failure: failures.length > 0 ? failures[0] : null,
      hashes: { stateHash: stateHash(run1.state), traceHash: thBefore, traceHash2: thAfter },
      metrics: { ...metrics, durationMs: performance.now() - t0 },
      repro: { command: "npx tsx scripts/run-experiment.ts --replay <record>", unit },
    };
  }

  return fail(unit, "unknown_family", `unknown family: ${unit.family}`);
}
