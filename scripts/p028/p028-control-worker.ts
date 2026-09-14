/**
 * P-028 control worker — creates a world, advances it uninterrupted, outputs hashes.
 *
 * Usage: tsx scripts/p028/p028-control-worker.ts <seed> <ticks> [--iv-file <path>]
 * Output: JSON with ok, tick, stateHash, traceHash, rngState, and full world metrics.
 */
import { advance, createEngine, createWorld, submitIntervention, type Engine } from "../../src/core/world.js";
import { stateHash, traceHash } from "../../src/core/hash.js";
import { WORLD_SEED } from "../../src/game/content.js";
import { iBridge, iMerchant, iWarehouse, iRally, iSubsidy, iShrine } from "../../src/poc/harness.js";
import { readFileSync } from "node:fs";
import type { WorldState } from "../../src/core/types.js";

interface InterventionSpec { tick: number; kind: string; }

function applyIntervention(world: WorldState, engine: Engine, kind: string, id: string): void {
  switch (kind) {
    case "bridge": submitIntervention(world, iBridge(id), engine); break;
    case "merchant": submitIntervention(world, iMerchant(id), engine); break;
    case "warehouse": submitIntervention(world, iWarehouse(id), engine); break;
    case "rally": submitIntervention(world, iRally(id), engine); break;
    case "subsidy": submitIntervention(world, iSubsidy(id), engine); break;
    case "shrine": submitIntervention(world, iShrine(id), engine); break;
    default: throw new Error(`unknown intervention kind: ${kind}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const seed = Number(args[0]) || WORLD_SEED;
  const totalTicks = Number(args[1]);

  let interventions: InterventionSpec[] = [];
  const ivIdx = args.indexOf("--iv-file");
  if (ivIdx !== -1 && args[ivIdx + 1]) {
    interventions = JSON.parse(readFileSync(args[ivIdx + 1], "utf8"));
  }

  const engine = createEngine();
  const world = createWorld({ seed }, engine);

  const ivByTick = new Map<number, InterventionSpec[]>();
  for (const iv of interventions) {
    const list = ivByTick.get(iv.tick) ?? [];
    list.push(iv);
    ivByTick.set(iv.tick, list);
  }

  for (let t = 0; t < totalTicks; t++) {
    const pending = ivByTick.get(t);
    if (pending) {
      for (const iv of pending) applyIntervention(world, engine, iv.kind, `ctrl-${iv.kind}-${t}`);
    }
    advance(world, engine, 1);
  }

  console.log(JSON.stringify({
    ok: true, tick: world.tick, stateHash: stateHash(world), traceHash: traceHash(world),
    rngState: world.rngState, eventCount: world.events.length, provenanceCount: world.provenance.length,
    resolutionCount: world.resolutionLog.length, diagnosticCount: world.diagnostics.length,
    interventionCount: world.interventionHistory.length, historyTruncated: world.historyTruncated,
    highestEmittedSeq: world.highestEmittedSeq, oldestRetainedSeq: world.oldestRetainedSeq,
    evictedCount: world.evictedCount,
  }));
}
main();
