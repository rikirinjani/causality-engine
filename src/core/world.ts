import { createRNG, type RNG, type RNGState } from "./rng.js";
import { createEventBus, emit, type EventBus } from "./event-bus.js";
import {
  DOMAIN_ORDER,
  type DomainId,
  type Intervention,
  type PressureOrigin,
  type WorldState,
} from "./types.js";
import { DEFAULT_CONFIG, makeConfig, type SimConfig } from "./config.js";
import { addPending, propagateBoundary, pushDiagnostic, saturate } from "./propagation.js";
import { key, logDecision, record, refsOf, setRef } from "./provenance.js";
import { createTrace, observeSignal, type ConvergenceConfig, type SignalBounds } from "./dynamics.js";
import { genesisLineage } from "./genealogy.js";
import { CURRENT_SCHEMA_VERSION } from "./migration.js";
import { enforceRetention, EVENT_RETENTION_LIMIT } from "./retention.js";
import { buildContent } from "../game/content.js";
import { ACTION_SCHEMAS } from "../game/interventions.js";
import { heartbeatEconomy, resolveEconomy } from "../game/economy.js";
import { heartbeatFactions, resolveFaction } from "../game/factions.js";
import { heartbeatPopulation } from "../game/population.js";
import { heartbeatInvestment } from "../game/investment.js";
import { resolveEcology } from "../game/ecology.js";
import { resolveCivic } from "../game/civic.js";

/** CE's bounded authoritative window. Re-exported from retention.ts as the single source. */
const EVENT_LIMIT = EVENT_RETENTION_LIMIT;

/** Engine-side, non-serializable handles: live RNG, event bus, accepted-intervention audit. */
export interface Engine {
  rng: RNG;
  bus: EventBus;
  accepted: Intervention[];
}

export function createEngine(): Engine {
  return { rng: createRNG(0), bus: createEventBus(), accepted: [] };
}

export function convergenceConfig(cfg: SimConfig): ConvergenceConfig {
  return {
    epsilon: cfg.convergenceEpsilon,
    stableSamplesRequired: cfg.convergenceStableSamples,
    alternationsRequired: cfg.oscillationAlternations,
    divergenceGrowth: cfg.divergenceGrowth,
    divergenceSamplesRequired: cfg.divergenceSamples,
    historyWindow: cfg.dynamicsHistoryWindow,
    oscillationMinAmplitude: cfg.oscillationMinAmplitude,
    boundTolerance: cfg.boundTolerance,
  };
}

/**
 * Create a world. Config is stored IN the state, so a snapshot fully describes the
 * run and the state hash covers tuning (closing a documented Kronos Engine gap).
 *
 * Overrides are ALWAYS merged onto the defaults. Never branch on which fields are
 * present: a partial config that happens to look complete must not silently leave the
 * remaining parameters undefined.
 */
export function createWorld(overrides: Partial<SimConfig>, engine: Engine, label = "genesis"): WorldState {
  const cfg = makeConfig(overrides);
  engine.rng = createRNG(cfg.seed);
  engine.bus = createEventBus();
  engine.accepted = [];
  const content = buildContent(cfg);
  return {
    tick: 0,
    rngState: engine.rng.state(),
    lineage: genesisLineage(cfg.seed, label),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    config: cfg,
    regions: content.regions,
    entities: content.entities,
    relations: content.relations,
    events: [],
    eventSeq: 0,
    highestEmittedSeq: 0,
    // Nothing retained yet, and nothing emitted: the boundary sits one past the end, so
    // `classifyCursor` reports CAUGHT_UP rather than a spurious gap on a fresh world.
    oldestRetainedSeq: 1,
    evictedCount: 0,
    interventionSeq: 0,
    tradeVolume: 0,
    pendingContributions: {},
    pendingCauses: {},
    provenance: [],
    provenanceRefs: {},
    provenanceSeq: 0,
    resolutionLog: [],
    ledgerCauses: {},
    dynamics: {},
    diagnostics: [],
    interventionHistory: [],
    historyTruncated: false,
  };
}

/**
 * Adapter boundary: accept a validated intervention.
 *
 * SAME-TICK ORDERING (§15.3). Interventions are applied in **submission order**, made
 * explicit and reproducible by `provenance.sequence`, a monotonic counter in world state.
 * Ordering never depends on JavaScript object/Map iteration order; every downstream traversal
 * is explicitly sorted. Submission order is *semantic* (destroying a granary before vs after
 * a bridge genuinely differs), so `submitBatch` exists for callers that want a canonical,
 * arrival-independent order.
 */
