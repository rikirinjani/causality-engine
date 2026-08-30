/** Core world-state types for Causality Engine. See docs/RECONNAISSANCE.md §3/§4/§16. */

import type { SimConfig } from "./config.js";
import type { ProvenanceNode, ResolutionDecision } from "./provenance.js";
import type { SignalTrace } from "./dynamics.js";
import type { Lineage } from "./genealogy.js";

export type RegionId = string;
export type EntityId = string;
export type ResourceId = string;
/** A provenance node id. Aliased so lifecycle code reads clearly. */
export type ProvenanceNodeRef = string;

/**
 * Causal domains. `civic` is deliberately non-economic: it exists to prove that a
 * change in one domain does NOT leak into the economy unless a relationship is
 * explicitly modelled (docs/RECONNAISSANCE.md §15, Experiment F).
 */
export type DomainId = "civic" | "ecology" | "economy" | "faction";

/** Canonical domain processing order (alphabetical — never rely on object key order). */
export const DOMAIN_ORDER: readonly DomainId[] = ["civic", "ecology", "economy", "faction"] as const;

/**
 * Where a ledger entry's pressure came from.
 *
 *   primary   — traceable to a submitted intervention (generation 0)
 *   boundary  — INHERITED: a decayed share of pressure that already existed elsewhere.
 *               Carries no new causal information, so it must never relay (§6).
 *   generated — NEWLY CREATED by a state transition that crossed a materiality threshold.
 *               This is genuine new causality, so it MAY propagate — but it increments the
 *               causal generation, which is bounded. Conflating this with `boundary` was the
 *               gap the feedback pass had to close (§16.6).
 */
export type PressureOrigin = "primary" | "boundary" | "generated";

/** Origins that represent real new causal information and are therefore allowed to propagate. */
export const PROPAGATING_ORIGINS: readonly PressureOrigin[] = ["primary", "generated"] as const;

/**
 * A deferred causal contribution.
 *
 * `pressure` is UNSIGNED salience: "how much does this domain need to be reconsidered?"
 * `valence` is the SIGNED direction, and the convention is **+1 = disruptive**:
 *
 *    +1  the cause stresses the domain   (destroy a bridge, burn a granary)
 *    -1  the cause relieves the domain   (grant a subsidy, restock a store)
 *
 * The disruptive direction is positive because every resolver was calibrated with
 * disruption as positive pressure; keeping that sign means all prior calibration
 * (§14, §15) survives bit-for-bit and only relief is new.
 *
 * Keeping salience and direction separate is load-bearing. If pressure were signed, two
 * equal opposing causes would sum to zero and NOTHING would resolve — both causes erased,
 * the exact failure class fixed in §15.9. A town whose granary burned *and* received a
 * subsidy is not a quiet town. Salience adds; direction nets. See §16.4.
 */
export interface CausalContribution {
  domain: DomainId;
  /** Magnitude / salience. Always >= 0. */
  pressure: number;
  /** Direction in [-1, +1]; +1 = disruptive, -1 = relieving. */
  valence: number;
  scope: "regional" | "global";
}

export interface InterventionTarget {
  type: "infrastructure" | "entity" | "region";
  id: string;
}

/**
 * A player/world action submitted through the adapter boundary.
 * Typed + validated via the action-schema registry (developer-authored causal physics).
 */
export interface Intervention {
  id: string;
  tick: number; // injected by engine (not wall-clock)
  actor: string; // "player" | factionId | "system" | npcId
  action: string; // registry key, e.g. "destroy_infrastructure"
  target: InterventionTarget;
  location: RegionId;
  intent?: string;
  magnitude: number; // 0..1 normalized
  causalDomains: CausalContribution[];
  provenance: { submittedAtTick: number; sequence: number };
}

/**
 * Outbound stream event — a HISTORICAL FACT about the world (see core/events.ts for the
 * ontology). Not a command, not a presentation hint, and not a delivery obligation: delivery
 * bookkeeping lives in `DeliveryState`, outside the world entirely.
 */
export interface WorldEvent {
  /** Deterministic, timeline-scoped identity. Derived from content + position, never a counter. */
  id: string;
  type: string;
  source: string;
  regionId?: RegionId;
  data: Record<string, unknown>;
  tick: number;
  /** Within-tick emission position; keeps otherwise-identical facts distinguishable. */
  ordinal: number;
  /**
   * STABLE STREAM COORDINATE: monotonic per timeline, assigned at emission, never renumbered.
   *
   * Cursors reference this, never an array index. An index into the derived stream shifts when
   * the bounded record evicts its oldest entries, which silently repositioned consumers onto
   * different facts — measured as 2 facts skipped with no gap reported. See
   * self-harness/failures/2026-08-31-architecture-cursor-positions-shift-on-eviction.json
   */
  streamSeq: number;
}

