/**
 * P-010: CE Runtime & Hardware Feasibility Benchmark
 *
 * Measures tick latency, memory, events, provenance, and scaling characteristics.
 * Run with: npx tsx src/poc/benchmark.ts
 *
 * DO NOT modify CE core. This is a measurement tool only.
 */
import { performance } from "node:perf_hooks";
import {
  createEngine, createWorld, submitIntervention, advance, makeConfig,
  snapshot, attachEngine,
  stateHash, traceHash,
  factStream, stream,
  createCheckpoint, serializeCheckpoint, deserializeCheckpoint,
  validateCheckpoint, restoreCheckpoint,
  forkTimeline, rewindTo,
  enforceRetention, EVENT_RETENTION_LIMIT,
  type Engine, type WorldState, type Intervention,
} from "../api/public.js";

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

interface BenchResult {
  name: string;
  iterations: number;
  times: number[];       // per-iteration durations in ms
  median: number;
  mean: number;
  p95: number;
  p99: number;
  max: number;
  min: number;
  ticksPerSec: number;
  memBeforeMB: number;
  memAfterMB: number;
  memDeltaMB: number;
  stateHashMatch: boolean;
  traceHashMatch: boolean;
  eventsGenerated: number;
  provenanceNodes: number;
  resolutionDecisions: number;
  diagnosticsCount: number;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function memMB(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

function makeIntervention(overrides: Partial<Intervention> = {}): Intervention {
  return {
    id: `bench-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    tick: 0,
    actor: "player",
    action: "destroy_infrastructure",
    target: { type: "infrastructure", id: "grain_road" },
    location: "RF",
    magnitude: 0.8,
    causalDomains: [{ domain: "economy", pressure: 0.8, valence: 1, scope: "regional" }],
    provenance: { submittedAtTick: 0, sequence: 0 },
    ...overrides,
  };
}

function measureBench(
  name: string,
  setup: () => { world: WorldState; engine: Engine },
  run: (world: WorldState, engine: Engine) => void,
  iterations: number,
  ticksPerIteration: number,
): BenchResult {
  const times: number[] = [];
  let memBefore = 0, memAfter = 0;
  let hash1 = "", hash2 = "", trace1 = "", trace2 = "";
  let events = 0, provenance = 0, resolutions = 0, diagnostics = 0;

  // Warmup
  for (let i = 0; i < Math.min(3, iterations); i++) {
    const { world, engine } = setup();
    run(world, engine);
  }

  // Force GC if available
  if (global.gc) global.gc();
  memBefore = memMB();

  for (let i = 0; i < iterations; i++) {
    const { world, engine } = setup();
    const t0 = performance.now();
    run(world, engine);
    const t1 = performance.now();
    times.push(t1 - t0);

    if (i === 0) {
      hash1 = stateHash(world);
      trace1 = traceHash(world);
      events = factStream(world).length;
      provenance = world.provenance.length;
      resolutions = world.resolutionLog.length;
      diagnostics = world.diagnostics.length;
    }
    if (i === iterations - 1) {
      hash2 = stateHash(world);
      trace2 = traceHash(world);
    }
  }

  memAfter = memMB();
  times.sort((a, b) => a - b);

  return {
    name,
    iterations,
    times,
    median: percentile(times, 50),
    mean: times.reduce((a, b) => a + b, 0) / times.length,
    p95: percentile(times, 95),
    p99: percentile(times, 99),
    max: times[times.length - 1],
    min: times[0],
    ticksPerSec: ticksPerIteration / (percentile(times, 50) / 1000),
    memBeforeMB: Math.round(memBefore * 100) / 100,
    memAfterMB: Math.round(memAfter * 100) / 100,
    memDeltaMB: Math.round((memAfter - memBefore) * 100) / 100,
    stateHashMatch: hash1 === hash2,
    traceHashMatch: trace1 === trace2,
    eventsGenerated: events,
    provenanceNodes: provenance,
    resolutionDecisions: resolutions,
    diagnosticsCount: diagnostics,
  };
}

function printResult(r: BenchResult): void {
  const fmt = (n: number) => n.toFixed(2);
  console.log(`  ${r.name}`);
  console.log(`    iterations: ${r.iterations}`);
  console.log(`    tick time:  median=${fmt(r.median)}ms  mean=${fmt(r.mean)}ms  p95=${fmt(r.p95)}ms  p99=${fmt(r.p99)}ms  max=${fmt(r.max)}ms  min=${fmt(r.min)}ms`);
  console.log(`    ticks/sec: ${fmt(r.ticksPerSec)}`);
  console.log(`    memory:    before=${fmt(r.memBeforeMB)}MB  after=${fmt(r.memAfterMB)}MB  delta=${fmt(r.memDeltaMB)}MB`);
  console.log(`    deterministic: stateHash=${r.stateHashMatch}  traceHash=${r.traceHashMatch}`);
  console.log(`    events=${r.eventsGenerated}  provenance=${r.provenanceNodes}  resolutions=${r.resolutionDecisions}  diagnostics=${r.diagnosticsCount}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCALING: Build worlds with N towns
// ═══════════════════════════════════════════════════════════════════════════════

function buildScaledWorld(numTowns: number, seed = 42): { world: WorldState; engine: Engine } {
  const engine = createEngine();
  const world = createWorld(makeConfig({ seed }), engine);

  // Add more towns beyond the default 3
  const regionIds = ["RF", "HT", "PS"];
  const townNames = ["Riverford", "Hilltown", "Portside"];

  // Generate additional town IDs
  for (let i = 3; i < numTowns; i++) {
    const id = `T${i}`;
    regionIds.push(id);
    townNames.push(`Town${i}`);
  }

  // Build neighbor graph: linear chain
  for (let i = 0; i < numTowns; i++) {
    const neighbors: string[] = [];
    if (i > 0) neighbors.push(regionIds[i - 1]);
    if (i < numTowns - 1) neighbors.push(regionIds[i + 1]);
    const regionId = regionIds[i];

    if (!world.regions[regionId]) {
      const stocks: Record<string, number> = {};
      const prices: Record<string, number> = {};
      for (const res of ["grain", "iron", "cloth", "timber", "herbs"]) {
        stocks[res] = world.config.targetStock;
        prices[res] = 10;
      }
      world.regions[regionId] = {
        id: regionId,
        name: townNames[i],
        neighbors,
        stocks,
        prices,
        priceShock: {},
        infrastructure: {},
        population: [],
        ledger: {},
        ledgerOrigin: {},
        ledgerValence: {},
        ledgerNegative: {},
        ledgerPositive: {},
        ledgerGeneration: {},
        patrolDemand: 0,
        unrest: 0,
        tradeInvestment: world.config.investmentMax,
        merchantProfitability: 0,
        tradeCapacityFactor: 1,
      };
    }
  }

  // Add entities to new towns
  let entityIdx = 20;
  for (let i = 3; i < numTowns; i++) {
    const regionId = regionIds[i];
    const region = world.regions[regionId];
    if (!region) continue;

    // Add 1 farmer + 1 merchant per town
    for (const role of ["farmer", "merchant"]) {
      const eid = `e${entityIdx++}`;
      world.entities[eid] = {
        id: eid,
        type: "agent",
        role,
        attrs: { role, workJitter: 0 },
        location: regionId,
      };
      region.population.push(eid);
    }
  }

  return { world, engine };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN BENCHMARK SUITE
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  CE Runtime & Hardware Feasibility Benchmark (P-010)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const ITERATIONS = 20;
  const results: BenchResult[] = [];

  // ─── BASELINE ───────────────────────────────────────────────────────────
  console.log("── BASELINE: World initialization ──");
  {
    const times: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      const engine = createEngine();
      const world = createWorld(makeConfig({ seed: 42 }), engine);
      const t1 = performance.now();
      times.push(t1 - t0);
    }
    times.sort((a, b) => a - b);
    console.log(`  init: median=${percentile(times, 50).toFixed(2)}ms  p95=${percentile(times, 95).toFixed(2)}ms  p99=${percentile(times, 99).toFixed(2)}ms`);
  }

  // ─── SINGLE TICK ────────────────────────────────────────────────────────
  console.log("\n── SINGLE TICK (3 towns, 20 entities) ──");
  results.push(measureBench(
    "single_tick_3town",
    () => {
      const engine = createEngine();
      const world = createWorld(makeConfig({ seed: 42 }), engine);
      return { world, engine };
    },
    (world, engine) => {
      // Submit one intervention to have something to resolve
      submitIntervention(world, makeIntervention(), engine);
      advance(world, engine, 1);
    },
    ITERATIONS,
    1,
  ));
  printResult(results[results.length - 1]);

  // ─── 100 TICKS ──────────────────────────────────────────────────────────
  console.log("\n── 100 TICKS (3 towns, 20 entities) ──");
  results.push(measureBench(
    "100_ticks_3town",
    () => {
      const engine = createEngine();
      const world = createWorld(makeConfig({ seed: 42 }), engine);
      submitIntervention(world, makeIntervention(), engine);
      return { world, engine };
    },
    (world, engine) => {
      advance(world, engine, 100);
    },
    ITERATIONS,
    100,
  ));
  printResult(results[results.length - 1]);

  // ─── 1,000 TICKS ────────────────────────────────────────────────────────
  console.log("\n── 1,000 TICKS (3 towns, 20 entities) ──");
  results.push(measureBench(
    "1000_ticks_3town",
    () => {
      const engine = createEngine();
      const world = createWorld(makeConfig({ seed: 42 }), engine);
      submitIntervention(world, makeIntervention(), engine);
      return { world, engine };
    },
    (world, engine) => {
      advance(world, engine, 1000);
    },
    ITERATIONS,
    1000,
  ));
  printResult(results[results.length - 1]);

  // ─── 10,000 TICKS ───────────────────────────────────────────────────────
  console.log("\n── 10,000 TICKS (3 towns, 20 entities) ──");
  results.push(measureBench(
    "10000_ticks_3town",
    () => {
      const engine = createEngine();
      const world = createWorld(makeConfig({ seed: 42 }), engine);
      submitIntervention(world, makeIntervention(), engine);
      return { world, engine };
    },
    (world, engine) => {
      advance(world, engine, 10000);
    },
    Math.max(5, Math.floor(ITERATIONS / 2)),
    10000,
  ));
  printResult(results[results.length - 1]);

  // ─── ACTIVE WORLD: Bridge Destruction ───────────────────────────────────
  console.log("\n── ACTIVE WORLD: Bridge Destruction (3 towns) ──");
  results.push(measureBench(
    "bridge_destruction",
    () => {
      const engine = createEngine();
      const world = createWorld(makeConfig({ seed: 42 }), engine);
      return { world, engine };
    },
    (world, engine) => {
      submitIntervention(world, makeIntervention({ id: "destroy-bridge" }), engine);
      advance(world, engine, 100);
    },
    ITERATIONS,
    100,
  ));
  printResult(results[results.length - 1]);

  // ─── ACTIVE WORLD: Multiple Simultaneous Interventions ──────────────────
  console.log("\n── ACTIVE WORLD: 5 Simultaneous Interventions ──");
  results.push(measureBench(
    "5_interventions",
    () => {
      const engine = createEngine();
      const world = createWorld(makeConfig({ seed: 42 }), engine);
      return { world, engine };
    },
    (world, engine) => {
      submitIntervention(world, makeIntervention({ id: "destroy-bridge" }), engine);
      submitIntervention(world, makeIntervention({ id: "destroy-warehouse", target: { type: "infrastructure", id: "grain_warehouse" } }), engine);
      submitIntervention(world, makeIntervention({ id: "rally", action: "hold_public_rally", target: { type: "region", id: "RF" } }), engine);
      submitIntervention(world, makeIntervention({ id: "subsidy", action: "grant_merchant_subsidy", target: { type: "region", id: "HT" } }), engine);
      submitIntervention(world, makeIntervention({ id: "patrol", action: "increase_patrols", target: { type: "region", id: "PS" } }), engine);
      advance(world, engine, 100);
    },
    ITERATIONS,
    100,
  ));
  printResult(results[results.length - 1]);

  // ─── SUSTAINED FEEDBACK ─────────────────────────────────────────────────
  console.log("\n── SUSTAINED FEEDBACK: 500 ticks with periodic interventions ──");
  results.push(measureBench(
    "sustained_feedback",
    () => {
      const engine = createEngine();
      const world = createWorld(makeConfig({ seed: 42 }), engine);
      return { world, engine };
    },
    (world, engine) => {
      // Destroy bridge, then let feedback loop run
      submitIntervention(world, makeIntervention({ id: "destroy-bridge" }), engine);
      advance(world, engine, 50);
      // Subsidy to counter
      submitIntervention(world, makeIntervention({ id: "subsidy", action: "grant_merchant_subsidy", target: { type: "region", id: "RF" } }), engine);
      advance(world, engine, 50);
      // Another disruption
      submitIntervention(world, makeIntervention({ id: "destroy-warehouse", target: { type: "infrastructure", id: "grain_warehouse" } }), engine);
      advance(world, engine, 200);
      // Rally
      submitIntervention(world, makeIntervention({ id: "rally", action: "hold_public_rally", target: { type: "region", id: "HT" } }), engine);
      advance(world, engine, 200);
    },
    ITERATIONS,
    500,
  ));
  printResult(results[results.length - 1]);

  // ─── SCALING ────────────────────────────────────────────────────────────
  console.log("\n── SCALING: Tick latency vs world size ──");
  for (const numTowns of [3, 10, 25, 50, 100]) {
    const name = `scaling_${numTowns}_towns`;
    const numEntities = numTowns * 2; // ~2 entities per town
    results.push(measureBench(
      name,
      () => {
        return buildScaledWorld(numTowns, 42);
      },
      (world, engine) => {
        // Submit intervention to first town
        const regionIds = Object.keys(world.regions);
        submitIntervention(world, makeIntervention({ id: `destroy-${regionIds[0]}`, location: regionIds[0] }), engine);
        advance(world, engine, 100);
      },
      numTowns <= 25 ? ITERATIONS : Math.max(5, Math.floor(ITERATIONS / 2)),
      100,
    ));
    printResult(results[results.length - 1]);
  }

  // ─── BURST ──────────────────────────────────────────────────────────────
  console.log("\n── BURST: Interventions per tick ──");
  for (const burstSize of [1, 10, 50, 100]) {
    const name = `burst_${burstSize}`;
    results.push(measureBench(
      name,
      () => {
        const engine = createEngine();
        const world = createWorld(makeConfig({ seed: 42 }), engine);
        return { world, engine };
      },
      (world, engine) => {
        // Submit burst of interventions in same tick
        for (let i = 0; i < burstSize; i++) {
          submitIntervention(world, makeIntervention({
            id: `burst-${i}`,
            location: ["RF", "HT", "PS"][i % 3],
          }), engine);
        }
        advance(world, engine, 100);
      },
      ITERATIONS,
      100,
    ));
    printResult(results[results.length - 1]);
  }

  // ─── PERSISTENCE ────────────────────────────────────────────────────────
  console.log("\n── PERSISTENCE: Checkpoint / Serialize / Restore ──");
  {
    const engine = createEngine();
    const world = createWorld(makeConfig({ seed: 42 }), engine);
    submitIntervention(world, makeIntervention({ id: "persist-test" }), engine);
    advance(world, engine, 100);

    const hashes = { state: stateHash(world), trace: traceHash(world) };

    // Checkpoint creation
    const times: number[] = [];
    let serializedSize = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      const cp = createCheckpoint(world, "bench");
      const serialized = serializeCheckpoint(cp);
      const t1 = performance.now();
      times.push(t1 - t0);
      serializedSize = serialized.length;
    }
    times.sort((a, b) => a - b);
    console.log(`  checkpoint+serialize: median=${percentile(times, 50).toFixed(2)}ms  p95=${percentile(times, 95).toFixed(2)}ms  p99=${percentile(times, 99).toFixed(2)}ms  size=${(serializedSize / 1024).toFixed(1)}KB`);

    // Restore
    const cp = createCheckpoint(world, "bench");
    const serialized = serializeCheckpoint(cp);
    const restoreTimes: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      const envLoad = deserializeCheckpoint(serialized);
      if (!envLoad.ok) throw new Error("deserialize failed");
      const result = restoreCheckpoint(envLoad.value);
      if (!result.ok) throw new Error("restore failed");
      attachEngine(result.value.world, engine);
      const t1 = performance.now();
      restoreTimes.push(t1 - t0);
    }
    restoreTimes.sort((a, b) => a - b);
    const envLoadFinal = deserializeCheckpoint(serialized);
    if (!envLoadFinal.ok) throw new Error("deserialize failed for hash check");
    const restoredResult = restoreCheckpoint(envLoadFinal.value);
    const restoredHash = stateHash((restoredResult as { ok: true; value: { world: WorldState } }).value.world);
    console.log(`  deserialize+restore:  median=${percentile(restoreTimes, 50).toFixed(2)}ms  p95=${percentile(restoreTimes, 95).toFixed(2)}ms  p99=${percentile(restoreTimes, 99).toFixed(2)}ms  hash_match=${restoredHash === hashes.state}`);

    // Fork
    const forkCp = createCheckpoint(world, "fork-bench");
    const forkTimes: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      const forkResult = forkTimeline(forkCp, `bench-fork-${i}`);
      const t1 = performance.now();
      forkTimes.push(t1 - t0);
    }
    forkTimes.sort((a, b) => a - b);
    console.log(`  fork:               median=${percentile(forkTimes, 50).toFixed(2)}ms  p95=${percentile(forkTimes, 95).toFixed(2)}ms  p99=${percentile(forkTimes, 99).toFixed(2)}ms`);

    // Rewind
    const rewindTimes: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const cp2 = createCheckpoint(world, `rewind-${i}`);
      const t0 = performance.now();
      const result = rewindTo(cp2, world);
      const t1 = performance.now();
      rewindTimes.push(t1 - t0);
    }
    rewindTimes.sort((a, b) => a - b);
    console.log(`  rewind:             median=${percentile(rewindTimes, 50).toFixed(2)}ms  p95=${percentile(rewindTimes, 95).toFixed(2)}ms  p99=${percentile(rewindTimes, 99).toFixed(2)}ms`);
  }

  // ─── SUMMARY ────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("\n  Budget analysis:");
  console.log("    60 Hz = 16.67 ms/tick");
  console.log("    30 Hz = 33.33 ms/tick");
  console.log("    10 Hz = 100.00 ms/tick");
  console.log("    1 Hz  = 1000.00 ms/tick");
  console.log("");

  for (const r of results) {
    const budget60 = r.median <= 16.67;
    const budget30 = r.median <= 33.33;
    const budget10 = r.median <= 100.00;
    const budget1 = r.median <= 1000.00;
    const verdict = budget60 ? "60Hz OK" : budget30 ? "30Hz OK" : budget10 ? "10Hz OK" : budget1 ? "1Hz OK" : "SLOW";
    console.log(`  ${r.name.padEnd(30)} median=${r.median.toFixed(2).padStart(8)}ms  → ${verdict}`);
  }

  console.log("\n  Scaling curve:");
  const scalingResults = results.filter(r => r.name.startsWith("scaling_"));
  for (const r of scalingResults) {
    const towns = r.name.match(/(\d+)_towns/)?.[1];
    console.log(`    ${towns?.padStart(3)} towns: median=${r.median.toFixed(2).padStart(8)}ms  p95=${r.p95.toFixed(2).padStart(8)}ms  events=${r.eventsGenerated}  provenance=${r.provenanceNodes}`);
  }

  console.log("\n  Burst curve:");
  const burstResults = results.filter(r => r.name.startsWith("burst_"));
  for (const r of burstResults) {
    const size = r.name.match(/burst_(\d+)/)?.[1];
    console.log(`    ${size?.padStart(3)} interventions: median=${r.median.toFixed(2).padStart(8)}ms  p95=${r.p95.toFixed(2).padStart(8)}ms  events=${r.eventsGenerated}`);
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  END BENCHMARK");
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch(console.error);
