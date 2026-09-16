/**
 * P-028 producer worker — creates a world, advances partway, serializes to file, exits.
 *
 * Usage: tsx scripts/p028/p028-producer-worker.ts <seed> <ticks> <outputFile> [--iv-file <path>]
 * Output: JSON with ok, tick, stateHash, traceHash, rngState, fileSize, and world metrics.
 * Side effect: writes serialized checkpoint to outputFile.
 */
import { advance, createEngine, createWorld, submitIntervention, type Engine } from "../../src/core/world.js";
import { stateHash, traceHash } from "../../src/core/hash.js";
import { createCheckpoint, serializeCheckpoint } from "../../src/core/persistence.js";
import { compactHistory, recentWindowPolicy } from "../../src/core/lifecycle.js";
import { WORLD_SEED } from "../../src/game/content.js";
import { iBridge, iMerchant, iWarehouse, iRally, iSubsidy, iShrine } from "../../src/poc/harness.js";
import { readFileSync, writeFileSync } from "node:fs";
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
  const outputFile = args[2];

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
      for (const iv of pending) applyIntervention(world, engine, iv.kind, `iv-${iv.kind}-${t}`);
    }
    advance(world, engine, 1);
  }

  // Optional forced compaction before serializing (used by dimension E to make
  // historyTruncated=true without needing natural limit overflow).
  const compactIdx = args.indexOf("--compact");
  if (compactIdx !== -1 && args[compactIdx + 1]) {
    compactHistory(world, recentWindowPolicy(Number(args[compactIdx + 1])));
  }

  const cp = createCheckpoint(world, "p028-producer");
  const serialized = serializeCheckpoint(cp);
  writeFileSync(outputFile, serialized, "utf8");

  console.log(JSON.stringify({
    ok: true, tick: world.tick, stateHash: stateHash(world), traceHash: traceHash(world),
    rngState: world.rngState, fileSize: serialized.length, eventCount: world.events.length,
    provenanceCount: world.provenance.length, resolutionCount: world.resolutionLog.length,
    diagnosticCount: world.diagnostics.length, interventionCount: world.interventionHistory.length,
    historyTruncated: world.historyTruncated, highestEmittedSeq: world.highestEmittedSeq,
    oldestRetainedSeq: world.oldestRetainedSeq, evictedCount: world.evictedCount,
    checkpointId: cp.identity.checkpointId, worldId: cp.identity.worldId,
    timelineId: cp.identity.timelineId,
  }));
}
main();