/**
 * A structure. `reserve` models stored goods (a granary's buffer): destroying the
 * structure both disables it and destroys its contents — a generic property of
 * destruction, not a per-structure special case.
 */
export interface Structure {
  type: string; // "trade_route" | "storage" | "shrine"
  health: number;
  endpoints: RegionId[];
  reserve?: number;
  resource?: ResourceId;
}

/** A spatial simulation partition with its own causal ledger (quota) and derived state. */
export interface Region {
  id: RegionId;
  name: string;
  neighbors: RegionId[];
  stocks: Record<ResourceId, number>;
  prices: Record<ResourceId, number>;
  /** Transient price multiplier; relaxes toward 1.0 each tick. */
  priceShock: Partial<Record<ResourceId, number>>;
  /** Transient grain production modifier from ecology resolution; applies next tick, then resets. */
  grainProdMod?: number;
  infrastructure: Record<string, Structure>;
  population: EntityId[];
  /** Accumulated causal pressure per domain (the quota ledger). Unsigned salience. */
  ledger: Partial<Record<DomainId, number>>;
  /** Net signed direction of the accumulated pressure, magnitude-weighted. */
  ledgerValence: Partial<Record<DomainId, number>>;
  /** Unsigned totals of pushing-down and pushing-up contributions, for contest detection. */
  ledgerNegative: Partial<Record<DomainId, number>>;
  ledgerPositive: Partial<Record<DomainId, number>>;
  /** Origin of each ledger entry — governs whether it may propagate. */
  ledgerOrigin: Partial<Record<DomainId, PressureOrigin>>;
  /** Causal generation of each ledger entry (0 = player action). Bounds recurrence. */
  ledgerGeneration: Partial<Record<DomainId, number>>;
  patrolDemand: number;
  /** Civic unrest 0..1 — non-economic. Raises patrol demand; never touches prices. */
  unrest: number;

  // ---- feedback loop state (§16.1) ----
  /** Merchant trade investment 0..1; scales effective trade capacity. */
  tradeInvestment: number;
  /** Last computed merchant profitability signal (may be negative). */
  merchantProfitability: number;
  /** Effective trade capacity actually used this tick = investment (clamped). */
  tradeCapacityFactor: number;
}

export interface Entity {
  id: EntityId;
  type: string; // "faction" | "agent"
  role: string; // "faction" | "farmer" | "merchant" | "guard" | "artisan"
  attrs: Record<string, number | string | boolean>;
  location: RegionId;
  factionId?: string;
}

/**
 * One contribution landing in a pending bucket, kept individually so the bucket's scalars
 * can be re-derived by CANONICAL SUMMATION rather than incremental accumulation.
 *
 * Why: IEEE-754 addition is commutative but NOT associative, so `raw += m` in arrival order
 * produces order-dependent bits (measured: 2.35000000000000008882 vs 2.34999999999999964473
 * for the same five contributions). That silently broke the guarantee that canonical batching
 * yields an identical state hash. See
 * self-harness/failures/2026-08-30-architecture-float-nonassociativity-canonical-order.json
 *
 * CONTAINS PHYSICS ONLY. Provenance node ids deliberately live in `WorldState.pendingCauses`,
 * not here: ids are renumbered by compaction and migration, and if they were part of a bucket
 * they would enter `stateHash` and make a physically identical world hash differently. That
 * leak was real and is recorded at
 * self-harness/failures/2026-08-31-architecture-provenance-ids-leak-into-state-identity.json
 */
export interface PendingItem {
  /** Unsigned magnitude. */
  magnitude: number;
  /** Direction; +1 disruptive, -1 relieving. */
  valence: number;
  origin: PressureOrigin;
  generation: number;
}

/** A pending contribution carries origin + generation so propagation stays bounded. */
export interface PendingEntry {
  /**
   * Saturated salience actually applied to the ledger. DERIVED from `raw` — never
   * accumulated in place.
   */
  pressure: number;
  /** Canonical (sorted-fold) sum of contribution MAGNITUDES before saturation. */
  raw: number;
  /** Canonical sum of magnitude x valence. */
  netValence: number;
  /** Canonical sum of valence<0 magnitudes. */
  negativeRaw: number;
  /** Canonical sum of valence>0 magnitudes. */
  positiveRaw: number;
  origin: PressureOrigin;
  /** Highest causal generation among contributors. */
  generation: number;
  /** The individual contributions, retained so scalars stay order-independent. */
  items: PendingItem[];
}

