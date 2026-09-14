/**
 * P-028 resumer worker — loads a serialized checkpoint, continues advancing, outputs hashes.
 *
 * Usage: tsx scripts/p028/p028-resumer-worker.ts <checkpointFile> <ticks> [--iv-file <path>]
 * This runs in a FRESH PROCESS — no shared module registry, JIT state, or closures with the producer.
 * Output: JSON with ok, tick, stateHash, traceHash, rngState, and world metrics.
 */
import { readFileSync } from "node:fs";
import { advance, attachEngine, createEngine, submitIntervention } from "../../src/core/world.js";
import { stateHash, traceHash } from "../../src/core/hash.js";
import { deserializeCheckpoint, restoreCheckpoint } from "../../src/core/persistence.js";
import { iBridge, iMerchant, iWarehouse, iRally, iSubsidy, iShrine } from "../../src/poc/harness.js";
import type { WorldState } from "../../src/core/types.js";

interface InterventionSpec { tick: number; kind: string; }

let engine: ReturnType<typeof createEngine> | null = null;

function applyIntervention(world: WorldState, kind: string, id: string): void {
  switch (kind) {
    case "bridge": submitIntervention(world, iBridge(id), engine!, id); break;
    case "merchant": submitIntervention(world, iMerchant(id), engine!, id); break;
    case "warehouse": submitIntervention(world, iWarehouse(id), engine!, id); break;
    case "rally": submitIntervention(world, iRally(id), engine!, id); break;
    case "subsidy": submitIntervention(world, iSubsidy(id), engine!, id); break;
    case "shrine": submitIntervention(world, iShrine(id), engine!, id); break;
    default: throw new Error(`unknown intervention kind: ${kind}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const file = args[0];
  const totalTicks = Number(args[1]);

  let interventions: InterventionSpec[] = [];
  const ivIdx = args.indexOf("--iv-file");
  if (ivIdx !== -1 && args[ivIdx + 1]) {
    interventions = JSON.parse(readFileSync(args[ivIdx + 1], "utf8"));
  }

  const text = readFileSync(file, "utf8");
  const parsed = deserializeCheckpoint(text);
  if (!parsed.ok) {
    console.log(JSON.stringify({ ok: false, error: "deserialize failed", errors: parsed.errors }));
    process.exit(1);
  }

  const restored = restoreCheckpoint(parsed.value);
  if (!restored.ok) {
    console.log(JSON.stringify({ ok: false, error: "restore failed", errors: restored.errors }));
    process.exit(1);
  }

  const world = restored.value.world;
  engine = attachEngine(world, createEngine());

  const ivByTick = new Map<number, InterventionSpec[]>();
  for (const iv of interventions) {
    const list = ivByTick.get(iv.tick) ?? [];
    list.push(iv);
    ivByTick.set(iv.tick, list);
  }

  const startTick = world.tick;
  for (let t = 0; t < totalTicks; t++) {
    const absTick = startTick + t;
    const pending = ivByTick.get(t);
    if (pending) {
      for (const iv of pending) applyIntervention(world, iv.kind, `resumer-${iv.kind}-${absTick}`);
    }
    advance(world, engine, 1);
  }

  console.log(JSON.stringify({
    ok: true, tick: world.tick, stateHash: stateHash(world), traceHash: traceHash(world),
    rngState: world.rngState, eventCount: world.events.length, provenanceCount: world.provenance.length,
    resolutionCount: world.resolutionLog.length, diagnosticCount: world.diagnostics.length,
    interventionCount: world.interventionHistory.length, historyTruncated: world.historyTruncated,
    highestEmittedSeq: world.highestEmittedSeq, oldestRetainedSeq: world.oldestRetainedSeq,
    evictedCount: world.evictedCount, warnings: parsed.warnings.map((w) => w.code),
  }));
}
main();
