import { advance, createEngine, createWorld, submitIntervention } from "../core/world.js";
import { stateHash } from "../core/hash.js";
import { DEFAULT_CONFIG, uniformThresholds, type SimConfig } from "../core/config.js";
import { ROUTE_ID } from "../game/content.js";
import type { Intervention, WorldState } from "../core/types.js";

/**
 * Threshold / decay parameter sweep.
 *
 * Rec 1 from docs/RECONNAISSANCE.md §12: the quota threshold (0.6), ledger decay
 * (0.9/tick) and boundary decay (0.35) were guesses. This sweep replaces the guess with
 * measured behaviour, running the same intervention scenario across a parameter grid.
 *
 * The grid is enumerated in fixed order and every cell builds a fresh deterministic
 * world, so the whole sweep is reproducible — same numbers, every run.
 *
 * IMPORTANT MEASUREMENT NOTE. Destroying the route has two separable effects:
 *   - the IMMEDIATE effect (route health = 0) stops trade regardless of the quota, so
 *     starvation -> price rise -> patrol demand -> guards patrolling happens in EVERY
 *     configuration, even one where the quota never fires;
 *   - the QUOTA effect is the amplification on top (price shocks, ecology production
 *     loss, faction hostility, cross-region signals).
 * `peakHostility` isolates the quota effect: the factions heartbeat only ever DECAYS
 * hostility, so any rise above the starting value is attributable to a resolution pass.
 */

export interface SweepMetrics {
  threshold: number;
  decay: number;
  boundaryDecay: number;
  /** Ticks from intervention until the first resolution fires (responsiveness). */
  latencyTicks: number | null;
  /** How many resolution passes ran (cost proxy — the quota is a budget governor). */
  resolutionPasses: number;
  /** How many cross-region boundary signals were emitted (blast radius). */
  boundarySignals: number;
  /**
   * Ticks from the intervention until every ledger is empty again — measured
   * independently of whether anything resolved, so a configuration that never crosses
   * threshold still reports how long its pressure lingers.
   */
  settleTicks: number | null;
  /** Peak grain price in the directly-hit region (total consequence magnitude). */
  peakRFPrice: number;
  /** Peak faction hostility — the CLEAN quota signal (heartbeat only decays it). */
  peakHostility: number;
  /** Did any quota resolution fire at all? */
  quotaFired: boolean;
  /** Did the unconnected third town stay economically untouched? (locality preserved) */
  psUnaffected: boolean;
  /** Did the observable NPC behaviour change fire? (chain reached the player) */
  guardsPatrolled: boolean;
  hash: string;
}

const RESOLUTION_TYPES = new Set([
  "economy.trade_disruption",
  "ecology.food_availability",
  "faction.relations_change",
]);

function destroyRoute(): Intervention {
  return {
    id: "sweep",
    tick: 0,
    actor: "player",
    action: "destroy_infrastructure",
    target: { type: "infrastructure", id: ROUTE_ID },
    location: "RF",
    intent: "sweep",
    magnitude: 1,
    causalDomains: [],
    provenance: { submittedAtTick: 0, sequence: 0 },
  };
}

function ledgersEmpty(state: WorldState): boolean {
  return Object.values(state.regions).every((r) => Object.keys(r.ledger).length === 0);
}

export function runCell(overrides: Partial<SimConfig>, horizon = 120): SweepMetrics {
  const engine = createEngine();
  const state = createWorld({ seed: DEFAULT_CONFIG.seed, ...overrides }, engine);

  advance(state, engine, 9);
  submitIntervention(state, destroyRoute(), engine);
  const interventionTick = state.tick;
  const baseHostility = state.relations["MG>player"] ?? 0;

  let latencyTicks: number | null = null;
  let resolutionPasses = 0;
  let boundarySignals = 0;
  let settleTicks: number | null = null;
  let sawPressure = false;
  let peakRFPrice = 0;
  let peakHostility = baseHostility;
  let guardsPatrolled = false;
  let psMaxDeviation = 0;

  for (let i = 0; i < horizon; i++) {
    const before = state.events.length;
    advance(state, engine, 1);

    for (const ev of state.events.slice(before)) {
      if (RESOLUTION_TYPES.has(ev.type)) {
        resolutionPasses += 1;
        if (latencyTicks === null) latencyTicks = state.tick - interventionTick;
      }
      if (ev.type === "world.boundary_signal") boundarySignals += 1;
    }

    peakRFPrice = Math.max(peakRFPrice, state.regions["RF"]?.prices["grain"] ?? 0);
    peakHostility = Math.max(peakHostility, state.relations["MG>player"] ?? 0);
    psMaxDeviation = Math.max(psMaxDeviation, Math.abs((state.regions["PS"]?.prices["grain"] ?? 10) - 10));
    if (state.entities["a13"]?.attrs.patrolling === true) guardsPatrolled = true;

    // settle = pressure arrived, then fully drained (independent of resolution)
    const empty = ledgersEmpty(state);
    if (!empty) sawPressure = true;
    if (settleTicks === null && sawPressure && empty) settleTicks = state.tick - interventionTick;
  }

  const cfg = state.config;
  return {
    threshold: cfg.thresholds.economy,
    decay: cfg.ledgerDecayPerTick,
    boundaryDecay: cfg.boundaryDecay,
    latencyTicks,
    resolutionPasses,
    boundarySignals,
    settleTicks,
    peakRFPrice,
    peakHostility,
    quotaFired: resolutionPasses > 0,
    psUnaffected: psMaxDeviation < 0.01,
    guardsPatrolled,
    hash: stateHash(state),
  };
}

