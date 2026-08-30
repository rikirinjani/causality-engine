import { writeFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance, attachEngine, createEngine, createWorld, submitIntervention } from "../core/world.js";
import { stateHash, traceHash } from "../core/hash.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
  validateCheckpoint,
} from "../core/persistence.js";
import { checkpoint, forkTimeline, rewindTo } from "../core/timeline.js";
import { pendingCausesOf } from "../core/propagation.js";
import { explain, key } from "../core/provenance.js";
import { iBridge, iRally, iSubsidy, iWarehouse } from "./harness.js";
import type { WorldState } from "../core/types.js";

/**
 * Persistence evidence driver + performance baseline (docs/RECONNAISSANCE.md §17.11).
 * Run: npx tsx src/poc/persistence.ts
 *
 * MEASUREMENT ONLY. Nothing here is optimized; the point is architectural visibility.
 */

const section = (t: string) => console.log(`\n${"=".repeat(100)}\n${t}\n${"=".repeat(100)}`);
const f = (n: number, d = 2) => n.toFixed(d);

/** Median of N timed runs — median rather than mean because JIT warmup skews the first calls. */
function timeIt(label: string, iterations: number, fn: () => void): { label: string; ms: number; iterations: number } {
  // warmup
  for (let i = 0; i < Math.min(3, iterations); i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return { label, ms: samples[Math.floor(samples.length / 2)]!, iterations };
}

function buildWorld(ticks: number, withInterventions: boolean): WorldState {
  const engine = createEngine();
  const world = createWorld({ seed: 42 }, engine);
  advance(world, engine, 9);
  if (withInterventions) {
    submitIntervention(world, iBridge(), engine);
    submitIntervention(world, iWarehouse(), engine);
    submitIntervention(world, iRally(), engine);
    submitIntervention(world, iSubsidy(), engine);
  }
  advance(world, engine, Math.max(0, ticks - 9));
  return world;
}

// ---------------------------------------------------------------------------
section("§17.1 WHAT A CHECKPOINT CONTAINS");
// ---------------------------------------------------------------------------
const midTick = (() => {
  const engine = createEngine();
  const world = createWorld({ seed: 42 }, engine);
  advance(world, engine, 9);
  submitIntervention(world, iBridge(), engine);
  submitIntervention(world, iWarehouse(), engine);
  return world;
})();

console.log("captured at tick", midTick.tick, "with UNRESOLVED causal work:");
console.log("  pending regions:", JSON.stringify(Object.keys(midTick.pendingContributions)));
for (const [rid, buckets] of Object.entries(midTick.pendingContributions)) {
  for (const [domain, entry] of Object.entries(buckets ?? {})) {
    if (entry) {
      console.log(
        `    ${rid}/${domain}: pressure ${f(entry.pressure, 4)} raw ${f(entry.raw, 4)} origin ${entry.origin} gen ${entry.generation} causes ${pendingCausesOf(midTick, rid, domain as never).length}`,
      );
    }
  }
}
console.log("  intervention history:", midTick.interventionHistory.map((i) => i.id).join(", "));
console.log("  provenance nodes:", midTick.provenance.length, " resolutions:", midTick.resolutionLog.length);
console.log("\n-> pendingContributions is NOT reconstructable from the settled world: the state");
console.log("   transitions that produced it already happened. Omitting it would restore a");
console.log("   plausible world that then evolves differently.");

// ---------------------------------------------------------------------------
section("§17.2 SNAPSHOT IDENTITY");
// ---------------------------------------------------------------------------
const cpMid = createCheckpoint(midTick, "mid-tick");
console.log("checkpointId :", cpMid.identity.checkpointId);
console.log("worldId      :", cpMid.identity.worldId);
console.log("timelineId   :", cpMid.identity.timelineId, `(origin ${cpMid.world.lineage.origin})`);
console.log("tick         :", cpMid.identity.tick);
console.log("stateHash    :", cpMid.identity.stateHash.slice(0, 32));
console.log("traceHash    :", cpMid.identity.traceHash.slice(0, 32));
console.log("configHash   :", cpMid.identity.configHash.slice(0, 32));
console.log("seed         :", cpMid.identity.seed, " schemaVersion:", cpMid.identity.schemaVersion);
console.log("rngState     :", JSON.stringify(cpMid.identity.rngState));
console.log("provenance   :", JSON.stringify(cpMid.identity.provenanceCheckpoint));

// same world, different history
const buildOrdered = (reverse: boolean) => {
  const engine = createEngine();
  const world = createWorld({ seed: 42 }, engine);
  advance(world, engine, 9);
  const list = [iBridge("i-bridge"), iWarehouse("i-warehouse")];
  for (const i of reverse ? [...list].reverse() : list) submitIntervention(world, i, engine);
  advance(world, engine, 5);
  return createCheckpoint(world);
};
const oA = buildOrdered(false);
const oB = buildOrdered(true);
console.log("\nsame world / different history:");
console.log(`  stateHash equal: ${oA.identity.stateHash === oB.identity.stateHash}`);
console.log(`  traceHash equal: ${oA.identity.traceHash === oB.identity.traceHash}`);
console.log(`  checkpointId equal: ${oA.identity.checkpointId === oB.identity.checkpointId}`);

// ---------------------------------------------------------------------------
section("§17.3 MID-TICK RESUME — continue vs restore-and-continue");
// ---------------------------------------------------------------------------
const contA = structuredClone(midTick);
advance(contA, attachEngine(contA, createEngine()), 25);

const restoredMid = restoreCheckpoint(cpMid);
if (!restoredMid.ok) throw new Error("restore failed");
const contB = restoredMid.value.world;
advance(contB, attachEngine(contB, createEngine()), 25);

console.log(`continuous          t${contA.tick} state ${stateHash(contA).slice(0, 16)} trace ${traceHash(contA).slice(0, 16)}`);
console.log(`restore + continue  t${contB.tick} state ${stateHash(contB).slice(0, 16)} trace ${traceHash(contB).slice(0, 16)}`);
console.log(`state identical: ${stateHash(contA) === stateHash(contB)}   trace identical: ${traceHash(contA) === traceHash(contB)}`);
console.log(`resolutions identical: ${JSON.stringify(contA.resolutionLog) === JSON.stringify(contB.resolutionLog)}`);
console.log(`diagnostics identical: ${JSON.stringify(contA.diagnostics) === JSON.stringify(contB.diagnostics)}`);
console.log(`RNG register identical: ${contA.rngState.s === contB.rngState.s}`);

// ---------------------------------------------------------------------------
section("§17.4 REWIND");
// ---------------------------------------------------------------------------
const rewindBase = (() => {
  const engine = createEngine();
  const world = createWorld({ seed: 42 }, engine);
  advance(world, engine, 20);
  return { world, engine };
})();
const rewindPoint = checkpoint(rewindBase.world, "tick-20");
submitIntervention(rewindBase.world, iBridge("f1"), rewindBase.engine);
advance(rewindBase.world, rewindBase.engine, 10);
submitIntervention(rewindBase.world, iWarehouse("f2"), rewindBase.engine);
advance(rewindBase.world, rewindBase.engine, 20);

console.log(`abandoned future reached t${rewindBase.world.tick}, state ${stateHash(rewindBase.world).slice(0, 16)}`);
const rw = rewindTo(rewindPoint, rewindBase.world);
if (!rw.ok) throw new Error(rw.errors.join("; "));
console.log(`rewound to t${rw.value.world.tick}`);
console.log(`  old timeline: ${rw.value.abandonedTimelineId}`);
console.log(`  new timeline: ${rw.value.timelineId} (origin ${rw.value.world.lineage.origin})`);
const ab = rw.value.world.lineage.abandonedTimelines[0]!;
console.log(`  abandoned record: reached t${ab.abandonedAtTick}, interventions [${ab.interventionIds.join(", ")}], hash ${ab.abandonedStateHash.slice(0, 16)}`);
console.log(`  live provenance nodes: ${rw.value.world.provenance.length} (checkpoint had ${rewindPoint.world.provenance.length})`);
console.log(`  live world knows about f1: ${rw.value.world.interventionHistory.some((i) => i.id === "f1")}`);
console.log("-> the abandoned future is referenceable and verifiable, but is NOT part of the");
console.log("   live world's causal history: explain() must not cite events that did not happen.");

// ---------------------------------------------------------------------------
section("§17.5 BRANCHING + ISOLATION");
// ---------------------------------------------------------------------------
const forkBase = buildWorld(15, false);
const forkPoint = checkpoint(forkBase, "fork");
const parentHashBefore = stateHash(forkBase);

const bA = forkTimeline(forkPoint, "branch-a");
const bB = forkTimeline(forkPoint, "branch-b");
if (!bA.ok || !bB.ok) throw new Error("fork failed");

submitIntervention(bA.value.world, iBridge("X"), bA.value.engine);
advance(bA.value.world, bA.value.engine, 20);
submitIntervention(bB.value.world, iRally("Y"), bB.value.engine);
advance(bB.value.world, bB.value.engine, 20);

console.log(`parent timeline : ${forkBase.lineage.timelineId} @t${forkBase.tick}`);
console.log(`branch A        : ${bA.value.timelineId} parent=${bA.value.world.lineage.parentTimelineId} forkTick=${bA.value.world.lineage.forkTick}`);
console.log(`branch B        : ${bB.value.timelineId} parent=${bB.value.world.lineage.parentTimelineId} forkTick=${bB.value.world.lineage.forkTick}`);
console.log(`\nparent unchanged after both branches ran: ${stateHash(forkBase) === parentHashBefore}`);
console.log(`branch states diverge: ${stateHash(bA.value.world) !== stateHash(bB.value.world)}`);
console.log(`A grain price ${f(bA.value.world.regions["RF"]!.prices["grain"] ?? 0)} | B grain price ${f(bB.value.world.regions["RF"]!.prices["grain"] ?? 0)}`);
console.log(`A unrest ${f(bA.value.world.regions["RF"]!.unrest, 3)} | B unrest ${f(bB.value.world.regions["RF"]!.unrest, 3)}`);

// ---------------------------------------------------------------------------
section("§17.6 BRANCH CONVERGENCE — same world, different history");
// ---------------------------------------------------------------------------
const convergeRun = (label: string, reverse: boolean) => {
  const fk = forkTimeline(forkPoint, label);
  if (!fk.ok) throw new Error("fork failed");
  const list = [iBridge("i-bridge"), iWarehouse("i-warehouse")];
  for (const i of reverse ? [...list].reverse() : list) submitIntervention(fk.value.world, i, fk.value.engine);
  advance(fk.value.world, fk.value.engine, 20);
  return fk.value.world;
};
const cvA = convergeRun("conv-a", false);
const cvB = convergeRun("conv-b", true);
const physical = (w: WorldState) => {
  const c = structuredClone(w);
  c.lineage = { ...c.lineage, timelineId: "T-x", parentTimelineId: null, parentCheckpointId: null, forkTick: null, generation: 0 };
  return stateHash(c);
};
console.log(`physical state converged: ${physical(cvA) === physical(cvB)}`);
console.log(`causal history diverged : ${traceHash(cvA) !== traceHash(cvB)}`);
console.log("-> this is the state/trace split doing its job: the world is the same, the story is not.");

// ---------------------------------------------------------------------------
section("§17.7 PROVENANCE AFTER RESTORE, AND TRUNCATION HONESTY");
// ---------------------------------------------------------------------------
const provWorld = buildWorld(18, true);
const beforeEx = explain(provWorld, key.price("RF", "grain"));
const provCp = createCheckpoint(provWorld);
const provRestored = restoreCheckpoint(provCp);
if (!provRestored.ok) throw new Error("restore failed");
const afterEx = explain(provRestored.value.world, key.price("RF", "grain"));

console.log(`before restore: explained=${beforeEx.explained} roots=[${beforeEx.roots.map((r) => r.interventionId).join(", ")}] incomplete=${beforeEx.incomplete}`);
console.log(`after  restore: explained=${afterEx.explained} roots=[${afterEx.roots.map((r) => r.interventionId).join(", ")}] incomplete=${afterEx.incomplete}`);
console.log(`paths identical: ${JSON.stringify(beforeEx.paths) === JSON.stringify(afterEx.paths)}`);

const evicted = structuredClone(provWorld);
const ref = evicted.provenanceRefs[key.price("RF", "grain")]!;
evicted.provenance = evicted.provenance.filter((n) => n.id !== ref);
evicted.historyTruncated = true;
const evictedEx = explain(evicted, key.price("RF", "grain"));
console.log(`\nwith the cited node evicted: explained=${evictedEx.explained} incomplete=${evictedEx.incomplete} dangling=[${evictedEx.danglingParents.join(", ")}]`);
console.log("-> an incomplete trace says so. It does not report 'nothing caused this'.");

// ---------------------------------------------------------------------------
section("§17.10 INVALID SNAPSHOT BEHAVIOUR");
// ---------------------------------------------------------------------------
const cases: Array<[string, unknown]> = [
  ["not JSON", "{ broken"],
  ["array payload", [1, 2, 3]],
  ["wrong format", { ...cpMid, format: "other" }],
  ["future version", { ...cpMid, formatVersion: 99 }],
];
for (const [label, payload] of cases) {
  const r = typeof payload === "string" ? deserializeCheckpoint(payload) : validateCheckpoint(payload);
  console.log(`${label.padEnd(18)} -> ${r.ok ? "ACCEPTED (bug!)" : `rejected: ${r.errors.map((e) => e.code).join(", ")}`}`);
}
const tamperState = structuredClone(cpMid);
tamperState.world.tradeVolume += 1;
const rState = validateCheckpoint(tamperState);
console.log(`tampered world     -> ${rState.ok ? "ACCEPTED (bug!)" : `rejected: ${rState.errors.map((e) => e.code).join(", ")}`}`);

const tamperHistory = structuredClone(cpMid);
tamperHistory.world.interventionHistory = [];
const rHist = validateCheckpoint(tamperHistory);
console.log(`erased history     -> ${rHist.ok ? "ACCEPTED (bug!)" : `rejected: ${rHist.errors.map((e) => e.code).join(", ")}`}`);

const badLedger = structuredClone(cpMid);
badLedger.world.regions["RF"]!.ledger.economy = Number.NaN;
const rLedger = validateCheckpoint(badLedger);
console.log(`NaN ledger         -> ${rLedger.ok ? "ACCEPTED (bug!)" : `rejected: ${rLedger.errors.map((e) => e.code).join(", ")}`}`);

const badConfig = restoreCheckpoint(cpMid, { config: { ...cpMid.world.config, ledgerDecayPerTick: 0.5 } });
console.log(`foreign config     -> ${badConfig.ok ? "ACCEPTED (bug!)" : `rejected: ${badConfig.errors.map((e) => e.code).join(", ")}`}`);

// ---------------------------------------------------------------------------
section("§17.11 PERFORMANCE BASELINE (measurement only, no optimization)");
// ---------------------------------------------------------------------------
const sizes: Array<[string, WorldState]> = [
  ["quiet t20", buildWorld(20, false)],
  ["active t40", buildWorld(40, true)],
  ["active t120", buildWorld(120, true)],
];

console.log("world         | ticks | provenance | resolutions | diagnostics | serialized bytes | per-tick bytes");
for (const [label, w] of sizes) {
  const env = createCheckpoint(w);
  const text = serializeCheckpoint(env);
  console.log(
    `${label.padEnd(13)} | ${String(w.tick).padStart(5)} | ${String(w.provenance.length).padStart(10)} | ` +
      `${String(w.resolutionLog.length).padStart(11)} | ${String(w.diagnostics.length).padStart(11)} | ` +
      `${String(text.length).padStart(16)} | ${String(Math.round(text.length / Math.max(1, w.tick))).padStart(14)}`,
  );
}

const perfWorld = buildWorld(120, true);
const perfEnv = createCheckpoint(perfWorld);
const perfText = serializeCheckpoint(perfEnv);
const parsedOnce = deserializeCheckpoint(perfText);
if (!parsedOnce.ok) throw new Error("parse failed");

const timings = [
  timeIt("createCheckpoint (deep clone + 3 hashes)", 40, () => void createCheckpoint(perfWorld)),
  timeIt("serializeCheckpoint (JSON.stringify)", 40, () => void serializeCheckpoint(perfEnv)),
  timeIt("deserializeCheckpoint (parse + validate)", 40, () => void deserializeCheckpoint(perfText)),
  timeIt("restoreCheckpoint (deep clone)", 40, () => void restoreCheckpoint(parsedOnce.value)),
  timeIt("forkTimeline (restore + lineage)", 40, () => void forkTimeline(perfEnv, "perf")),
  timeIt("stateHash alone", 40, () => void stateHash(perfWorld)),
  timeIt("traceHash alone", 40, () => void traceHash(perfWorld)),
  timeIt("advance 1 tick (for scale)", 40, () => {
    const w = structuredClone(perfWorld);
    advance(w, attachEngine(w, createEngine()), 1);
  }),
];

console.log("\noperation                                  | median ms");
for (const t of timings) console.log(`${t.label.padEnd(42)} | ${f(t.ms, 3).padStart(9)}`);

// disk round-trip
const dir = mkdtempSync(join(tmpdir(), "ce-perf-"));
try {
  const file = join(dir, "cp.json");
  const diskWrite = timeIt("write checkpoint to disk", 20, () => writeFileSync(file, perfText, "utf8"));
  writeFileSync(file, perfText, "utf8");
  console.log(`${diskWrite.label.padEnd(42)} | ${f(diskWrite.ms, 3).padStart(9)}`);
  console.log(`on-disk size: ${statSync(file).size} bytes for a ${perfWorld.tick}-tick active world`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("\nobservations (NOT acted on — architectural visibility only):");
console.log("  * checkpoint size is dominated by causal history, not by the world itself;");
console.log("    provenance/resolution logs grow per tick while regions/entities are fixed.");
console.log("  * hashing cost is paid three times per checkpoint (state, trace, config).");
console.log("  * a checkpoint currently costs roughly the same order as a handful of ticks,");
console.log("    so per-tick checkpointing would be affordable but per-tick SERIALIZATION");
console.log("    would not at this growth rate.");
