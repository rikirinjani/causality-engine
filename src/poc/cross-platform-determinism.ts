/**
 * P-011: Cross-Platform Determinism Experiment
 *
 * Runs a fixed scenario on any machine and outputs deterministic artifacts
 * for comparison. Same seed + same interventions = same hashes.
 *
 * Run: npx tsx src/poc/cross-platform-determinism.ts
 */
import {
  createEngine, createWorld, submitIntervention, advance, snapshot,
  stateHash, traceHash, factStream, stream,
  makeConfig, type Engine, type WorldState, type Intervention,
} from "../api/public.js";

// Fixed parameters — identical across platforms
const SEED = 42;
const LABEL = "cross-platform-test";
const TICKS = 100;

function createTestWorld(): { world: WorldState; engine: Engine } {
  const engine = createEngine();
  const config = makeConfig({ seed: SEED });
  const world = createWorld(config, engine, LABEL);
  return { world, engine };
}

function base(id: string, action: string): Omit<Intervention, "target" | "location"> {
  return {
    id,
    tick: 0,
    actor: "player",
    action,
    intent: "cross-platform-test",
    magnitude: 1,
    causalDomains: [],
    provenance: { submittedAtTick: 0, sequence: 0 },
  };
}

function getInterventions(): Intervention[] {
  return [
    { ...base("cp-int-1", "destroy_infrastructure"), target: { type: "infrastructure", id: "grain_warehouse" }, location: "RF" },
    { ...base("cp-int-2", "kill_entity"), target: { type: "entity", id: "a07" }, location: "RF" },
    { ...base("cp-int-3", "destroy_infrastructure"), target: { type: "infrastructure", id: "grain_road" }, location: "HT" },
    { ...base("cp-int-4", "hold_public_rally"), target: { type: "region", id: "RF" }, location: "RF" },
    { ...base("cp-int-5", "grant_merchant_subsidy"), target: { type: "region", id: "HT" }, location: "HT" },
  ];
}

function runExperiment() {
  const { world, engine } = createTestWorld();
  const interventions = getInterventions();

  const results: Record<string, unknown> = {
    platform: {
      nodeVersion: process.version,
      arch: process.arch,
      platform: process.platform,
    },
    config: {
      seed: SEED,
      label: LABEL,
      ticks: TICKS,
    },
    initialStateHash: stateHash(world),
    initialStateTraceHash: traceHash(world),
    ticks: [] as Record<string, unknown>[],
    interventionResults: [] as Record<string, unknown>[],
    finalStateHash: "",
    finalTraceHash: "",
    finalRngState: 0,
    eventCount: 0,
    provenanceCount: 0,
    resolutionCount: 0,
  };

  // Run ticks with interventions at specific points
  const interventionTicks = [5, 15, 30, 50, 80];
  let interventionIdx = 0;

  for (let t = 0; t < TICKS; t++) {
    // Submit intervention at designated ticks
    if (interventionIdx < interventions.length && t === interventionTicks[interventionIdx]) {
      const iv = interventions[interventionIdx];
      const accepted = submitIntervention(world, iv, engine);
      results.interventionResults.push({
        tick: t,
        id: iv.id,
        accepted: accepted,
        target: iv.target.id,
      });
      interventionIdx++;
    }

    // Advance one tick
    advance(world, engine, 1);

    // Record hash at key ticks
    if ([0, 1, 5, 10, 20, 50, 99].includes(t)) {
      const snap = snapshot(world);
      const sh = stateHash(snap);
      const th = traceHash(snap);
      const fs = factStream(world);
      results.ticks.push({
        tick: t,
        stateHash: sh,
        traceHash: th,
        eventCount: fs.length,
        provenanceCount: snap.provenance.size,
        resolutionCount: snap.resolutionLog.length,
        rngState: snap.rngState.s,
      });
    }
  }

  // Final state
  const finalSnap = snapshot(world);
  results.finalStateHash = stateHash(finalSnap);
  results.finalTraceHash = traceHash(finalSnap);
  results.finalRngState = finalSnap.rngState.s;
  results.eventCount = factStream(world).length;
  results.provenanceCount = finalSnap.provenance.size;
  results.resolutionCount = finalSnap.resolutionLog.length;

  // Output JSON for cross-platform comparison
  console.log(JSON.stringify(results, null, 2));
}

runExperiment();