export function submitIntervention(
  state: WorldState,
  intervention: Intervention,
  engine: Engine,
): { ok: boolean; errors: string[] } {
  const schema = ACTION_SCHEMAS[intervention.action];
  if (!schema) return { ok: false, errors: [`unknown action: ${intervention.action}`] };
  if (!schema.allowedTargets.includes(intervention.target.type)) {
    return { ok: false, errors: [`target type ${intervention.target.type} not allowed for ${intervention.action}`] };
  }

  // Contributions computed BEFORE immediate effects so schemas can inspect the
  // target (e.g. kill_entity needs the victim's role before removal).
  const contributions = schema.causalContributions(state, intervention);

  // Provisional provenance node; rolled back if validation fails.
  const seq = state.interventionSeq + 1;
  const causeNode = record(state, {
    tick: state.tick,
    kind: "intervention",
    label: intervention.action,
    regionId: intervention.location,
    detail: {
      interventionId: intervention.id,
      action: intervention.action,
      targetId: intervention.target.id,
      targetType: intervention.target.type,
      location: intervention.location,
      actor: intervention.actor,
      sequence: seq,
      generation: 0,
    },
    parents: [],
  });

  const immediate = schema.immediateEffects(state, intervention, causeNode);
  if (!immediate.ok) {
    const idx = state.provenance.findIndex((n) => n.id === causeNode);
    if (idx >= 0) state.provenance.splice(idx, 1);
    state.provenanceSeq -= 1;
    return { ok: false, errors: immediate.errors };
  }

  state.interventionSeq = seq;
  intervention.tick = state.tick;
  intervention.provenance.submittedAtTick = state.tick;
  intervention.provenance.sequence = seq;
  intervention.causalDomains = contributions.map((c) => c.contribution);

  // Deterministic contribution application: sort by (region, domain).
  const sorted = [...contributions].sort(
    (a, b) =>
      (a.regionId < b.regionId ? -1 : a.regionId > b.regionId ? 1 : 0) ||
      DOMAIN_ORDER.indexOf(a.contribution.domain) - DOMAIN_ORDER.indexOf(b.contribution.domain),
  );
  for (const { regionId, contribution } of sorted) {
    const pressureNode = record(state, {
      tick: state.tick,
      kind: "pressure",
      label: `${contribution.domain}_pressure`,
      regionId,
      domain: contribution.domain,
      value: contribution.pressure,
      detail: {
        scope: contribution.scope,
        interventionId: intervention.id,
        valence: contribution.valence,
        origin: "primary",
        generation: 0,
      },
      parents: [causeNode],
    });
    addPending(state, regionId, contribution.domain, contribution.pressure, contribution.valence, "primary", 0, [
      pressureNode,
    ]);
  }

  // Intervention history lives in WORLD state (part of traceHash), so a restored world
  // remembers what was done to it. `engine.accepted` remains as a per-session convenience.
  state.interventionHistory.push(structuredClone(intervention));
  engine.accepted.push(intervention);
  return { ok: true, errors: [] };
}

/**
 * Submit several interventions with a CANONICAL order independent of arrival order:
 * sorted by intervention id. Use when a batch should be order-insensitive by contract
 * (e.g. several players acting in the same network frame).
 */
