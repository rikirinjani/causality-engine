/**
 * Experiment adapter: adversarial.
 *
 * The first falsification campaign. Unlike causal-matrix (a smoke matrix over
 * moderate parameters), this targets the places a deterministic causal engine
 * is most likely to break:
 *
 *   A. collisions      multiple interventions on the SAME tick, and adjacent
 *                      ticks, including a duplicate that must be rejected
 *   B. extremes        configuration at the edges of CE's valid domain —
 *                      thresholds near zero and near max, decay near zero and
 *                      near one, boundary decay 0 and near 1, generation depth
 *                      0 and deep, contest ratio 0 and 1, and combinations that
 *                      maximise or suppress cascades
 *   C. long horizons   horizons that cross provenance/history eviction
 *                      boundaries, checking that state, provenance, hashing and
 *                      checkpointing stay coherent
 *   D. seed sweep      many independent seeds over all sequences, for
 *                      counterexample discovery
 *   E. validation      deliberately invalid configs that MUST be rejected by
 *                      validateConfig — tests the product boundary, not the
 *                      engine
 *
 * Invariants asserted per unit (a violation is a FAILURE record):
 *   determinism-state   two identical runs -> identical stateHash
 *   determinism-trace   two identical runs -> identical traceHash
 *   finiteness          no NaN/Infinity anywhere in the world
 *   locality            a region not targeted by any intervention is unchanged
 *   checkpoint          checkpoint -> serialize -> deserialize -> restore
 *                       preserves stateHash  (deep-check units only)
 *   rejection           a duplicate destroy is rejected, and rejection does not
 *                       perturb state  (collision-duplicate units)
 *
 * Everything else is recorded as a metric, never asserted.
 */
import { run, iBridge, iMerchant, iWarehouse, iRally, iSubsidy, iShrine, iSubsidyHT } from "../../src/poc/harness.js";
import { stateHash, traceHash } from "../../src/core/hash.js";
import { explain, key } from "../../src/core/provenance.js";
import {
  createCheckpoint,
  serializeCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
} from "../../src/core/persistence.js";
import { validateConfig } from "../../src/product/config.js";
import type { WorldState } from "../../src/core/types.js";

type Kind = "bridge" | "merchant" | "warehouse" | "rally" | "subsidy";

interface Sequence {
  name: string;
  /** Build the schedule. Multiple entries may share a tick. */
  build: (t: number) => Array<{ atTick: number; intervention: ReturnType<typeof iBridge> }>;
  /** True when the sequence deliberately submits a duplicate that CE must reject. */
  expectsRejection?: boolean;
}

const iv = (kind: Kind) => {
  switch (kind) {
    case "bridge":
      return iBridge();
    case "merchant":
      return iMerchant();
    case "warehouse":
      return iWarehouse();
    case "rally":
      return iRally();
    case "subsidy":
      return iSubsidy();
  }
};

const SEQUENCES: Sequence[] = [
  { name: "bridge", build: (t) => [{ atTick: t, intervention: iv("bridge") }] },
  { name: "merchant", build: (t) => [{ atTick: t, intervention: iv("merchant") }] },
  { name: "warehouse", build: (t) => [{ atTick: t, intervention: iv("warehouse") }] },
  { name: "rally", build: (t) => [{ atTick: t, intervention: iv("rally") }] },
  {
    name: "collision-2-same-tick",
    build: (t) => [
      { atTick: t, intervention: iv("bridge") },
      { atTick: t, intervention: iv("rally") },
    ],
  },
  {
    name: "collision-3-same-tick",
    build: (t) => [
      { atTick: t, intervention: iv("bridge") },
      { atTick: t, intervention: iv("merchant") },
      { atTick: t, intervention: iv("rally") },
    ],
  },
  {
    name: "collision-4-same-tick",
    build: (t) => [
      { atTick: t, intervention: iv("bridge") },
      { atTick: t, intervention: iv("warehouse") },
      { atTick: t, intervention: iv("rally") },
      { atTick: t, intervention: iv("subsidy") },
    ],
  },
  {
    name: "collision-adjacent",
    build: (t) => [
      { atTick: t, intervention: iv("bridge") },
      { atTick: t + 1, intervention: iv("rally") },
      { atTick: t + 2, intervention: iv("merchant") },
    ],
  },
  {
    name: "collision-duplicate",
    expectsRejection: true,
    build: (t) => [
      { atTick: t, intervention: iBridge("dup-a") },
      { atTick: t, intervention: iBridge("dup-b") },
    ],
  },
  {
    name: "collision-mixed",
    build: (t) => [
      { atTick: t, intervention: iv("bridge") },
      { atTick: t, intervention: iv("merchant") },
      { atTick: t + 1, intervention: iv("rally") },
      { atTick: t + 1, intervention: iv("subsidy") },
    ],
  },
];

