/**
 * P-011: Long-Running Simulation — Provenance Growth Measurement
 *
 * Runs CE for 10K ticks with periodic interventions to expose
 * the O(nodes) provenance cost observed in P-010.
 *
 * Run: npx tsx src/poc/long-run.ts [ticks]
 */
import { performance } from "node:perf_hooks";
import {
  createEngine, createWorld, submitIntervention, advance, snapshot,
  stateHash, traceHash, factStream,
  makeConfig, type Engine, type WorldState, type Intervention,
} from "../api/public.js";

const TOTAL_TICKS = parseInt(process.argv[2] || "10000", 10);
const INTERVENTION_INTERVAL = 50; // submit an intervention every N ticks

function base(id: string, action: string): Omit<Intervention, "target" | "location"> {
  return {
    id,
    tick: 0,
    actor: "player",
    action,
    intent: "long-run-test",
    magnitude: 1,
    causalDomains: [],
    provenance: { submittedAtTick: 0, sequence: 0 },
  };
}

const INTERVENTIONS: Intervention[] = [
  { ...base("lr-bridge", "destroy_infrastructure"), target: { type: "infrastructure", id: "grain_road" }, location: "RF" },
  { ...base("lr-merchant", "kill_entity"), target: { type: "entity", id: "a07" }, location: "RF" },
  { ...base("lr-warehouse", "destroy_infrastructure"), target: { type: "infrastructure", id: "grain_warehouse" }, location: "HT" },
  { ...base("lr-rally", "hold_public_rally"), target: { type: "region", id: "PS" }, location: "PS" },
  { ...base("lr-subsidy", "grant_merchant_subsidy"), target: { type: "region", id: "RF" }, location: "RF" },
];

function run() {
  const engine = createEngine();
  const config = makeConfig({ seed: 42 });
  const world = createWorld(config, engine, "long-run");

  console.log(`Running ${TOTAL_TICKS} ticks with intervention every ${INTERVENTION_INTERVAL} ticks...`);
  console.log(`Platform: ${process.platform} ${process.arch} Node ${process.version}`);
  console.log("");

  const tickTimes: number[] = [];
  let interventionIdx = 0;
  const checkpoints: Array<{ tick: number; time: number; size: number }> = [];

  const startTime = performance.now();

  for (let t = 0; t < TOTAL_TICKS; t++) {
    // Submit intervention periodically
    if (t > 0 && t % INTERVENTION_INTERVAL === 0) {
      const iv = INTERVENTIONS[interventionIdx % INTERVENTIONS.length];
      iv.id = `lr-${t}-${interventionIdx}`;
      submitIntervention(world, iv, engine);
      interventionIdx++;
    }

    // Measure tick time
    const tickStart = performance.now();
    advance(world, engine, 1);
    const tickEnd = performance.now();
    tickTimes.push(tickEnd - tickStart);

    // Record checkpoints at key intervals
    if ([100, 500, 1000, 2000, 5000, 10000].includes(t + 1)) {
      const snap = snapshot(world);
      const sh = stateHash(snap);
      const th = traceHash(snap);
      const fs = factStream(world);
      const elapsed = performance.now() - startTime;

      // Estimate checkpoint size
      const stateJson = JSON.stringify(snap);
      const sizeBytes = Buffer.byteLength(stateJson, "utf8");

      checkpoints.push({
        tick: t + 1,
        time: elapsed,
        size: sizeBytes,
      });

      const median = percentile(tickTimes, 50);
      const p95 = percentile(tickTimes, 95);
      const p99 = percentile(tickTimes, 99);

      console.log(`  tick ${String(t + 1).padStart(5)} | median=${median.toFixed(2).padStart(7)}ms p95=${p95.toFixed(2).padStart(7)}ms p99=${p99.toFixed(2).padStart(7)}ms | provenance=${String(snap.provenance.size).padStart(5)} events=${String(fs.length).padStart(4)} resolutions=${String(snap.resolutionLog.length).padStart(4)} | state=${sizeBytes} bytes | hash=${sh.slice(0, 12)}...`);
    }
  }

  const totalTime = performance.now() - startTime;
  const finalSnap = snapshot(world);
  const finalFs = factStream(world);

  console.log("");
  console.log("=== FINAL STATE ===");
  console.log(`  Total time: ${(totalTime / 1000).toFixed(2)}s`);
  console.log(`  Total ticks: ${TOTAL_TICKS}`);
  console.log(`  Avg tick: ${(totalTime / TOTAL_TICKS).toFixed(2)}ms`);
  console.log(`  Median tick: ${percentile(tickTimes, 50).toFixed(2)}ms`);
  console.log(`  p95 tick: ${percentile(tickTimes, 95).toFixed(2)}ms`);
  console.log(`  p99 tick: ${percentile(tickTimes, 99).toFixed(2)}ms`);
  console.log(`  Max tick: ${Math.max(...tickTimes).toFixed(2)}ms`);
  console.log(`  Provenance nodes: ${finalSnap.provenance.size}`);
  console.log(`  Events: ${finalFs.length}`);
  console.log(`  Resolutions: ${finalSnap.resolutionLog.length}`);
  console.log(`  Interventions submitted: ${interventionIdx}`);
  console.log(`  Final stateHash: ${stateHash(finalSnap)}`);
  console.log(`  Final traceHash: ${traceHash(finalSnap)}`);
  console.log(`  Final RNG state: ${finalSnap.rngState.s}`);

  // Checkpoint size
  const finalJson = JSON.stringify(finalSnap);
  console.log(`  State size: ${Buffer.byteLength(finalJson, "utf8")} bytes (${(Buffer.byteLength(finalJson, "utf8") / 1024).toFixed(1)} KB)`);

  console.log("");
  console.log("=== CHECKPOINT GROWTH ===");
  for (const cp of checkpoints) {
    console.log(`  tick ${String(cp.tick).padStart(5)} | ${(cp.time / 1000).toFixed(2).padStart(6)}s elapsed | ${(cp.size / 1024).toFixed(1).padStart(6)} KB state`);
  }

  // Provenance growth analysis
  console.log("");
  console.log("=== PROVENANCE GROWTH CURVE ===");
  const sortedCheckpoints = [...checkpoints].sort((a, b) => a.tick - b.tick);
  if (sortedCheckpoints.length >= 2) {
    const first = sortedCheckpoints[0];
    const last = sortedCheckpoints[sortedCheckpoints.length - 1];
    const tickRatio = last.tick / first.tick;
    const sizeRatio = last.size / first.size;
    console.log(`  Tick growth: ${tickRatio.toFixed(1)}x (${first.tick} → ${last.tick})`);
    console.log(`  Size growth: ${sizeRatio.toFixed(1)}x (${(first.size / 1024).toFixed(1)}KB → ${(last.size / 1024).toFixed(1)}KB)`);
    console.log(`  Growth exponent: ${Math.log(sizeRatio) / Math.log(tickRatio).toFixed(2)} (1.0 = linear, <1.0 = sublinear)`);
  }
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

run();
