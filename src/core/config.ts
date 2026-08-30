import type { DomainId } from "./types.js";

/**
 * All tunable simulation parameters in one place.
 *
 * Config lives INSIDE WorldState (see types.ts) so snapshots are self-describing
 * and the state hash covers configuration. This closes a documented Kronos Engine
 * gap: KE's cadence/tuning config was not part of the universe hash, so two runs
 * with different tuning could produce indistinguishable provenance.
 */
export interface SimConfig {
  seed: number;

  // ---- Causal Quota (budget governor) ----
  /** Per-domain resolution thresholds. */
  thresholds: Record<DomainId, number>;
  /** Multiplier applied to unresolved ledger entries each tick. */
  ledgerDecayPerTick: number;
  /**
   * Ceiling on accumulated pressure per domain/region/tick (anti-gaming).
   * Reached asymptotically via saturating accumulation, never by a hard clamp —
   * see `pressureSoftKnee` and `saturate()` in core/propagation.ts.
   */
  capPerDomainRegionTick: number;
  /**
   * Pressure below this accumulates LINEARLY; above it, additional pressure saturates
   * toward the cap. Set to the magnitude of the strongest single action so that
   * single-action calibration is exact and only genuine multi-action stacking compresses.
   */
  pressureSoftKnee: number;
  /** Hard cap on a single ledger entry. */
  capLedgerEntry: number;
  /** Ledger entries below this are dropped. */
  ledgerFloor: number;
  /**
   * min(neg,pos)/max(neg,pos) at or above which opposing causes count as CONTESTED.
   * A contested resolution still applies its net direction, but emits a diagnostic
   * rather than quietly reporting a plausible average (§16.4, §16.10).
   */
  contestRatio: number;

  // ---- Causal recurrence bound (§16.6) ----
  /**
   * Maximum causal GENERATION. Generation 0 is a player intervention; a state transition
   * that generates genuinely new pressure produces generation n+1. Beyond this bound,
   * generated pressure is refused and a `recurrence_cutoff` diagnostic is emitted.
   *
   * This is a COMPUTATIONAL cutoff, not a claim about convergence. It exists so a cyclic
   * world cannot perform unbounded work per intervention, and hitting it is always reported.
   */
  maxCausalGeneration: number;
  /**
   * A state transition must move a signal by at least this fraction of its own scale to
   * count as newly generated causality. Below it, the change is real but causally inert —
   * this is what stops micro-jitter manufacturing infinite generations.
   */
  generationMateriality: number;

  // ---- Cross-region boundary signals (locality) ----
  /** Fraction of resolved pressure passed to each neighbour, per hop. */
  boundaryDecay: number;
  /** Max hops a signal may travel from its origin region (0 = no propagation). */
  boundaryMaxHops: number;
  /** Boundary signals weaker than this are not emitted. */
  boundaryFloor: number;

  // ---- Economy ----
  targetStock: number;
  storageCap: number;
  tradeRate: number;
  /** Warehouse starting grain reserve. */
  warehouseInitialReserve: number;
  /** Grain released from a healthy warehouse per tick while the town is short. */
  warehouseReleaseRate: number;
  /** Warehouse releases only while stock < this fraction of targetStock. */
  warehouseLowStockFraction: number;
  /** Grain reserve granted by a merchant subsidy (competing-cause action). */
  subsidyReserveGrant: number;
  /** Immediate trade-investment boost from a merchant subsidy. */
  subsidyInvestmentBoost: number;
  /** Exponent on the stock/price curve. */
  priceExponent: number;
  priceClampMin: number;
  priceClampMax: number;
  /** Price shock relaxes toward 1.0 by this fraction each tick. */
  priceShockRelax: number;
  /** Resolution: priceShock *= (1 + this * pressure). */
  economyPressureToPriceShock: number;
  /** Resolution: hostility += this * pressure. */
  economyPressureToHostility: number;

  // ---- Ecology ----
  /** Resolution: next-tick grain production *= (1 - this * pressure). */
  ecologyPressureToProdLoss: number;

  // ---- Factions ----
  /** Resolution: hostility += this * pressure. */
  factionPressureToHostility: number;
  hostilityDecayPerTick: number;
  hostilityFloor: number;
  mgMargin: number;
  waTaxRate: number;
  patrolBase: number;
  patrolGain: number;
  /** Grain price above which a region counts as food-short. */
  shortagePriceThreshold: number;
  /** Patrol demand above which guards actually patrol. */
  patrolActiveThreshold: number;

  // ---- Civic (deliberately NON-economic; see Experiment F) ----
  /** Resolution: unrest += this * pressure. */
  civicPressureToUnrest: number;
  /** Unrest decays toward 0 by this amount each tick. */
  unrestDecayPerTick: number;
  /** Patrol demand contribution from civic unrest. */
  patrolUnrestGain: number;

