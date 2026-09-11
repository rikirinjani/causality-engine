/**
 * Experiment adapter: causal-matrix.
 *
 * The first falsification workload. Reuses the existing harness (src/poc/harness.ts)
 * — no new causal model. Each work unit is a deterministic world:
 *
 *   seed × intervention sequence × configuration
 *
 * The full enumeration is 200 seeds × 8 sequences × 6 configs = 9,600 units.
 * The runner is invoked with --limit for verification; the full campaign is a
 * separate, later step.
 *
 * Invariants checked per unit (a violation is a FAILURE record, the goal of the
 * whole VX1 exercise):
 *   1. determinism  — two identical runs must produce the same stateHash
 *   2. finiteness   — no NaN/Infinity anywhere in the resulting world
 *
 * Everything else is recorded as a metric, not asserted.
 */
import { run, iBridge, iMerchant, iWarehouse, iRally, iSubsidy, iShrine, iSubsidyHT } from "../../src/poc/harness.js";
import { stateHash, traceHash } from "../../src/core/hash.js";
import type { WorldState } from "../../src/core/types.js";

export interface CausalMatrixUnit {
  experiment: "causal-matrix";
  unitId: string;
  seed: number;
  sequenceIndex: number;
  configIndex: number;
  horizon: number;
}

interface Sequence {
  name: string;
  build: (tick: number) => Array<{ atTick: number; intervention: ReturnType<typeof iBridge> }>;
}

const SEQUENCES: Sequence[] = [
  { name: "bridge", build: (t) => [{ atTick: t, intervention: iBridge() }] },
  { name: "merchant", build: (t) => [{ atTick: t, intervention: iMerchant() }] },
  { name: "warehouse", build: (t) => [{ atTick: t, intervention: iWarehouse() }] },
  { name: "rally", build: (t) => [{ atTick: t, intervention: iRally() }] },
  {
    name: "bridge+merchant",
    build: (t) => [
      { atTick: t, intervention: iBridge() },
      { atTick: t + 5, intervention: iMerchant() },
    ],
  },
  {
    name: "bridge+warehouse+rally",
    build: (t) => [
      { atTick: t, intervention: iBridge() },
      { atTick: t + 5, intervention: iWarehouse() },
      { atTick: t + 10, intervention: iRally() },
    ],
  },
  {
    name: "merchant+subsidy",
    build: (t) => [
      { atTick: t, intervention: iMerchant() },
      { atTick: t + 5, intervention: iSubsidy() },
    ],
  },
  {
    name: "bridge+subsidy+rally+warehouse",
    build: (t) => [
      { atTick: t, intervention: iBridge() },
      { atTick: t + 5, intervention: iSubsidy() },
      { atTick: t + 10, intervention: iRally() },
      { atTick: t + 15, intervention: iWarehouse() },
    ],
  },
];

const CONFIGS: Array<{ name: string; overrides: Record<string, unknown> }> = [
  { name: "base", overrides: {} },
  { name: "threshold-0.3", overrides: { thresholds: { civic: 0.3, ecology: 0.3, economy: 0.3, faction: 0.3 } } },
  { name: "threshold-1.2", overrides: { thresholds: { civic: 1.2, ecology: 1.2, economy: 1.2, faction: 1.2 } } },
  { name: "decay-0.7", overrides: { ledgerDecayPerTick: 0.7 } },
  { name: "decay-0.95", overrides: { ledgerDecayPerTick: 0.95 } },
  { name: "boundary-0.2", overrides: { boundaryDecay: 0.2 } },
];

const SEED_COUNT = 200;
const HORIZON = 120;
const INTERVENTION_TICK = 10;

export function enumerateUnits(): CausalMatrixUnit[] {
  const units: CausalMatrixUnit[] = [];
  for (let s = 0; s < SEED_COUNT; s += 1) {
    for (let q = 0; q < SEQUENCES.length; q += 1) {
      for (let c = 0; c < CONFIGS.length; c += 1) {
        units.push({
          experiment: "causal-matrix",
          unitId: `s${s}-q${q}-c${c}`,
          seed: s,
          sequenceIndex: q,
          configIndex: c,
          horizon: HORIZON,
        });
      }
    }
  }
  return units;
}

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
      const s = r.infrastructure[sid];
      if (s !== undefined && !Number.isFinite(s.health)) return `regions.${rid}.infrastructure.${sid}.health`;
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

export function runUnit(unit: CausalMatrixUnit): Record<string, unknown> {
  const t0 = performance.now();
  const seq = SEQUENCES[unit.sequenceIndex];
  const cfg = CONFIGS[unit.configIndex];
  if (seq === undefined || cfg === undefined) {
    return {
      schemaVersion: 1,
      experiment: "causal-matrix",
      unitId: unit.unitId,
      seed: unit.seed,
      config: {},
      scenario: {},
      iteration: 0,
      pass: false,
      failure: { class: "bad_unit", message: `sequence ${unit.sequenceIndex} or config ${unit.configIndex} out of range` },
      hashes: {},
      metrics: {},
      repro: { command: "", unit },
    };
  }

  const schedule = seq.build(INTERVENTION_TICK);

  // Two identical runs: the determinism check is the core claim under test.
  const run1 = run({
    label: unit.unitId,
    schedule,
    totalTicks: unit.horizon,
    seed: unit.seed,
    configOverrides: cfg.overrides as never,
  });
  const run2 = run({
    label: unit.unitId,
    schedule,
    totalTicks: unit.horizon,
    seed: unit.seed,
    configOverrides: cfg.overrides as never,
  });

  const h1 = stateHash(run1.state);
  const h2 = stateHash(run2.state);
  const trace1 = traceHash(run1.state);
  const durationMs = performance.now() - t0;

  const failures: Array<{ class: string; message: string }> = [];
  if (h1 !== h2) {
    failures.push({
      class: "invariant_determinism",
      message: `stateHash differs between identical runs: ${h1} vs ${h2}`,
    });
  }
  const nonFinite = findNonFinite(run1.state);
  if (nonFinite !== null) {
    failures.push({ class: "invariant_nan", message: `non-finite value at ${nonFinite}` });
  }

  const rf = run1.state.regions["RF"];
  const ps = run1.state.regions["PS"];
  const psDeviation = Math.abs((ps?.prices["grain"] ?? 10) - 10);
  const fired = run1.state.resolutionLog.filter((d) => d.fired).length;

  return {
    schemaVersion: 1,
    experiment: "causal-matrix",
    unitId: unit.unitId,
    seed: unit.seed,
    config: { name: cfg.name, overrides: cfg.overrides },
    scenario: { sequence: seq.name, horizon: unit.horizon },
    iteration: 0,
    pass: failures.length === 0,
    failure: failures.length > 0 ? failures[0] : null,
    hashes: { stateHash: h1, traceHash: trace1 },
    metrics: {
      durationMs,
      psGrainDeviation: psDeviation,
      resolutionsFired: fired,
      rfGrainPrice: rf?.prices["grain"] ?? 0,
      mgHostility: run1.state.relations["MG>player"] ?? 0,
    },
    repro: { command: "npx tsx scripts/run-experiment.ts --replay <record>", unit },
  };
}

// Referenced so the imports stay live even if a sequence is later edited.
void iShrine;
void iSubsidyHT;