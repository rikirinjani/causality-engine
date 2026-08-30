/**
 * Process-boundary resume worker (docs/RECONNAISSANCE.md §17.3).
 *
 * Reads a serialized checkpoint from a file, resumes it in a FRESH PROCESS, advances a given
 * number of ticks, and prints the resulting hashes as JSON. Exists so process-boundary
 * determinism can be actually crossed rather than asserted — an in-process "restore" shares
 * the module registry, the JIT state and every closure, so it cannot prove that a saved world
 * resumes correctly somewhere else.
 *
 * Usage: tsx src/poc/resume-worker.ts <checkpointFile> <ticks>
 */
import { readFileSync } from "node:fs";
import { advance, attachEngine, createEngine } from "../core/world.js";
import { stateHash, traceHash } from "../core/hash.js";
import { deserializeCheckpoint, restoreCheckpoint } from "../core/persistence.js";

function main(): void {
  const [file, ticksArg] = process.argv.slice(2);
  if (!file || !ticksArg) {
    console.log(JSON.stringify({ ok: false, error: "usage: resume-worker <file> <ticks>" }));
    process.exit(2);
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
  const engine = attachEngine(world, createEngine());
  advance(world, engine, Number(ticksArg));

  console.log(
    JSON.stringify({
      ok: true,
      tick: world.tick,
      stateHash: stateHash(world),
      traceHash: traceHash(world),
      rngState: world.rngState,
      resolutionCount: world.resolutionLog.length,
      diagnosticCount: world.diagnostics.length,
      provenanceCount: world.provenance.length,
      warnings: parsed.warnings.map((w) => w.code),
    }),
  );
}

main();