export function submitBatch(
  state: WorldState,
  interventions: Intervention[],
  engine: Engine,
): Array<{ id: string; ok: boolean; errors: string[] }> {
  const canonical = [...interventions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return canonical.map((i) => ({ id: i.id, ...submitIntervention(state, i, engine) }));
}

/**
 * Signals whose trajectories are classified for convergence each tick.
 *
 * `bounds` are declared ONLY for signals whose clamps can genuinely MASK ongoing dynamics.
 * A signal pinned against such a clamp reports `converged_at_bound`, never `converged`:
 * grain price jammed at the ceiling while the town is starving is not the same statement as
 * price settling, and reporting them identically is exactly the plausible-looking answer the
 * brief forbids.
 *
 * Deliberately UNBOUNDED here:
 *   - `ledger:economy` — zero is a drained ledger, i.e. the correct rest state, not a clamp
 *     concealing pressure.
 *   - `MG:hostility` — the floor is the designed resting level that decay converges to.
 * Flagging those would manufacture anomalies for a healthy world, which is its own kind of
 * dishonest reporting.
 */
function trackedSignals(state: WorldState): Array<{ name: string; value: number; bounds?: SignalBounds }> {
  const cfg = state.config;
  const grainBase = 10;
  const out: Array<{ name: string; value: number; bounds?: SignalBounds }> = [];
  for (const regionId of Object.keys(state.regions).sort()) {
    const region = state.regions[regionId];
    if (!region) continue;
    out.push({
      name: `${regionId}:price:grain`,
      value: region.prices["grain"] ?? 0,
      bounds: { min: grainBase * cfg.priceClampMin, max: grainBase * cfg.priceClampMax },
    });
    out.push({
      name: `${regionId}:stock:grain`,
      value: region.stocks["grain"] ?? 0,
      bounds: { min: 0, max: cfg.storageCap },
    });
    out.push({
      name: `${regionId}:tradeInvestment`,
      value: region.tradeInvestment,
      bounds: { min: cfg.investmentMin, max: cfg.investmentMax },
    });
    out.push({ name: `${regionId}:ledger:economy`, value: region.ledger.economy ?? 0 });
  }
  out.push({ name: "MG:hostility", value: state.relations["MG>player"] ?? 0 });
  return out;
}

/**
 * One world tick. Phases in EXACT order (deterministic; no wall-clock, no Math.random;
 * RNG consumed only in the population phase):
 *
 *   0  merge pending contributions into region ledgers (origin, generation, valence, causes)
 *   1  economy heartbeat    (production / consumption / warehouse / trade / prices)
 *   2  investment heartbeat (profitability -> investment; CLOSES the feedback loop)
 *   3  factions heartbeat   (incomes / hostility decay / unrest decay / patrol demand)
 *   4  population heartbeat (agents — THE only RNG consumer)
 *   5  quota resolution     (per region sorted, per domain in fixed order) + boundary signals
 *   6  ledger decay         (unresolved entries scaled down)
 *   7  dynamics             (classify tracked signal trajectories; emit diagnostics)
 *   8  event delivery       (drain bus into the outbound stream)
 *
 * Resolution runs AFTER the heartbeats by design: its effects land in the NEXT tick's
 * heartbeat. That one-tick lag is what makes a tick a pure function of the state at its
 * start — the property that lets a region be replayed, snapshotted, or later moved to
 * another process. It is ALSO what makes the feedback loop a discrete recurrence rather than
 * an inner fixed-point solve, so oscillation and divergence stay observable instead of being
 * hidden inside a solver (§16.2).
 */
export function tick(state: WorldState, engine: Engine): void {
  const cfg = state.config;
  state.tick += 1;
  // Event ordinals are PER TICK: an event's identity is (timeline, tick, ordinal, content), so
  // the counter must restart each tick or identity would depend on total history length and a
  // compacted world would mint different ids for the same facts.
  state.eventSeq = 0;

  // ---- phase 0: merge pending contributions into region ledgers ----
  for (const regionId of Object.keys(state.pendingContributions).sort()) {
    const buckets = state.pendingContributions[regionId];
    const region = state.regions[regionId];
    if (!region || !buckets) continue;
    for (const domain of DOMAIN_ORDER) {
      const entry = buckets[domain];
      if (!entry) continue;
      // Saturating merge, for the same reason as addPending: a hard clamp would let a
      // large existing ledger entry make a new distinct contribution causally invisible.
      region.ledger[domain] = saturate(
        (region.ledger[domain] ?? 0) + entry.pressure,
        cfg.pressureSoftKnee,
        cfg.capLedgerEntry,
      );
      region.ledgerValence[domain] = (region.ledgerValence[domain] ?? 0) + entry.netValence;
      region.ledgerNegative[domain] = (region.ledgerNegative[domain] ?? 0) + entry.negativeRaw;
      region.ledgerPositive[domain] = (region.ledgerPositive[domain] ?? 0) + entry.positiveRaw;

      // Strongest origin claim wins: primary > generated > boundary.
      const prev = region.ledgerOrigin[domain];
      region.ledgerOrigin[domain] =
        prev === "primary" || entry.origin === "primary"
          ? "primary"
          : prev === "generated" || entry.origin === "generated"
            ? "generated"
            : "boundary";
      region.ledgerGeneration[domain] = Math.max(region.ledgerGeneration[domain] ?? 0, entry.generation);

      // accumulate causes as MULTIPLE parents — never collapse contributing interventions.
      // Causes come from the trace-side pendingCauses map, not from the hashed bucket.
      const causeKey = `${regionId}:${domain}`;
      const existing = state.ledgerCauses[causeKey] ?? [];
      const merged = [...existing];
      for (const c of state.pendingCauses[causeKey] ?? []) if (!merged.includes(c)) merged.push(c);
      state.ledgerCauses[causeKey] = merged;
    }
  }
  state.pendingContributions = {};
  state.pendingCauses = {};

  // ---- phases 1-4: heartbeats ----
  heartbeatEconomy(state);
  heartbeatInvestment(state);
  heartbeatFactions(state);
  heartbeatPopulation(state, engine.rng);

  // ---- phase 5: quota resolution (+ cross-region boundary signals) ----
  const resolved = new Set<string>();
  for (const regionId of Object.keys(state.regions).sort()) {
    const region = state.regions[regionId];
    if (!region) continue;
    for (const domain of DOMAIN_ORDER) {
      const pressure = region.ledger[domain];
      if (pressure === undefined) continue;

      const threshold = cfg.thresholds[domain];
      const fired = pressure >= threshold;
      const origin: PressureOrigin = region.ledgerOrigin[domain] ?? "primary";
      const generation = region.ledgerGeneration[domain] ?? 0;
      const netValence = region.ledgerValence[domain] ?? 0;
      const neg = region.ledgerNegative[domain] ?? 0;
      const pos = region.ledgerPositive[domain] ?? 0;

      // CONTESTED: opposing causes of comparable weight. Never silently averaged away —
      // the resolution still happens (direction = net), but the contest is recorded.
      const contested =
        neg > 0 && pos > 0 && Math.min(neg, pos) / Math.max(neg, pos) >= cfg.contestRatio;

      logDecision(state, {
        tick: state.tick,
        regionId,
        domain,
        pressure,
        threshold,
        fired,
        origin,
        generation,
        netValence,
        contested,
      });

      if (!fired) continue;

      if (contested) {
        pushDiagnostic(state, {
          tick: state.tick,
          kind: "contested_resolution",
          regionId,
          domain,
          detail: {
            negativePressure: neg,
            positivePressure: pos,
            netValence,
            note: "opposing causes of comparable weight; net direction applied, contest recorded",
          },
        });
      }

      const causeKey = `${regionId}:${domain}`;
      const causes = state.ledgerCauses[causeKey] ?? [];
      // Direction actually applied: sign of the net valence, magnitude from salience.
      const direction = netValence === 0 ? 0 : Math.sign(netValence);
      const signedPressure = pressure * direction;

      switch (domain) {
        case "civic":
          resolveCivic(state, regionId, signedPressure, engine.bus, causes);
          break;
        case "ecology":
          resolveEcology(state, regionId, signedPressure, engine.bus, causes);
          break;
        case "economy":
          resolveEconomy(state, regionId, signedPressure, engine.bus, causes);
          break;
        case "faction":
          resolveFaction(state, regionId, signedPressure, engine.bus, causes);
          break;
      }

      // Boundary signals: neighbours feel a decayed share next tick.
      // `primary` AND `generated` propagate; inherited `boundary` pressure never relays.
      for (const sig of propagateBoundary(
        state,
        regionId,
        domain,
        pressure,
        direction,
        origin,
        generation,
        causes,
      )) {
        emit(state, engine.bus, "world.boundary_signal", "propagation", sig.regionId, {
          from: regionId,
          domain,
          hops: sig.hops,
          pressure: sig.pressure,
          origin,
          generation,
        });
      }

      clearLedgerEntry(state, regionId, domain);
      resolved.add(`${regionId}:${domain}`);
    }
  }

  // ---- phase 6: decay unresolved ledger entries ----
  for (const regionId of Object.keys(state.regions).sort()) {
    const region = state.regions[regionId];
    if (!region) continue;
    for (const domain of DOMAIN_ORDER) {
      const p = region.ledger[domain];
      if (p === undefined || resolved.has(`${regionId}:${domain}`)) continue;
      const next = p * cfg.ledgerDecayPerTick;
      if (next < cfg.ledgerFloor) {
        clearLedgerEntry(state, regionId, domain);
      } else {
        region.ledger[domain] = next;
        // decay scales salience AND the signed/unsigned components together, so the
        // contest ratio is preserved as an entry ages
        region.ledgerValence[domain] = (region.ledgerValence[domain] ?? 0) * cfg.ledgerDecayPerTick;
        region.ledgerNegative[domain] = (region.ledgerNegative[domain] ?? 0) * cfg.ledgerDecayPerTick;
        region.ledgerPositive[domain] = (region.ledgerPositive[domain] ?? 0) * cfg.ledgerDecayPerTick;
      }
    }
  }

  // ---- phase 7: dynamics — classify trajectories, surface anomalies ----
  const convCfg = convergenceConfig(cfg);
  for (const { name, value, bounds } of trackedSignals(state)) {
    const trace = state.dynamics[name] ?? (state.dynamics[name] = createTrace(name));
    const before = trace.classification;
    observeSignal(trace, value, state.tick, convCfg, bounds);
    if (trace.classification === before) continue;

    if (trace.classification === "oscillating") {
      pushDiagnostic(state, {
        tick: state.tick,
        kind: "oscillation_detected",
        signal: name,
        detail: { alternations: trace.alternations, value, note: "signal alternating without settling" },
      });
    } else if (trace.classification === "diverging") {
      pushDiagnostic(state, {
        tick: state.tick,
        kind: "divergence_detected",
        signal: name,
        detail: { growth: trace.growth, value, note: "successive deltas growing" },
      });
    } else if (trace.classification === "converged_at_bound") {
      // Stable only because it is pinned against a clamp. Explicitly NOT convergence.
      pushDiagnostic(state, {
        tick: state.tick,
        kind: "convergence_not_reached",
        signal: name,
        detail: {
          value,
          divergedEver: trace.divergedEver,
          note: "signal is stable at a clamp, not by settling dynamics",
        },
      });
    }
  }

  // ---- phase 8: deliver events to the outbound record, then enforce retention ----
  for (const ev of engine.bus.collect()) state.events.push(ev);
  // Retention is enforced WITHOUT consulting any consumer: `enforceRetention` cannot see a
  // DeliveryState, which is what makes "a slow or absent consumer can neither stall the
  // simulation nor pin unbounded history" structural rather than a promise (§20.1).
  enforceRetention(state, EVENT_LIMIT);

  // mirror RNG state into the world state (serializable, snapshot-able)
  state.rngState = engine.rng.state();
}

function clearLedgerEntry(state: WorldState, regionId: string, domain: DomainId): void {
  const region = state.regions[regionId];
  if (region) {
    delete region.ledger[domain];
    delete region.ledgerOrigin[domain];
    delete region.ledgerGeneration[domain];
    delete region.ledgerValence[domain];
    delete region.ledgerNegative[domain];
    delete region.ledgerPositive[domain];
  }
  delete state.ledgerCauses[`${regionId}:${domain}`];
}

/** Advance n ticks. The adapter's `advance()` — CE never owns the frame loop. */
export function advance(state: WorldState, engine: Engine, ticks: number): number {
  for (let i = 0; i < ticks; i++) tick(state, engine);
  return state.tick;
}

/**
 * Rebind an engine to an existing world (e.g. one produced by `restoreCheckpoint`).
 *
 * This is the resume path: the live RNG is reconstructed from the persisted register, and the
 * event bus is recreated empty — correct because the bus is drained every tick, so at any
 * tick boundary it holds nothing. `accepted` is repopulated from the persisted history so a
 * resumed session sees the same intervention record.
 */
export function attachEngine(state: WorldState, engine: Engine): Engine {
  engine.rng = createRNG(state.config.seed);
  engine.rng.restore(state.rngState);
  engine.bus = createEventBus();
  engine.accepted = state.interventionHistory.map((i) => structuredClone(i));
  return engine;
}

/** Pure serializable projection of the whole world (deep clone). In-memory checkpoint. */
export function snapshot(state: WorldState): WorldState {
  return structuredClone(state);
}

/** Restore a snapshot in place, including the live RNG register. */
export function restore(state: WorldState, snap: WorldState, engine: Engine): void {
  Object.assign(state, structuredClone(snap));
  attachEngine(state, engine);
}

export { DEFAULT_CONFIG, makeConfig, key, refsOf, setRef };
export type { RNGState, SimConfig };
