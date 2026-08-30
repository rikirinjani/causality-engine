import {
  DOMAIN_ORDER,
  PROPAGATING_ORIGINS,
  type CausalDiagnostic,
  type DomainId,
  type PendingEntry,
  type PendingItem,
  type PressureOrigin,
  type RegionId,
  type WorldState,
} from "./types.js";

/**
 * Cross-region signals and pressure accumulation (docs/RECONNAISSANCE.md §6, §16.4, §16.6).
 *
 * PROPAGATION RULE (revised by the feedback pass). Originally: "only primary pressure
 * propagates; boundary pressure may resolve but never relay." That rule was necessary but
 * NOT sufficient, because it conflated two different things:
 *
 *   INHERITED pressure  — a decayed share of pressure that already exists elsewhere. It
 *                         carries no new causal information. Relaying it is double-counting,
 *                         and two neighbours would trade it forever.
 *   GENERATED pressure  — pressure created by a STATE TRANSITION that actually happened in
 *                         this region (a granary emptied, trade collapsed). That is real new
 *                         causality. Refusing to propagate it would mean a consequence in B
 *                         caused by A can never affect anything, which silently truncates
 *                         legitimate causal chains.
 *
 * So `generated` pressure MAY propagate, but each generation step increments a causal
 * GENERATION counter bounded by `maxCausalGeneration`. Reaching the bound is a COMPUTATIONAL
 * cutoff and always emits a `recurrence_cutoff` diagnostic — never silently dropped.
 *
 * Signals are computed in ONE shot via breadth-first hop distance (not chained re-emission)
 * and land in the NEXT tick's bucket, keeping each tick a pure function of its start state.
 */

