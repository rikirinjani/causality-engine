import { advance, createEngine, createWorld, submitBatch, submitIntervention, tick, type Engine } from "../core/world.js";
import { stateHash, traceHash } from "../core/hash.js";
import { explain, key, type Explanation } from "../core/provenance.js";
import { ROUTE_ID, SHRINE_ID, WAREHOUSE_ID, WORLD_SEED } from "../game/content.js";
import type { Intervention, RegionId, WorldState } from "../core/types.js";

/**
 * Multi-intervention causality stress harness (docs/RECONNAISSANCE.md §15).
 *
 * Builds worlds, applies labelled intervention sequences, and extracts comparable
 * observations. Everything here is measurement — no causal rules live in this file, so an
 * experiment cannot accidentally author the behaviour it claims to discover.
 */

// ---------------------------------------------------------------------------
// Intervention catalogue (the four required kinds)
// ---------------------------------------------------------------------------

export type InterventionKind = "bridge" | "merchant" | "warehouse" | "rally";

function base(id: string, action: string): Omit<Intervention, "target" | "location"> {
  return {
    id,
    tick: 0,
    actor: "player",
    action,
    intent: "stress-test",
    magnitude: 1,
    causalDomains: [],
    provenance: { submittedAtTick: 0, sequence: 0 },
  };
}

/** A: destroy the trade-route bridge (economic + ecological + faction pressure). */
export function iBridge(id = "iA-bridge"): Intervention {
  return { ...base(id, "destroy_infrastructure"), target: { type: "infrastructure", id: ROUTE_ID }, location: "RF" };
}

/** B: kill a Merchant Guild member (faction + economy + civic pressure). */
export function iMerchant(id = "iB-merchant", entityId = "a07"): Intervention {
  return { ...base(id, "kill_entity"), target: { type: "entity", id: entityId }, location: "RF" };
}

/** C: destroy the grain warehouse (ecology + economy pressure; destroys stored reserve). */
export function iWarehouse(id = "iC-warehouse"): Intervention {
  return { ...base(id, "destroy_infrastructure"), target: { type: "infrastructure", id: WAREHOUSE_ID }, location: "RF" };
}

/** D: a purely civic action that must NOT reach the economy (Experiment F control). */
export function iRally(id = "iD-rally"): Intervention {
  return { ...base(id, "hold_public_rally"), target: { type: "region", id: "RF" }, location: "RF" };
}

/** A non-economic destruction: the shrine. Civic only. */
export function iShrine(id = "iE-shrine"): Intervention {
  return { ...base(id, "destroy_infrastructure"), target: { type: "infrastructure", id: SHRINE_ID }, location: "RF" };
}

/**
 * A merchant subsidy: the COMPETING CAUSE (§16.4). Relieving valence on the same domains
 * the granary destruction stresses.
 */
export function iSubsidy(id = "iF-subsidy", region: RegionId = "RF"): Intervention {
  return { ...base(id, "grant_merchant_subsidy"), target: { type: "region", id: region }, location: region };
}

/** A subsidy aimed at the exporting town — where investment dynamics actually live. */
export function iSubsidyHT(id = "iG-subsidy-ht"): Intervention {
  return iSubsidy(id, "HT");
}

export const FACTORY: Record<InterventionKind, (id?: string) => Intervention> = {
  bridge: iBridge,
  merchant: iMerchant,
  warehouse: iWarehouse,
  rally: iRally,
};

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

/** The quantities the brief requires measuring, plus causal bookkeeping. */
export interface Observation {
  tick: number;
  tradeCapacity: number; // route health at the exporter endpoint (0 = severed)
  tradeVolume: number;
  rfGrainStock: number;
  htGrainStock: number;
  psGrainStock: number;
  rfGrainPrice: number;
  htGrainPrice: number;
  psGrainPrice: number;
  warehouseReserve: number;
  mgIncomeRate: number;
  mgTreasury: number;
  mgHostility: number;
  rfPatrolDemand: number;
  rfUnrest: number;
  rfGuardPatrolling: boolean;
  rfPopulation: number;
  // ---- feedback loop observables (§16) ----
  htTradeInvestment: number;
  htProfitability: number;
  rfTradeInvestment: number;
  diagnosticCount: number;
  generatedPressureEvents: number;
  resolutionsFired: number;
  resolutionsChecked: number;
  stateHash: string;
  traceHash: string;
}

