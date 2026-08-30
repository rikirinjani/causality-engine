import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance, attachEngine, createEngine, createWorld, submitIntervention } from "../core/world.js";
import { stateHash, traceHash } from "../core/hash.js";
import { createCheckpoint, deserializeCheckpoint, serializeCheckpoint } from "../core/persistence.js";
import { checkpoint, forkTimeline } from "../core/timeline.js";
import {
  classifyCheckpoint,
  compactHistory,
  recentWindowPolicy,
  RESUME_ONLY,
  RETAIN_ALL,
  type RetentionPolicy,
} from "../core/lifecycle.js";
import { CURRENT_SCHEMA_VERSION, migrateWorld } from "../core/migration.js";
import { explain, key } from "../core/provenance.js";
import { iBridge, iMerchant, iRally, iSubsidy, iWarehouse } from "./harness.js";
import type { WorldState } from "../core/types.js";

/**
 * History lifecycle evidence driver + performance baseline (docs/RECONNAISSANCE.md §18.15).
 * Run: npx tsx src/poc/lifecycle.ts
 *
 * MEASUREMENT ONLY. Nothing here is optimized.
 */

const section = (t: string) => console.log(`\n${"=".repeat(100)}\n${t}\n${"=".repeat(100)}`);
const f = (n: number, d = 2) => n.toFixed(d);