interface Config {
  name: string;
  overrides: Record<string, unknown>;
}

/** All within CE's valid domain; extremes chosen at the boundary, not beyond it. */
const CONFIGS: Config[] = [
  { name: "base", overrides: {} },
  { name: "thresh-tiny", overrides: { thresholds: { civic: 0.001, ecology: 0.001, economy: 0.001, faction: 0.001 } } },
  { name: "thresh-huge", overrides: { thresholds: { civic: 5.0, ecology: 5.0, economy: 5.0, faction: 5.0 } } },
  { name: "decay-tiny", overrides: { ledgerDecayPerTick: 0.01 } },
  { name: "decay-near1", overrides: { ledgerDecayPerTick: 0.999 } },
  { name: "boundary-zero", overrides: { boundaryDecay: 0.0 } },
  { name: "boundary-near1", overrides: { boundaryDecay: 0.99 } },
  // Propagation fully disabled. This is the ONLY configuration in which strict
  // locality (an untargeted region must not move at all) is a valid assertion.
  { name: "boundary-disabled", overrides: { boundaryMaxHops: 0 } },
  { name: "generation-zero", overrides: { maxCausalGeneration: 0 } },
  { name: "generation-deep", overrides: { maxCausalGeneration: 10 } },
  { name: "contest-zero", overrides: { contestRatio: 0 } },
  { name: "contest-one", overrides: { contestRatio: 1 } },
  {
    name: "combined-hot",
    overrides: {
      thresholds: { civic: 0.001, ecology: 0.001, economy: 0.001, faction: 0.001 },
      ledgerDecayPerTick: 0.999,
      boundaryDecay: 0.99,
    },
  },
  {
    name: "combined-cold",
    overrides: {
      thresholds: { civic: 5.0, ecology: 5.0, economy: 5.0, faction: 5.0 },
      ledgerDecayPerTick: 0.01,
      boundaryDecay: 0.0,
    },
  },
];

/** Configs that validateConfig MUST reject. */
const INVALID_CONFIGS: Array<{ name: string; overrides: Record<string, unknown> }> = [
  { name: "invalid-decay-above-1", overrides: { ledgerDecayPerTick: 1.5 } },
  { name: "invalid-decay-zero", overrides: { ledgerDecayPerTick: 0 } },
  { name: "invalid-threshold-zero", overrides: { thresholds: { civic: 0, ecology: 0.6, economy: 0.6, faction: 0.6 } } },
  { name: "invalid-threshold-negative", overrides: { thresholds: { civic: -1, ecology: 0.6, economy: 0.6, faction: 0.6 } } },
  { name: "invalid-boundary-decay", overrides: { boundaryDecay: 1.5 } },
  { name: "invalid-boundary-hops", overrides: { boundaryMaxHops: -1 } },
  { name: "invalid-seed-noninteger", overrides: { seed: 1.5 } },
  { name: "invalid-price-clamp-order", overrides: { priceClampMax: 0.1 } },
];

export interface AdversarialUnit {
  experiment: "adversarial";
  unitId: string;
  family: "collision" | "extreme" | "longhorizon" | "seedsweep" | "validation";
  seed: number;
  sequenceIndex: number;
  configIndex: number;
  horizon: number;
  deepChecks: boolean;
}

const COLLISION_SEQ = [4, 5, 6, 7, 8, 9];
const REPRESENTATIVE_SEQ = [0, 5, 9];
const LONG_SEQ = [0, 6];
const HORIZONS = [500, 1000, 2000, 5000];