export function observe(state: WorldState): Observation {
  const rf = state.regions["RF"]!;
  const ht = state.regions["HT"]!;
  const ps = state.regions["PS"]!;
  const mg = state.entities["MG"]!;
  const guard = state.entities["a13"];
  const route = ht.infrastructure[ROUTE_ID];
  const warehouse = rf.infrastructure[WAREHOUSE_ID];

  return {
    tick: state.tick,
    tradeCapacity: route?.health ?? 0,
    tradeVolume: state.tradeVolume,
    rfGrainStock: rf.stocks["grain"] ?? 0,
    htGrainStock: ht.stocks["grain"] ?? 0,
    psGrainStock: ps.stocks["grain"] ?? 0,
    rfGrainPrice: rf.prices["grain"] ?? 0,
    htGrainPrice: ht.prices["grain"] ?? 0,
    psGrainPrice: ps.prices["grain"] ?? 0,
    warehouseReserve: warehouse?.reserve ?? 0,
    mgIncomeRate: mg.attrs.incomeRate as number,
    mgTreasury: mg.attrs.treasury as number,
    mgHostility: state.relations["MG>player"] ?? 0,
    rfPatrolDemand: rf.patrolDemand,
    rfUnrest: rf.unrest,
    rfGuardPatrolling: guard?.attrs.patrolling === true,
    rfPopulation: rf.population.length,
    htTradeInvestment: ht.tradeInvestment,
    htProfitability: ht.merchantProfitability,
    rfTradeInvestment: rf.tradeInvestment,
    diagnosticCount: state.diagnostics.length,
    generatedPressureEvents: state.provenance.filter((n) => n.label === "economy_pressure_generated").length,
    resolutionsFired: state.resolutionLog.filter((d) => d.fired).length,
    resolutionsChecked: state.resolutionLog.length,
    stateHash: stateHash(state),
    traceHash: traceHash(state),
  };
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

export interface ScheduledIntervention {
  atTick: number;
  intervention: Intervention;
}

export interface RunResult {
  label: string;
  state: WorldState;
  engine: Engine;
  final: Observation;
  series: Observation[];
  rejected: Array<{ id: string; errors: string[] }>;
  /** Trajectory summaries — a single horizon reading hides timing effects (see §15 Exp B). */
  summary: TrajectorySummary;
}

/**
 * Trajectory measures. Necessary because two runs can converge to the same final state by
 * very different routes: bridge-alone and bridge+warehouse both end with an empty granary,
 * but one takes 2.5x longer to get there. Comparing only endpoints would report "no
 * composition" when the composition is entirely in the rate.
 */
export interface TrajectorySummary {
  peakRFPrice: number;
  minRFStock: number;
  peakHostility: number;
  peakPatrolDemand: number;
  peakUnrest: number;
  /** First tick at which RF grain stock hit zero (null = never starved). */
  starvationTick: number | null;
  /** Ticks with zero trade volume. */
  ticksTradeBlocked: number;
  /** Cumulative MG income over the run — the integral, not the instantaneous rate. */
  totalMGIncome: number;
  resolutionsFired: number;
  // ---- feedback observables (§16) ----
  minHTInvestment: number;
  maxHTInvestment: number;
  /** Times investment reversed direction — a cheap oscillation proxy independent of dynamics.ts. */
  investmentReversals: number;
  finalDiagnosticCount: number;
}

function summarize(series: Observation[]): TrajectorySummary {
  const starved = series.find((o) => o.rfGrainStock <= 0);
  const inv = series.map((o) => o.htTradeInvestment);
  let reversals = 0;
  for (let i = 2; i < inv.length; i++) {
    const d1 = inv[i - 1]! - inv[i - 2]!;
    const d2 = inv[i]! - inv[i - 1]!;
    if (Math.abs(d1) > 1e-6 && Math.abs(d2) > 1e-6 && Math.sign(d1) !== Math.sign(d2)) reversals += 1;
  }
  const last = series.length > 0 ? series[series.length - 1] : undefined;
  return {
    peakRFPrice: Math.max(...series.map((o) => o.rfGrainPrice)),
    minRFStock: Math.min(...series.map((o) => o.rfGrainStock)),
    peakHostility: Math.max(...series.map((o) => o.mgHostility)),
    peakPatrolDemand: Math.max(...series.map((o) => o.rfPatrolDemand)),
    peakUnrest: Math.max(...series.map((o) => o.rfUnrest)),
    starvationTick: starved ? starved.tick : null,
    ticksTradeBlocked: series.filter((o) => o.tradeVolume === 0).length,
    totalMGIncome: series.reduce((acc, o) => acc + o.mgIncomeRate, 0),
    resolutionsFired: last?.resolutionsFired ?? 0,
    minHTInvestment: Math.min(...inv),
    maxHTInvestment: Math.max(...inv),
    investmentReversals: reversals,
    finalDiagnosticCount: last?.diagnosticCount ?? 0,
  };
}

export interface RunOptions {
  label: string;
  schedule: ScheduledIntervention[];
  totalTicks?: number;
  seed?: number;
  /** Use canonical id-sorted batching for same-tick groups instead of submission order. */
  canonicalBatch?: boolean;
  configOverrides?: Parameters<typeof createWorld>[0];
}

/**
 * Run a scenario. Interventions are submitted at the START of their scheduled tick
 * (i.e. before that tick executes), grouped by tick so same-tick behaviour is explicit.
 */
export function run(options: RunOptions): RunResult {
  const { label, schedule, totalTicks = 40, seed = WORLD_SEED, canonicalBatch = false } = options;
  const engine = createEngine();
  const state = createWorld({ seed, ...(options.configOverrides ?? {}) }, engine);
  const rejected: Array<{ id: string; errors: string[] }> = [];
  const series: Observation[] = [];

  // group by tick, preserving submission order within a tick
  const byTick = new Map<number, Intervention[]>();
  for (const s of schedule) {
    const list = byTick.get(s.atTick) ?? [];
    list.push(s.intervention);
    byTick.set(s.atTick, list);
  }

  for (let t = 1; t <= totalTicks; t++) {
    const due = byTick.get(t);
    if (due && due.length > 0) {
      if (canonicalBatch) {
        for (const r of submitBatch(state, due, engine)) {
          if (!r.ok) rejected.push({ id: r.id, errors: r.errors });
        }
      } else {
        for (const i of due) {
          const r = submitIntervention(state, i, engine);
          if (!r.ok) rejected.push({ id: i.id, errors: r.errors });
        }
      }
    }
    tick(state, engine);
    series.push(observe(state));
  }

  return { label, state, engine, final: observe(state), series, rejected, summary: summarize(series) };
}

/** Convenience: schedule a list of kinds, one per tick, starting at `startTick`. */
export function sequential(kinds: InterventionKind[], startTick = 10, gap = 1): ScheduledIntervention[] {
  return kinds.map((kind, idx) => ({ atTick: startTick + idx * gap, intervention: FACTORY[kind]() }));
}

/** Convenience: schedule a list of kinds all in the SAME tick. */
export function sameTick(kinds: InterventionKind[], atTick = 10): ScheduledIntervention[] {
  return kinds.map((kind) => ({ atTick, intervention: FACTORY[kind]() }));
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

export const MEASURED_KEYS = [
  "tradeCapacity",
  "tradeVolume",
  "rfGrainStock",
  "rfGrainPrice",
  "htGrainPrice",
  "psGrainPrice",
  "warehouseReserve",
  "mgIncomeRate",
  "mgTreasury",
  "mgHostility",
  "rfPatrolDemand",
  "rfUnrest",
  "rfPopulation",
] as const satisfies ReadonlyArray<keyof Observation>;

export type MeasuredKey = (typeof MEASURED_KEYS)[number];

export interface FieldDiff {
  field: MeasuredKey;
  a: number | boolean;
  b: number | boolean;
  delta: number;
  differs: boolean;
}

export function diff(a: Observation, b: Observation, tolerance = 1e-9): FieldDiff[] {
  return MEASURED_KEYS.map((field) => {
    const av = a[field];
    const bv = b[field];
    const an = typeof av === "boolean" ? (av ? 1 : 0) : av;
    const bn = typeof bv === "boolean" ? (bv ? 1 : 0) : bv;
    const delta = bn - an;
    return { field, a: av, b: bv, delta, differs: Math.abs(delta) > tolerance };
  });
}

/** Fields that differ between two runs. */
export function differingFields(a: Observation, b: Observation, tolerance = 1e-9): MeasuredKey[] {
  return diff(a, b, tolerance)
    .filter((d) => d.differs)
    .map((d) => d.field);
}

// ---------------------------------------------------------------------------
// Provenance queries (Experiment E)
// ---------------------------------------------------------------------------

export interface CausalQuery {
  question: string;
  quantity: string;
  explanation: Explanation;
}

export function askWhy(state: WorldState): CausalQuery[] {
  return [
    {
      question: "Why did grain price increase?",
      quantity: key.price("RF", "grain"),
      explanation: explain(state, key.price("RF", "grain")),
    },
    {
      question: "Why did faction hostility increase?",
      quantity: key.hostility("MG"),
      explanation: explain(state, key.hostility("MG")),
    },
    {
      question: "Why did patrol activity increase?",
      quantity: key.patrolDemand("RF"),
      explanation: explain(state, key.patrolDemand("RF")),
    },
  ];
}

/** Distinct originating intervention ids behind a quantity, sorted. */
export function rootCauseIds(state: WorldState, quantityKey: string): string[] {
  return [...new Set(explain(state, quantityKey).roots.map((r) => r.interventionId))].sort();
}