/** Hop distances from `origin` over the region graph, up to `maxHops` (origin excluded). */
export function hopDistances(
  state: WorldState,
  origin: RegionId,
  maxHops: number,
): Array<{ regionId: RegionId; hops: number }> {
  if (maxHops <= 0) return [];
  const seen = new Set<RegionId>([origin]);
  const out: Array<{ regionId: RegionId; hops: number }> = [];
  let frontier: RegionId[] = [origin];

  for (let hop = 1; hop <= maxHops; hop++) {
    const next: RegionId[] = [];
    // sorted iteration keeps traversal order canonical for deterministic replay
    for (const current of [...frontier].sort()) {
      const region = state.regions[current];
      if (!region) continue;
      for (const neighbor of [...region.neighbors].sort()) {
        if (seen.has(neighbor) || !state.regions[neighbor]) continue;
        seen.add(neighbor);
        next.push(neighbor);
        out.push({ regionId: neighbor, hops: hop });
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return out;
}

/**
 * Queue boundary signals from a resolved region into the next tick's contribution bucket.
 *
 * Propagates when the resolved pressure was `primary` OR `generated`. Inherited (`boundary`)
 * pressure never relays. Generation is carried and bounded by the caller's check.
 */
export function propagateBoundary(
  state: WorldState,
  origin: RegionId,
  domain: DomainId,
  pressure: number,
  valence: number,
  originKind: PressureOrigin,
  generation: number,
  causes: string[],
): Array<{ regionId: RegionId; hops: number; pressure: number }> {
  const cfg = state.config;
  if (!PROPAGATING_ORIGINS.includes(originKind) || cfg.boundaryMaxHops <= 0) return [];

  const emitted: Array<{ regionId: RegionId; hops: number; pressure: number }> = [];
  for (const { regionId, hops } of hopDistances(state, origin, cfg.boundaryMaxHops)) {
    const share = pressure * cfg.boundaryDecay ** hops;
    if (share < cfg.boundaryFloor) continue;
    // Relayed pressure is INHERITED at the destination: it may resolve, never re-relay.
    addPending(state, regionId, domain, share, valence, "boundary", generation, causes);
    emitted.push({ regionId, hops, pressure: share });
  }
  return emitted;
}

/**
 * Saturating pressure accumulation (anti-gaming without causal erasure).
 *
 * DISCOVERED FAILURE (self-harness/failures/2026-08-30-architecture-causal-saturation-under-cap.json):
 * a hard clamp at the magnitude of the strongest single action let that action consume the
 * entire budget, so a simultaneous independent cause contributed nothing and was erased.
 *
 * A cap must bound *spam of a repeatable action* without erasing *distinct causes*. Soft knee:
 *
 *   raw <= knee   ->  pressure = raw                       (exact, linear)
 *   raw >  knee   ->  pressure = knee + (cap - knee) * (1 - exp(-(raw - knee)/(cap - knee)))
 *
 * Properties (all regression-tested in stress.test.ts / feedback.test.ts):
 *   - strictly increasing  -> no contribution is ever causally invisible
 *   - asymptotically bounded by `cap` -> unlimited spam cannot produce unlimited pressure
 *   - applied to a LINEAR raw sum -> commutative, so same-tick order cannot matter
 *   - identity below the knee -> prior single-action calibration preserved bit-for-bit
 */
export function saturate(raw: number, knee: number, cap: number): number {
  if (raw <= knee) return raw;
  const span = cap - knee;
  if (span <= 0) return knee;
  return knee + span * (1 - Math.exp(-(raw - knee) / span));
}

/**
 * CANONICAL SUMMATION. Folds values in a fixed sorted order so the result is bit-identical
 * regardless of the order they arrived in.
 *
 * IEEE-754 addition is commutative (a+b == b+a exactly) but NOT associative, so incremental
 * accumulation in arrival order produces order-dependent bits — measured discrepancy
 * ~4e-16 on five ordinary contributions, enough to change a SHA-256 state hash. Sorting
 * before folding removes the dependence entirely.
 */
function canonicalSum(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  let total = 0;
  for (const v of sorted) total += v;
  return total;
}

/** Canonical ordering for pending items: magnitude, then valence, then generation. */
function compareItems(a: PendingItem, b: PendingItem): number {
  if (a.magnitude !== b.magnitude) return a.magnitude - b.magnitude;
  if (a.valence !== b.valence) return a.valence - b.valence;
  return a.generation - b.generation;
}

function mergeOrigin(a: PressureOrigin, b: PressureOrigin): PressureOrigin {
  if (a === "primary" || b === "primary") return "primary";
  if (a === "generated" || b === "generated") return "generated";
  return "boundary";
}

/**
 * Re-derive every scalar of a bucket from its items, in canonical order.
 *
 * Items that tie on (magnitude, valence, generation) are interchangeable here: the sums only
 * read `magnitude` and `magnitude * valence`, so any permutation of tied items folds to the
 * same bits. That is what lets cause ids live outside the bucket without weakening the
 * bit-exact commutativity guarantee.
 */
function deriveEntry(items: PendingItem[], knee: number, cap: number): PendingEntry {
  const ordered = [...items].sort(compareItems);
  const raw = canonicalSum(ordered.map((i) => i.magnitude));
  const netValence = canonicalSum(ordered.map((i) => i.magnitude * i.valence));
  const negativeRaw = canonicalSum(ordered.filter((i) => i.valence < 0).map((i) => i.magnitude));
  const positiveRaw = canonicalSum(ordered.filter((i) => i.valence > 0).map((i) => i.magnitude));

  let origin: PressureOrigin = "boundary";
  let generation = 0;
  for (const i of ordered) {
    origin = mergeOrigin(origin, i.origin);
    generation = Math.max(generation, i.generation);
  }

  return {
    pressure: saturate(raw, knee, cap),
    raw,
    netValence,
    negativeRaw,
    positiveRaw,
    origin,
    generation,
    items: ordered,
  };
}

/**
 * Add a contribution to the per-tick bucket.
 *
 * SALIENCE vs DIRECTION. `pressure` is unsigned salience and always ADDS; `valence` is the
 * signed direction and NETS. Two equal opposing causes therefore produce high salience with
 * zero net direction — a loud, contested situation — rather than silence. Summing signed
 * pressure would have cancelled both causes to nothing, reintroducing the erasure class of
 * failure fixed in §15.9. See §16.4.
 *
 * The bucket keeps its individual items and re-derives all scalars canonically, so identical
 * contribution SETS produce bit-identical buckets whatever order they arrive in (§16.5).
 * Cause ids are recorded separately in `state.pendingCauses` — trace, not state (§18.2).
 */
export function addPending(
  state: WorldState,
  regionId: RegionId,
  domain: DomainId,
  pressure: number,
  valence: number,
  origin: PressureOrigin,
  generation: number,
  causes: string[] = [],
): void {
  const cfg = state.config;
  const magnitude = Math.abs(pressure);
  const bucket = state.pendingContributions[regionId] ?? (state.pendingContributions[regionId] = {});
  const existing = bucket[domain];
  const items: PendingItem[] = existing ? [...existing.items] : [];

  // One item per (contribution, cause) so a multi-cause contribution keeps its weight split
  // exactly as before; with no causes it is a single item.
  const shares = Math.max(1, causes.length);
  for (let i = 0; i < shares; i++) {
    items.push({ magnitude: magnitude / shares, valence, origin, generation });
  }

  bucket[domain] = deriveEntry(items, cfg.pressureSoftKnee, cfg.capPerDomainRegionTick);

  // Cause ids: trace-side, canonical order, never inside the hashed bucket.
  const causeKey = `${regionId}:${domain}`;
  const merged = [...(state.pendingCauses[causeKey] ?? [])];
  for (const c of causes) if (!merged.includes(c)) merged.push(c);
  if (merged.length > 0) state.pendingCauses[causeKey] = merged.sort();
}

/** Cause ids explaining a pending bucket. */
export function pendingCausesOf(state: WorldState, regionId: RegionId, domain: DomainId): string[] {
  return state.pendingCauses[`${regionId}:${domain}`] ?? [];
}

/**
 * Try to inject NEWLY GENERATED causal pressure from a state transition.
 * Refused (with an explicit diagnostic) once the generation bound is reached.
 *
 * Returns true when the pressure was accepted.
 */
export function generatePressure(
  state: WorldState,
  regionId: RegionId,
  domain: DomainId,
  pressure: number,
  valence: number,
  parentGeneration: number,
  causes: string[],
  detail: Record<string, string | number | boolean> = {},
): boolean {
  const cfg = state.config;
  const generation = parentGeneration + 1;
  if (generation > cfg.maxCausalGeneration) {
    pushDiagnostic(state, {
      tick: state.tick,
      kind: "recurrence_cutoff",
      regionId,
      domain,
      detail: {
        ...detail,
        attemptedGeneration: generation,
        maxGeneration: cfg.maxCausalGeneration,
        refusedPressure: pressure,
        note: "computational cutoff, not convergence",
      },
    });
    return false;
  }
  addPending(state, regionId, domain, pressure, valence, "generated", generation, causes);
  return true;
}

export const DIAGNOSTIC_LIMIT = 2000;

export function pushDiagnostic(state: WorldState, d: CausalDiagnostic): void {
  state.diagnostics.push(d);
  if (state.diagnostics.length > DIAGNOSTIC_LIMIT) {
    state.diagnostics.splice(0, state.diagnostics.length - DIAGNOSTIC_LIMIT);
    state.historyTruncated = true;
  }
}

/** Canonical (region, domain) pairs with pending pressure — sorted, never map order. */
export function pendingKeys(state: WorldState): Array<{ regionId: RegionId; domain: DomainId }> {
  const out: Array<{ regionId: RegionId; domain: DomainId }> = [];
  for (const regionId of Object.keys(state.pendingContributions).sort()) {
    const buckets = state.pendingContributions[regionId];
    if (!buckets) continue;
    for (const domain of DOMAIN_ORDER) {
      if (buckets[domain]) out.push({ regionId, domain });
    }
  }
  return out;
}