function timeIt(iterations: number, fn: () => void): number {
  for (let i = 0; i < Math.min(3, iterations); i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

function historicWorld(totalTicks: number): WorldState {
  const engine = createEngine();
  const world = createWorld({ seed: 42 }, engine);
  advance(world, engine, 9);
  submitIntervention(world, iBridge(), engine);
  submitIntervention(world, iWarehouse(), engine);
  advance(world, engine, 10);
  submitIntervention(world, iRally(), engine);
  advance(world, engine, 10);
  submitIntervention(world, iSubsidy(), engine);
  advance(world, engine, Math.max(0, totalTicks - 29));
  submitIntervention(world, iMerchant(), engine);
  return world;
}

function forward(source: WorldState, ticks: number): WorldState {
  const w = structuredClone(source);
  advance(w, attachEngine(w, createEngine()), ticks);
  return w;
}

// ---------------------------------------------------------------------------
section("§18.2 THE FOUR PERSISTENCE LAYERS — what is actually load-bearing");
// ---------------------------------------------------------------------------
const probe = historicWorld(40);

const layers: Array<[string, (w: WorldState) => void]> = [
  ["1. current world state (regions/entities/relations)", (w) => { w.regions["RF"]!.stocks["grain"] = 999; }],
  ["2. pending causal continuation", (w) => { w.pendingContributions = {}; }],
  ["3. provenance / causal history", (w) => { w.provenance = []; w.provenanceRefs = {}; w.resolutionLog = []; w.diagnostics = []; w.dynamics = {}; w.interventionHistory = []; w.ledgerCauses = {}; w.pendingCauses = {}; }],
  ["4. genealogy (lineage)", (w) => { w.lineage = { ...w.lineage, timelineId: "T-other" }; }],
];

console.log("layer                                        | affects stateHash | affects traceHash");
for (const [label, mutate] of layers) {
  const m = structuredClone(probe);
  mutate(m);
  console.log(
    `${label.padEnd(44)} | ${String(stateHash(m) !== stateHash(probe)).padEnd(17)} | ${stateHash(m) !== stateHash(probe) || traceHash(m) !== traceHash(probe) ? String(traceHash(m) !== traceHash(probe)) : "false"}`,
  );
}
console.log("\n-> layers 1, 2 and 4 are load-bearing for identity; layer 3 is explanation only.");
console.log("   That asymmetry is the entire licence for compaction.");

// ---------------------------------------------------------------------------
section("§18.13 MANDATORY — identical state, different retained history, identical future");
// ---------------------------------------------------------------------------
const base = historicWorld(60);
const full = structuredClone(base);
const compact = structuredClone(base);
const report = compactHistory(compact, recentWindowPolicy(5));

console.log(`at capture: stateHash equal = ${stateHash(compact) === stateHash(full)}`);
console.log(`            traceHash equal = ${traceHash(compact) === traceHash(full)}`);
console.log(`compaction: provenance ${report.provenance.before} -> ${report.provenance.after}, boundary tick ${report.retentionBoundaryTick}`);

const runBoth = (w: WorldState) => {
  const e = attachEngine(w, createEngine());
  advance(w, e, 5);
  submitIntervention(w, iBridge("post-1"), e);
  advance(w, e, 15);
  submitIntervention(w, iSubsidy("post-2"), e);
  advance(w, e, 20);
  return w;
};
const fullOut = runBoth(structuredClone(full));
const compactOut = runBoth(structuredClone(compact));
console.log(`\nafter 40 more ticks + 2 identical interventions:`);
console.log(`  full    t${fullOut.tick} ${stateHash(fullOut).slice(0, 24)}`);
console.log(`  compact t${compactOut.tick} ${stateHash(compactOut).slice(0, 24)}`);
console.log(`  IDENTICAL: ${stateHash(compactOut) === stateHash(fullOut)}`);
console.log("-> history is explanatory, not secretly simulation state.");

// ---------------------------------------------------------------------------
section("§18.5 RETENTION POLICIES AND WHAT EACH COSTS");
// ---------------------------------------------------------------------------
const policies: Array<[string, RetentionPolicy]> = [
  ["RETAIN_ALL", RETAIN_ALL],
  ["recentWindow(20)", recentWindowPolicy(20)],
  ["recentWindow(5)", recentWindowPolicy(5)],
  ["RESUME_ONLY", RESUME_ONLY],
];

console.log("policy            | prov | resol | diag | interv | bytes  | class  | lost capabilities");
for (const [label, policy] of policies) {
  const w = historicWorld(60);
  const r = compactHistory(w, policy);
  const cls = classifyCheckpoint(w);
  const bytes = serializeCheckpoint(createCheckpoint(w)).length;
  console.log(
    `${label.padEnd(17)} | ${String(r.provenance.after).padStart(4)} | ${String(r.resolutions.after).padStart(5)} | ` +
      `${String(r.diagnostics.after).padStart(4)} | ${String(r.interventions.after).padStart(6)} | ${String(bytes).padStart(6)} | ` +
      `${cls.class.padEnd(6)} | ${cls.lost.map((l) => l.capability).join(", ") || "(none)"}`,
  );
}

// ---------------------------------------------------------------------------
section("§18.6 TRUNCATION: 'no cause' vs 'no evidence'");
// ---------------------------------------------------------------------------
const truncWorld = historicWorld(50);
const neverCaused = explain(truncWorld, key.unrest("PS"));
console.log(`quantity never caused : explained=${neverCaused.explained} incomplete=${neverCaused.incomplete} dangling=${neverCaused.danglingParents.length}`);

const damaged = structuredClone(truncWorld);
const refKey = key.price("RF", "grain");
const startId = damaged.provenanceRefs[refKey]!;
damaged.provenance = damaged.provenance.filter((n) => n.id !== startId);
damaged.historyTruncated = true;
const evidenceLost = explain(damaged, refKey);
console.log(`evidence discarded    : explained=${evidenceLost.explained} incomplete=${evidenceLost.incomplete} dangling=[${evidenceLost.danglingParents.join(", ")}]`);

const partial = structuredClone(truncWorld);
const node = partial.provenance.find((n) => n.id === partial.provenanceRefs[refKey])!;
partial.provenance = partial.provenance.filter((n) => n.id !== node.parents[0]);
partial.historyTruncated = true;
const partialEx = explain(partial, refKey);
console.log(`parent evicted        : explained=${partialEx.explained} incomplete=${partialEx.incomplete} dangling=[${partialEx.danglingParents.join(", ")}]`);
console.log("\n-> three DISTINGUISHABLE answers. An incomplete trace never looks like an absent cause.");

// ---------------------------------------------------------------------------
section("§18.9 BRANCHING AFTER COMPACTION");
// ---------------------------------------------------------------------------
const forkBase = historicWorld(50);
compactHistory(forkBase, recentWindowPolicy(4));
const cp = createCheckpoint(forkBase, "compact-fork");
console.log(`checkpoint class: ${classifyCheckpoint(forkBase).class}, truncated flag in identity: ${cp.identity.provenanceCheckpoint.truncated}`);

const bA = forkTimeline(cp, "a");
const bB = forkTimeline(cp, "b");
if (bA.ok && bB.ok) {
  submitIntervention(bA.value.world, iBridge("XA"), bA.value.engine);
  advance(bA.value.world, bA.value.engine, 15);
  submitIntervention(bB.value.world, iRally("YB"), bB.value.engine);
  advance(bB.value.world, bB.value.engine, 15);
  console.log(`branch A ${bA.value.timelineId} parent=${bA.value.world.lineage.parentTimelineId}`);
  console.log(`branch B ${bB.value.timelineId} parent=${bB.value.world.lineage.parentTimelineId}`);
  console.log(`states diverge: ${stateHash(bA.value.world) !== stateHash(bB.value.world)}`);
  console.log(`both still declare truncated history: ${bA.value.world.historyTruncated && bB.value.world.historyTruncated}`);
}

// ---------------------------------------------------------------------------
section("§18.11-18.12 SCHEMA MIGRATION v5 -> v6");
// ---------------------------------------------------------------------------
function downgradeToV5(world: WorldState): Record<string, unknown> {
  const raw = structuredClone(world) as unknown as Record<string, unknown>;
  const pending = raw.pendingContributions as Record<string, Record<string, Record<string, unknown>>>;
  for (const [regionId, buckets] of Object.entries(pending)) {
    for (const [domain, entry] of Object.entries(buckets)) {
      const causes = (world.pendingCauses[`${regionId}:${domain}`] ?? []).slice();
      entry.causes = causes;
      const items = entry.items as Array<Record<string, unknown>>;
      entry.items = items.map((it, i) => ({ ...it, cause: causes[i % Math.max(1, causes.length)] ?? "" }));
    }
  }
  delete raw.pendingCauses;
  raw.schemaVersion = 5;
  return raw;
}

const migrationSource = historicWorld(30);
const v5 = downgradeToV5(migrationSource);
const migrated = migrateWorld(v5);
if (migrated.ok) {
  console.log(`path: ${migrated.value.path.join(" -> ")} (current ${CURRENT_SCHEMA_VERSION})`);
  console.log(`completeness: ${migrated.value.completeness}`);
  for (const n of migrated.value.notes) {
    console.log(`  step v${n.fromVersion}->v${n.toVersion}: ${n.change} lossy=${n.lossy} ${JSON.stringify(n.detail ?? {})}`);
  }
  console.log(`stateHash preserved: ${stateHash(migrated.value.world) === stateHash(migrationSource)}`);
  console.log(`provenance node count unchanged (nothing forged): ${migrated.value.world.provenance.length === migrationSource.provenance.length}`);
  console.log(`forward evolution unchanged: ${stateHash(forward(migrated.value.world, 20)) === stateHash(forward(migrationSource, 20))}`);
}

console.log("\nrefusals:");
for (const [label, payload] of [
  ["schemaVersion 1 (too old)", { ...(structuredClone(migrationSource) as unknown as Record<string, unknown>), schemaVersion: 1 }],
  ["schemaVersion 99 (future)", { ...(structuredClone(migrationSource) as unknown as Record<string, unknown>), schemaVersion: 99 }],
  ["missing schemaVersion", {}],
  ["non-object", null],
] as Array<[string, unknown]>) {
  const r = migrateWorld(payload);
  console.log(`  ${label.padEnd(26)} -> ${r.ok ? "ACCEPTED (bug!)" : r.errors.map((e) => e.code).join(", ")}`);
}

// ---------------------------------------------------------------------------
section("§18.15 PERFORMANCE BASELINE AFTER LIFECYCLE");
// ---------------------------------------------------------------------------
const perfFull = historicWorld(120);
const perfCompact = structuredClone(perfFull);
compactHistory(perfCompact, recentWindowPolicy(10));
const perfResume = structuredClone(perfFull);
compactHistory(perfResume, RESUME_ONLY);

const fullEnv = createCheckpoint(perfFull);
const compactEnv = createCheckpoint(perfCompact);
const resumeEnv = createCheckpoint(perfResume);
const fullText = serializeCheckpoint(fullEnv);
const compactText = serializeCheckpoint(compactEnv);
const resumeText = serializeCheckpoint(resumeEnv);

console.log("artefact        | provenance | bytes  | vs full | class");
console.log(`full            | ${String(perfFull.provenance.length).padStart(10)} | ${String(fullText.length).padStart(6)} |   100%  | ${classifyCheckpoint(perfFull).class}`);
console.log(`compact(10)     | ${String(perfCompact.provenance.length).padStart(10)} | ${String(compactText.length).padStart(6)} | ${f((compactText.length / fullText.length) * 100, 1).padStart(6)}% | ${classifyCheckpoint(perfCompact).class}`);
console.log(`resume-only     | ${String(perfResume.provenance.length).padStart(10)} | ${String(resumeText.length).padStart(6)} | ${f((resumeText.length / fullText.length) * 100, 1).padStart(6)}% | ${classifyCheckpoint(perfResume).class}`);

const v5Payload = downgradeToV5(perfFull);
const parsedFull = deserializeCheckpoint(fullText);

console.log("\noperation                                  | median ms");
const rows: Array<[string, number]> = [
  ["compactHistory (recentWindow 10)", timeIt(30, () => { const w = structuredClone(perfFull); compactHistory(w, recentWindowPolicy(10)); })],
  ["compactHistory (RESUME_ONLY)", timeIt(30, () => { const w = structuredClone(perfFull); compactHistory(w, RESUME_ONLY); })],
  ["classifyCheckpoint", timeIt(30, () => void classifyCheckpoint(perfFull))],
  ["createCheckpoint (full)", timeIt(30, () => void createCheckpoint(perfFull))],
  ["createCheckpoint (compact)", timeIt(30, () => void createCheckpoint(perfCompact))],
  ["serializeCheckpoint (full)", timeIt(30, () => void serializeCheckpoint(fullEnv))],
  ["serializeCheckpoint (compact)", timeIt(30, () => void serializeCheckpoint(compactEnv))],
  ["deserializeCheckpoint (full)", timeIt(30, () => void deserializeCheckpoint(fullText))],
  ["migrateWorld (v5 -> v6)", timeIt(30, () => void migrateWorld(structuredClone(v5Payload)))],
  ["traceHash (full)", timeIt(30, () => void traceHash(perfFull))],
  ["traceHash (compact)", timeIt(30, () => void traceHash(perfCompact))],
  ["stateHash", timeIt(30, () => void stateHash(perfFull))],
  ["advance 1 tick (for scale)", timeIt(30, () => { const w = structuredClone(perfFull); advance(w, attachEngine(w, createEngine()), 1); })],
];
for (const [label, ms] of rows) console.log(`${label.padEnd(42)} | ${f(ms, 3).padStart(9)}`);

if (parsedFull.ok) {
  const dir = mkdtempSync(join(tmpdir(), "ce-lc-"));
  try {
    writeFileSync(join(dir, "full.json"), fullText, "utf8");
    writeFileSync(join(dir, "compact.json"), compactText, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\nobservations (NOT acted on):");
console.log("  * compaction is a STORAGE-layer win, not an architectural change: the same");
console.log("    envelope, the same validation, the same resume path.");
console.log("  * traceHash cost tracks retained history, so compaction reduces hashing cost too.");
console.log("  * RESUME_ONLY is the floor: whatever remains is the minimum resumable artefact.");