/**
 * A causal-model anomaly the engine refuses to resolve silently.
 * Surfacing these is the point: a plausible-looking number for a semantically
 * unresolved situation is worse than an explicit diagnostic (§16.10).
 */
export interface CausalDiagnostic {
  tick: number;
  kind:
    | "recurrence_cutoff" // generation bound hit — computational cutoff, NOT convergence
    | "contested_resolution" // opposing causes of comparable weight in one epoch
    | "oscillation_detected"
    | "divergence_detected"
    | "convergence_not_reached"; // window closed without a stable classification
  regionId?: RegionId;
  domain?: DomainId;
  signal?: string;
  detail: Record<string, string | number | boolean>;
}

export interface WorldState {
  tick: number;
  rngState: import("./rng.js").RNGState;
  /**
   * Genealogy: which world, which timeline, forked from where (see core/genealogy.ts).
   * Lives inside WorldState so it is covered by stateHash — a save file must not be able to
   * masquerade as a different lineage while claiming the same identity.
   *
   * Replaces the earlier `universe` field, which was Kronos-inherited terminology.
   */
  lineage: Lineage;
  schemaVersion: number;
  /** Tuning lives in state so snapshots are self-describing and config is covered by the state hash. */
  config: SimConfig;
  regions: Record<RegionId, Region>;
  entities: Record<EntityId, Entity>;
  /** Directed relations; key "MG>player" = hostility 0..1. */
  relations: Record<string, number>;
  /** Outbound event stream, bounded. */
  events: WorldEvent[];
  eventSeq: number;
  /**
   * Highest `streamSeq` ever assigned in this timeline. Monotonic; never decreases, not even
   * when events are evicted. With `oldestRetainedSeq` this defines the eviction boundary, so a
   * gap is computed from CE's own bookkeeping rather than from a caller-supplied guess.
   */
  highestEmittedSeq: number;
  /**
   * Lowest `streamSeq` still present in `events`. Rises as the record evicts. A consumer whose
   * cursor sits below this has provably missed facts, which is what makes a gap detectable.
   */
  oldestRetainedSeq: number;
  /** Facts evicted from the record over this timeline's life. Audit / diagnostics only. */
  evictedCount: number;
  interventionSeq: number;
  /** Per-tick trade volume (economy heartbeat). */
  tradeVolume: number;
  /** Per-tick contribution bucket (region -> domain -> entry). */
  pendingContributions: Partial<Record<RegionId, Partial<Record<DomainId, PendingEntry>>>>;

  // ---- causal provenance (structured, multi-parent DAG) ----
  provenance: ProvenanceNode[];
  /** Tracked quantity -> node id currently explaining it. */
  provenanceRefs: Record<string, string>;
  provenanceSeq: number;
  /** Every quota threshold check, fired or not — the resolution-decision record. */
  resolutionLog: ResolutionDecision[];
  /**
   * Provenance node ids explaining each ledger entry, keyed `"regionId:domain"`.
   *
   * Deliberately stored HERE rather than on `Region`: node ids depend on submission
   * order, so keeping them inside the hashed region state would make `stateHash` differ
   * for worlds that are physically identical but were reached by different routes. Causal
   * history belongs to `traceHash`; the world belongs to `stateHash`.
   */
  ledgerCauses: Record<string, string[]>;
  /**
   * Provenance node ids explaining each PENDING bucket, keyed `"regionId:domain"`.
   *
   * Same reasoning as `ledgerCauses`, and the same mistake was made twice: node ids are
   * renumbered by compaction and migration, so keeping them inside the bucket made a
   * physically identical world hash differently. Trace-side, excluded from stateHash.
   */
  pendingCauses: Record<string, string[]>;

  /**
   * Interventions accepted by this world, in submission order.
   *
   * Moved out of the engine handle during the persistence pass: intervention history is part
   * of what must survive a save, and leaving it in a non-serialized engine field meant a
   * restored world silently forgot what had been done to it. Part of traceHash, not
   * stateHash — the same world can be reached by different action histories (§17.1).
   */
  interventionHistory: Intervention[];
  /**
   * True once any bounded log (provenance, resolution, diagnostics, events) has discarded
   * entries. An explanation drawn from a truncated trace must not claim completeness (§17.7).
   */
  historyTruncated: boolean;

  // ---- feedback / convergence (§16) ----
  /** Tracked signal histories with convergence classification, keyed by signal name. */
  dynamics: Record<string, SignalTrace>;
  /** Explicit anomalies. Never silently swallowed. */
  diagnostics: CausalDiagnostic[];
}