  // ---- Feedback loop: merchant investment (§16.1) ----
  /**
   * Merchant profitability = margin x tradeVolume - carryCost x price.
   * The price term is what closes the loop: expensive grain erodes profit, profit drives
   * investment, investment drives trade capacity, capacity drives supply, supply sets price.
   */
  investmentCarryCost: number;
  /** Investment moves toward its profitability target by this fraction per tick (relaxation). */
  investmentAdjustRate: number;
  /** Profitability at or above which investment targets 1.0. */
  investmentProfitReference: number;
  investmentMin: number;
  investmentMax: number;
  /** Investment below this scales trade capacity down proportionally. */
  investmentTradeFloor: number;

  // ---- Convergence detection (§16.2) ----
  convergenceEpsilon: number;
  convergenceStableSamples: number;
  oscillationAlternations: number;
  oscillationMinAmplitude: number;
  divergenceGrowth: number;
  divergenceSamples: number;
  dynamicsHistoryWindow: number;
  /** Relative tolerance for deciding a tracked signal is pinned against a clamp. */
  boundTolerance: number;
}

/**
 * Defaults calibrated by the parameter sweep (`src/poc/sweep.ts`, 48-cell grid over
 * threshold x ledger decay x boundary decay). Rationale for each quota/locality value:
 *
 *   thresholds 0.6    — 0.3 lets boundary pressure cross threshold in an unconnected
 *                       region (locality breaks); 1.2 never fires at all. 0.6 is the
 *                       lowest value where the quota fires AND locality holds.
 *   ledgerDecay 0.8   — 0.9 leaves pressure lingering ~60 ticks after a single action;
 *                       0.8 settles in ~28. 0.95 never fully drains within 120 ticks.
 *   boundaryDecay 0.3 — 0.5 leaks enough pressure to break locality in the far region;
 *                       0.3 keeps a clear margin while still signalling neighbours.
 *
 * Everything else is content tuning, not yet swept.
 */
export const DEFAULT_CONFIG: SimConfig = {
  seed: 42,

  thresholds: { civic: 0.6, ecology: 0.6, economy: 0.6, faction: 0.6 },
  ledgerDecayPerTick: 0.8,
  capPerDomainRegionTick: 2.0,
  pressureSoftKnee: 1.0,
  capLedgerEntry: 2.0,
  ledgerFloor: 0.001,
  contestRatio: 0.5,

  boundaryDecay: 0.3,
  boundaryMaxHops: 2,
  boundaryFloor: 0.05,

  targetStock: 50,
  storageCap: 100,
  tradeRate: 8,
  warehouseInitialReserve: 60,
  warehouseReleaseRate: 6,
  warehouseLowStockFraction: 0.8,
  subsidyReserveGrant: 40,
  subsidyInvestmentBoost: 0.3,
  priceExponent: 0.5,
  priceClampMin: 0.3,
  priceClampMax: 4.0,
  priceShockRelax: 0.5,
  economyPressureToPriceShock: 0.5,
  economyPressureToHostility: 0.3,

  ecologyPressureToProdLoss: 0.2,

  factionPressureToHostility: 0.4,
  hostilityDecayPerTick: 0.02,
  hostilityFloor: 0.1,
  mgMargin: 0.1,
  waTaxRate: 0.02,
  patrolBase: 0.2,
  patrolGain: 0.8,
  shortagePriceThreshold: 15,
  patrolActiveThreshold: 0.6,

  civicPressureToUnrest: 0.5,
  unrestDecayPerTick: 0.05,
  patrolUnrestGain: 0.5,

  investmentCarryCost: 0.045,
  investmentAdjustRate: 0.35,
  // MUST equal mgMargin*tradeRate - investmentCarryCost*grainBasePrice = 0.8 - 0.45 = 0.35,
  // so that a world at rest sits exactly on the loop's fixed point (target investment 1.0).
  // Asserted by `investment equilibrium is an exact fixed point` in feedback.test.ts.
  investmentProfitReference: 0.35,
  investmentMin: 0.1,
  investmentMax: 1.0,
  investmentTradeFloor: 1.0,

  convergenceEpsilon: 0.01,
  convergenceStableSamples: 3,
  oscillationAlternations: 4,
  oscillationMinAmplitude: 0.02,
  divergenceGrowth: 1.25,
  divergenceSamples: 3,
  dynamicsHistoryWindow: 24,
  boundTolerance: 0.001,

  maxCausalGeneration: 3,
  generationMateriality: 0.15,
};

/** Build a config from partial overrides (deep-merges `thresholds`). */
export function makeConfig(overrides: Partial<SimConfig> = {}): SimConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    thresholds: { ...DEFAULT_CONFIG.thresholds, ...(overrides.thresholds ?? {}) },
  };
}

/** Set every domain threshold to the same value (sweep/calibration convenience). */
export function uniformThresholds(value: number): Record<DomainId, number> {
  const out = {} as Record<DomainId, number>;
  for (const domain of Object.keys(DEFAULT_CONFIG.thresholds) as DomainId[]) out[domain] = value;
  return out;
}