const THRESHOLDS = [0.3, 0.6, 0.9, 1.2];
const DECAYS = [0.7, 0.8, 0.9, 0.95];
const BOUNDARY_DECAYS = [0.2, 0.35, 0.5];

const BASE_THRESHOLD = 0.6;
const BASE_DECAY = 0.9;
const BASE_BOUNDARY = 0.35;

export function runSweep(): SweepMetrics[] {
  const out: SweepMetrics[] = [];
  for (const threshold of THRESHOLDS) {
    for (const decay of DECAYS) {
      for (const boundaryDecay of BOUNDARY_DECAYS) {
        out.push(
          runCell({
            thresholds: uniformThresholds(threshold),
            ledgerDecayPerTick: decay,
            boundaryDecay,
          }),
        );
      }
    }
  }
  return out;
}

function fmt(n: number | null, digits = 2): string {
  return n === null ? "  -  " : n.toFixed(digits);
}

function yn(b: boolean): string {
  return b ? "yes" : "NO";
}

export function main(): void {
  const results = runSweep();

  console.log("=== Causality Engine — quota parameter sweep ===");
  console.log("scenario: destroy grain_road at tick 10, horizon 120 ticks, seed 42");
  console.log(
    `grid: ${THRESHOLDS.length} thresholds x ${DECAYS.length} decays x ${BOUNDARY_DECAYS.length} boundary decays = ${results.length} runs\n`,
  );

  console.log("thresh | decay | bDecay | latency | passes | signals | settle | peak RF | peak host | quota | PS ok | guards");
  console.log("-".repeat(108));
  for (const r of results) {
    console.log(
      `${fmt(r.threshold).padStart(6)} | ${fmt(r.decay).padStart(5)} | ${fmt(r.boundaryDecay).padStart(6)} | ` +
        `${fmt(r.latencyTicks, 0).padStart(7)} | ${String(r.resolutionPasses).padStart(6)} | ${String(r.boundarySignals).padStart(7)} | ` +
        `${fmt(r.settleTicks, 0).padStart(6)} | ${fmt(r.peakRFPrice).padStart(7)} | ${fmt(r.peakHostility).padStart(9)} | ` +
        `${yn(r.quotaFired).padStart(5)} | ${yn(r.psUnaffected).padStart(5)} | ${yn(r.guardsPatrolled)}`,
    );
  }

  // --- one-factor-at-a-time analysis (hold the other two at their defaults) --
  console.log("\n--- threshold sensitivity (decay 0.90, bDecay 0.35) ---");
  for (const threshold of THRESHOLDS) {
    const r = results.find((x) => x.threshold === threshold && x.decay === BASE_DECAY && x.boundaryDecay === BASE_BOUNDARY);
    if (!r) continue;
    console.log(
      `  threshold ${fmt(threshold)}: passes ${String(r.resolutionPasses).padStart(2)}, signals ${String(r.boundarySignals).padStart(2)}, ` +
        `settle ${fmt(r.settleTicks, 0)}, peak host ${fmt(r.peakHostility)}, quota ${yn(r.quotaFired)}, locality ${yn(r.psUnaffected)}`,
    );
  }

  console.log("\n--- decay sensitivity (threshold 0.60, bDecay 0.35) ---");
  for (const decay of DECAYS) {
    const r = results.find((x) => x.decay === decay && x.threshold === BASE_THRESHOLD && x.boundaryDecay === BASE_BOUNDARY);
    if (!r) continue;
    console.log(
      `  decay ${fmt(decay)}: passes ${String(r.resolutionPasses).padStart(2)}, settle ${fmt(r.settleTicks, 0).padStart(5)} ticks, peak host ${fmt(r.peakHostility)}`,
    );
  }

  console.log("\n--- boundary decay sensitivity (threshold 0.60, decay 0.90) ---");
  for (const boundaryDecay of BOUNDARY_DECAYS) {
    const r = results.find((x) => x.boundaryDecay === boundaryDecay && x.threshold === BASE_THRESHOLD && x.decay === BASE_DECAY);
    if (!r) continue;
    console.log(
      `  bDecay ${fmt(boundaryDecay)}: signals ${String(r.boundarySignals).padStart(2)}, passes ${String(r.resolutionPasses).padStart(2)}, locality ${yn(r.psUnaffected)}`,
    );
  }

  // --- findings --------------------------------------------------------------
  const quotaFired = results.filter((r) => r.quotaFired);
  const localityHeld = results.filter((r) => r.psUnaffected);
  const neverSettled = results.filter((r) => r.settleTicks === null);
  const immediateChain = results.filter((r) => r.guardsPatrolled);

  console.log("\n--- findings ---");
  console.log(`quota fired at all:              ${quotaFired.length}/${results.length}`);
  console.log(`locality preserved:              ${localityHeld.length}/${results.length}`);
  console.log(`pressure never fully drained:    ${neverSettled.length}/${results.length}`);
  console.log(`immediate-effect chain reached the player (guards patrolling): ${immediateChain.length}/${results.length}`);
  console.log("  ^ the immediate route effect drives that chain even when the quota never fires;");
  console.log("    the quota supplies amplification (see peak hostility), not the base consequence.");

  const localityBroken = results.filter((r) => !r.psUnaffected);
  if (localityBroken.length > 0) {
    const maxBrokenThreshold = Math.max(...localityBroken.map((r) => r.threshold));
    console.log(
      `\nlocality breaks at threshold <= ${fmt(maxBrokenThreshold)}: boundary pressure from the neighbouring region\n` +
        `  crosses the (low) threshold in the unconnected town, so consequences leak where they should not.`,
    );
  }

  const viable = results.filter((r) => r.quotaFired && r.psUnaffected && r.settleTicks !== null);
  console.log(`\nviable configurations (quota fires + locality holds + pressure drains): ${viable.length}/${results.length}`);
  if (viable.length > 0) {
    const cheapest = [...viable].sort(
      (a, b) => a.resolutionPasses - b.resolutionPasses || (a.settleTicks ?? 0) - (b.settleTicks ?? 0),
    )[0]!;
    const liveliest = [...viable].sort(
      (a, b) => b.peakHostility - a.peakHostility || a.resolutionPasses - b.resolutionPasses,
    )[0]!;
    console.log(
      `  cheapest viable:  threshold ${fmt(cheapest.threshold)}, decay ${fmt(cheapest.decay)}, bDecay ${fmt(cheapest.boundaryDecay)} ` +
        `-> ${cheapest.resolutionPasses} passes, settle ${fmt(cheapest.settleTicks, 0)}`,
    );
    console.log(
      `  strongest signal: threshold ${fmt(liveliest.threshold)}, decay ${fmt(liveliest.decay)}, bDecay ${fmt(liveliest.boundaryDecay)} ` +
        `-> peak hostility ${fmt(liveliest.peakHostility)}, ${liveliest.resolutionPasses} passes`,
    );
  }

  const defaults = results.find(
    (r) => r.threshold === BASE_THRESHOLD && r.decay === BASE_DECAY && r.boundaryDecay === BASE_BOUNDARY,
  );
  if (defaults) {
    console.log("\ncurrent defaults (0.60 / 0.90 / 0.35):");
    console.log(
      `  latency ${fmt(defaults.latencyTicks, 0)} tick, ${defaults.resolutionPasses} passes, ${defaults.boundarySignals} signals, ` +
        `settle ${fmt(defaults.settleTicks, 0)} ticks, peak RF price ${fmt(defaults.peakRFPrice)}, peak hostility ${fmt(defaults.peakHostility)}`,
    );
    console.log(`  quota fired: ${yn(defaults.quotaFired)}, locality: ${yn(defaults.psUnaffected)}`);
  }

  console.log("\n--- determinism check ---");
  console.log("same-config reruns identical:", runCell({}).hash === runCell({}).hash);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("poc/sweep.ts")) {
  main();
}