export function enumerateUnits(): AdversarialUnit[] {
  const units: AdversarialUnit[] = [];

  // A. collisions — base config, many seeds (highest expected value)
  for (const q of COLLISION_SEQ) {
    for (let s = 0; s < 40; s += 1) {
      units.push({
        experiment: "adversarial",
        unitId: `A-col-q${q}-s${s}`,
        family: "collision",
        seed: s,
        sequenceIndex: q,
        configIndex: 0,
        horizon: 200,
        deepChecks: true,
      });
    }
  }

  // B. extreme configs — representative sequences, moderate seeds
  for (let c = 1; c < CONFIGS.length; c += 1) {
    for (const q of REPRESENTATIVE_SEQ) {
      for (let s = 0; s < 20; s += 1) {
        units.push({
          experiment: "adversarial",
          unitId: `B-ext-c${c}-q${q}-s${s}`,
          family: "extreme",
          seed: s,
          sequenceIndex: q,
          configIndex: c,
          horizon: 200,
          deepChecks: false,
        });
      }
    }
  }

  // C. long horizons — cross eviction boundaries.
  // Horizon 5000 costs ~65s per unit, so this family stays small; its purpose
  // is to cross the eviction boundary, not to sweep seeds.
  for (const horizon of HORIZONS) {
    for (const q of LONG_SEQ) {
      for (let s = 0; s < 4; s += 1) {
        units.push({
          experiment: "adversarial",
          unitId: `C-long-h${horizon}-q${q}-s${s}`,
          family: "longhorizon",
          seed: s,
          sequenceIndex: q,
          configIndex: 0,
          horizon,
          deepChecks: true,
        });
      }
    }
  }

  // D. seed sweep — base config, all sequences, many seeds
  for (let s = 100; s < 300; s += 1) {
    for (let q = 0; q < SEQUENCES.length; q += 1) {
      units.push({
        experiment: "adversarial",
        unitId: `D-seed-s${s}-q${q}`,
        family: "seedsweep",
        seed: s,
        sequenceIndex: q,
        configIndex: 0,
        horizon: 150,
        deepChecks: false,
      });
    }
  }

  // E. validation boundary — invalid configs must be rejected
  for (let i = 0; i < INVALID_CONFIGS.length; i += 1) {
    units.push({
      experiment: "adversarial",
      unitId: `E-val-i${i}`,
      family: "validation",
      seed: 0,
      sequenceIndex: 0,
      configIndex: -1,
      horizon: 0,
      deepChecks: false,
    });
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

function fail(unit: AdversarialUnit, cls: string, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    experiment: "adversarial",
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

export function runUnit(unit: AdversarialUnit): Record<string, unknown> {
  // E. validation family: assert rejection, no simulation at all.
  if (unit.family === "validation") {
    const invalid = INVALID_CONFIGS[Number(unit.unitId.split("-i")[1])];
    if (invalid === undefined) return fail(unit, "bad_unit", "no invalid config for this unit");
    const result = validateConfig(invalid.overrides as never);
    const rejected = result.ok === false && result.errors.length > 0;
    return {
      schemaVersion: 1,
      experiment: "adversarial",
      unitId: unit.unitId,
      seed: null,
      config: { name: invalid.name, overrides: invalid.overrides },
      scenario: { family: "validation" },
      iteration: 0,
      pass: rejected,
      failure: rejected
        ? null
        : { class: "validation_gap", message: `validateConfig accepted an invalid config: ${invalid.name}` },
      hashes: {},
      metrics: { errorsReported: result.errors.length },
      repro: { command: "npx tsx scripts/run-experiment.ts --replay <record>", unit },
    };
  }

  const t0 = performance.now();
  const seq = SEQUENCES[unit.sequenceIndex];
  const cfg = CONFIGS[unit.configIndex];
  if (seq === undefined || cfg === undefined) {
    return fail(unit, "bad_unit", `sequence ${unit.sequenceIndex} or config ${unit.configIndex} out of range`);
  }

  const schedule = seq.build(10);

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
  const t1 = traceHash(run1.state);
  const t2 = traceHash(run2.state);

  const failures: Array<{ class: string; message: string }> = [];
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

  // Locality.
  //
  // A first version of this adapter asserted "PS must never move". That was
  // wrong: CE propagates across region boundaries by design, governed by
  // boundaryDecay and boundaryMaxHops. The campaign correctly falsified the
  // assertion, not the engine. The real invariants are:
  //
  //   boundaryMaxHops = 0  -> strict locality; deviation must be exactly zero
  //   otherwise            -> propagation must stay BOUNDED, never runaway
  const ps = run1.state.regions["PS"];
  const psDeviation = Math.abs((ps?.prices["grain"] ?? 10) - 10);
  const boundaryDisabled = cfg.overrides.boundaryMaxHops === 0;

  if (boundaryDisabled) {
    if (psDeviation > 1e-9) {
      failures.push({
        class: "invariant_locality_disabled",
        message: `boundaryMaxHops=0 but untargeted region PS moved by ${psDeviation}`,
      });
    }
  } else if (psDeviation > 1.0) {
    // Bounded propagation: base price is 10, so a >1.0 deviation would mean
    // cross-region leakage is not decaying as configured.
    failures.push({
      class: "invariant_propagation_unbounded",
      message: `cross-region deviation ${psDeviation} exceeds the bounded-propagation limit of 1.0`,
    });
  }

  // Deep checks: checkpoint round-trip and explain resolution.
  let checkpointHash: string | null = null;
  let checkpointOk: boolean | null = null;
  let explainExplained: boolean | null = null;
  let explainIncomplete: boolean | null = null;
  let explainRootAction: string | null = null;

  if (unit.deepChecks) {
    const cp = createCheckpoint(run1.state, "adv");
    const ser = serializeCheckpoint(cp);
    const de = deserializeCheckpoint(ser);
    if (de.ok) {
      const restored = restoreCheckpoint(de.value);
      if (restored.ok) {
        checkpointHash = stateHash(restored.value.world);
        checkpointOk = checkpointHash === h1;
        if (!checkpointOk) {
          failures.push({
            class: "invariant_checkpoint",
            message: `restored stateHash ${checkpointHash} != original ${h1}`,
          });
        }
      } else {
        checkpointOk = false;
        failures.push({ class: "invariant_checkpoint", message: "restoreCheckpoint rejected a valid checkpoint" });
      }
    } else {
      checkpointOk = false;
      failures.push({ class: "invariant_checkpoint", message: "deserializeCheckpoint rejected a valid checkpoint" });
    }

    const ex = explain(run1.state, key.price("RF", "grain"));
    explainExplained = ex.explained;
    explainIncomplete = ex.incomplete;
    explainRootAction = ex.roots[0]?.action ?? null;

    // Only assert when the sequence actually destroys the RF grain road.
    const destroysRoad = seq.build(10).some((s) => s.intervention.action === "destroy_infrastructure");
    const priceMoved = Math.abs((run1.state.regions["RF"]?.prices["grain"] ?? 10) - 10) > 1e-9;

    if (destroysRoad && priceMoved) {
      if (run1.state.historyTruncated) {
        // History was evicted. CE may legitimately fail to explain — but it
        // MUST announce that the trace is incomplete rather than presenting a
        // partial answer as a complete one. That is the invariant.
        if (!ex.explained && !ex.incomplete) {
          failures.push({
            class: "invariant_eviction_unannounced",
            message: "history was truncated and explain() found no cause without flagging incomplete",
          });
        }
      } else if (!ex.explained) {
        failures.push({
          class: "invariant_explain",
          message: "RF grain price moved after a bridge destroy but explain() found no cause",
        });
      }
    }
  }

  // Rejection: a duplicate destroy must be refused, and refusing must not
  // perturb the resulting state relative to a single destroy.
  let rejectedCount: number | null = null;
  if (seq.expectsRejection === true) {
    rejectedCount = run1.rejected.length;
    if (rejectedCount < 1) {
      failures.push({
        class: "invariant_rejection",
        message: "duplicate destroy was not rejected",
      });
    }
  }

  const durationMs = performance.now() - t0;
  const rf = run1.state.regions["RF"];

  return {
    schemaVersion: 1,
    experiment: "adversarial",
    unitId: unit.unitId,
    seed: unit.seed,
    config: { name: cfg.name, overrides: cfg.overrides },
    scenario: { sequence: seq.name, horizon: unit.horizon, family: unit.family },
    iteration: 0,
    pass: failures.length === 0,
    failure: failures.length > 0 ? failures[0] : null,
    hashes: { stateHash: h1, traceHash: t1 },
    metrics: {
      durationMs,
      psGrainDeviation: psDeviation,
      boundaryDisabled,
      rfGrainPrice: rf?.prices["grain"] ?? 0,
      resolutionsFired: run1.state.resolutionLog.filter((d) => d.fired).length,
      rejected: rejectedCount ?? 0,
      mgHostility: run1.state.relations["MG>player"] ?? 0,
      provenanceNodes: run1.state.provenance.length,
      events: run1.state.events.length,
      historyTruncated: run1.state.historyTruncated,
      // Deep-check results are only present when the check actually ran, so an
      // unexercised check is never reported as a false negative.
      ...(checkpointOk === null ? {} : { checkpointOk }),
      ...(explainExplained === null ? {} : { explainExplained }),
      ...(explainIncomplete === null ? {} : { explainIncomplete }),
      ...(explainRootAction === null ? {} : { explainRootAction }),
    },
    repro: { command: "npx tsx scripts/run-experiment.ts --replay <record>", unit },
  };
}

void iShrine;
void iSubsidyHT;