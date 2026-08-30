import {
  askWhy,
  diff,
  differingFields,
  iBridge,
  iMerchant,
  iRally,
  iShrine,
  iWarehouse,
  observe,
  run,
  rootCauseIds,
  type Observation,
  type ScheduledIntervention,
} from "./harness.js";
import { key } from "../core/provenance.js";

/**
 * Multi-intervention causality stress test — reporting driver (Experiments A–G).
 * Run: npx tsx src/poc/stress.ts
 *
 * This prints evidence. The assertions live in stress.test.ts; this file exists so the
 * numbers behind the report can be regenerated and inspected.
 */

const HORIZON = 40;
const T = 10; // intervention tick

function f(n: number, d = 2): string {
  return n.toFixed(d);
}

function row(label: string, o: Observation): string {
  return (
    `${label.padEnd(26)} | cap ${f(o.tradeCapacity, 1)} | vol ${f(o.tradeVolume, 1).padStart(4)} | ` +
    `RFstock ${f(o.rfGrainStock).padStart(6)} | RFprice ${f(o.rfGrainPrice).padStart(6)} | ` +
    `resv ${f(o.warehouseReserve).padStart(5)} | inc ${f(o.mgIncomeRate)} | host ${f(o.mgHostility)} | ` +
    `patrol ${f(o.rfPatrolDemand)} | unrest ${f(o.rfUnrest)} | fired ${String(o.resolutionsFired).padStart(2)}`
  );
}

function section(title: string): void {
  console.log(`\n${"=".repeat(100)}\n${title}\n${"=".repeat(100)}`);
}

// ---------------------------------------------------------------------------
section("EXPERIMENT A — interventions individually, then together");
// ---------------------------------------------------------------------------

const control = run({ label: "control (nothing)", schedule: [], totalTicks: HORIZON });

const individual = {
  bridge: run({ label: "bridge only", schedule: [{ atTick: T, intervention: iBridge() }], totalTicks: HORIZON }),
  merchant: run({ label: "merchant only", schedule: [{ atTick: T, intervention: iMerchant() }], totalTicks: HORIZON }),
  warehouse: run({ label: "warehouse only", schedule: [{ atTick: T, intervention: iWarehouse() }], totalTicks: HORIZON }),
  rally: run({ label: "rally only (civic)", schedule: [{ atTick: T, intervention: iRally() }], totalTicks: HORIZON }),
  shrine: run({ label: "shrine destroyed (civic)", schedule: [{ atTick: T, intervention: iShrine() }], totalTicks: HORIZON }),
};

const allTogether = run({
  label: "all four, same tick",
  schedule: [
    { atTick: T, intervention: iBridge() },
    { atTick: T, intervention: iMerchant() },
    { atTick: T, intervention: iWarehouse() },
    { atTick: T, intervention: iRally() },
  ],
  totalTicks: HORIZON,
});

console.log(row("control", control.final));
for (const r of Object.values(individual)) console.log(row(r.label, r.final));
console.log(row(allTogether.label, allTogether.final));

console.log("\nfields changed vs control (AT THE HORIZON, tick 40):");
for (const r of [...Object.values(individual), allTogether]) {
  console.log(`  ${r.label.padEnd(26)} -> ${differingFields(control.final, r.final).join(", ") || "(none)"}`);
}

console.log("\nNOTE: the civic runs show '(none)' at the horizon because unrest decays to zero");
console.log("well before tick 40. Transient effects require trajectory peaks, not endpoints:");
console.log("run                        | peak unrest | peak patrol | peak price | peak hostility | starves");
for (const r of [control, ...Object.values(individual), allTogether]) {
  const s = r.summary;
  console.log(
    `${r.label.padEnd(26)} | ${f(s.peakUnrest).padStart(11)} | ${f(s.peakPatrolDemand).padStart(11)} | ` +
      `${f(s.peakRFPrice).padStart(10)} | ${f(s.peakHostility).padStart(14)} | ${s.starvationTick ?? "never"}`,
  );
}

// ---------------------------------------------------------------------------
section("EXPERIMENT B — composition: bridge + warehouse vs each alone");
// ---------------------------------------------------------------------------

const both = run({
  label: "bridge + warehouse",
  schedule: [
    { atTick: T, intervention: iBridge() },
    { atTick: T, intervention: iWarehouse() },
  ],
  totalTicks: HORIZON,
});

const bridgeOnly = individual.bridge.final;
const warehouseOnly = individual.warehouse.final;
const c = control.final;

console.log(row("control", c));
console.log(row("bridge only", bridgeOnly));
console.log(row("warehouse only", warehouseOnly));
console.log(row("bridge + warehouse", both.final));

console.log("\nFINAL-STATE comparison is misleading here. At the horizon, bridge-only and");
console.log("bridge+warehouse look identical (both starved, price clamped). The composition");
console.log("lives in the TRAJECTORY — how fast and how hard the town fails:\n");

console.log("trajectory            |  bridge  | warehouse | combined | interpretation");
const tb = individual.bridge.summary;
const tw = individual.warehouse.summary;
const tc = both.summary;
const tctl = control.summary;
const line = (name: string, a: number | null, b: number | null, d: number | null, note: string) =>
  console.log(
    `${name.padEnd(21)} | ${String(a ?? "never").padStart(8)} | ${String(b ?? "never").padStart(9)} | ${String(d ?? "never").padStart(8)} | ${note}`,
  );
line("starvation tick", tb.starvationTick, tw.starvationTick, tc.starvationTick, "combined starves far earlier");
line("min RF stock", Number(tb.minRFStock.toFixed(2)), Number(tw.minRFStock.toFixed(2)), Number(tc.minRFStock.toFixed(2)), "");
line("peak RF price", Number(tb.peakRFPrice.toFixed(2)), Number(tw.peakRFPrice.toFixed(2)), Number(tc.peakRFPrice.toFixed(2)), "");
line("total MG income", Number(tb.totalMGIncome.toFixed(2)), Number(tw.totalMGIncome.toFixed(2)), Number(tc.totalMGIncome.toFixed(2)), `control ${tctl.totalMGIncome.toFixed(2)}`);
line("peak patrol demand", Number(tb.peakPatrolDemand.toFixed(2)), Number(tw.peakPatrolDemand.toFixed(2)), Number(tc.peakPatrolDemand.toFixed(2)), "");
line("resolutions fired", tb.resolutionsFired, tw.resolutionsFired, tc.resolutionsFired, "");

console.log("\nadditivity on the trajectory measure that matters (starvation onset):");
const bridgeDelay = (tb.starvationTick ?? HORIZON) - T;
const warehouseDelay = (tw.starvationTick ?? HORIZON) - T;
const combinedDelay = (tc.starvationTick ?? HORIZON) - T;
console.log(`  bridge alone starves ${bridgeDelay} ticks after intervention`);
console.log(`  warehouse alone starves ${tw.starvationTick === null ? "never (economy intact)" : `${warehouseDelay} ticks after`}`);
console.log(`  combined starves ${combinedDelay} ticks after`);
console.log(
  `  -> the warehouse only matters BECAUSE the bridge is gone: alone it is nearly inert\n` +
    `     (stock ${tw.minRFStock.toFixed(2)}, price ${tw.peakRFPrice.toFixed(2)}), but it removes ${bridgeDelay - combinedDelay} ticks of buffer\n` +
    `     from the bridge scenario. No rule mentions both actions; the granary's release\n` +
    `     condition (stock below target) is simply never met while trade flows.`,
);

console.log("\nadditivity table on final state (for completeness — shows why endpoints mislead):");
console.log("metric              |   control |    bridge | warehouse |  combined | additive-pred | superadditive?");
const metricsOfInterest = [
  "tradeCapacity",
  "tradeVolume",
  "rfGrainStock",
  "rfGrainPrice",
  "warehouseReserve",
  "mgIncomeRate",
  "mgHostility",
  "rfPatrolDemand",
] as const;
for (const m of metricsOfInterest) {
  const cv = Number(c[m]);
  const bv = Number(bridgeOnly[m]);
  const wv = Number(warehouseOnly[m]);
  const combined = Number(both.final[m]);
  const additive = cv + (bv - cv) + (wv - cv);
  const superadd = Math.abs(combined - additive) > 1e-6;
  console.log(
    `${m.padEnd(19)} | ${f(cv).padStart(9)} | ${f(bv).padStart(9)} | ${f(wv).padStart(9)} | ${f(combined).padStart(9)} | ${f(additive).padStart(13)} | ${superadd ? "YES" : "no"}`,
  );
}

console.log("\ngrain stock trajectory (RF) — bridge vs bridge+warehouse:");
for (const t of [T - 1, T, T + 1, T + 2, T + 4, T + 6, T + 10, HORIZON]) {
  const a = individual.bridge.series[t - 1];
  const b = both.series[t - 1];
  const w = individual.warehouse.series[t - 1];
  if (!a || !b || !w) continue;
  console.log(
    `  t${String(t).padStart(2)} bridge ${f(a.rfGrainStock).padStart(6)} (resv ${f(a.warehouseReserve).padStart(5)}) | ` +
      `warehouse ${f(w.rfGrainStock).padStart(6)} | both ${f(b.rfGrainStock).padStart(6)} | price both ${f(b.rfGrainPrice)}`,
  );
}

// ---------------------------------------------------------------------------
section("EXPERIMENT C — order dependence");
// ---------------------------------------------------------------------------

type Kind = "bridge" | "merchant" | "warehouse";
const mk = (k: Kind, id: string) =>
  k === "bridge" ? iBridge(id) : k === "merchant" ? iMerchant(id) : iWarehouse(id);

function orderedRun(order: Kind[], gap: number, label: string): ReturnType<typeof run> {
  const schedule: ScheduledIntervention[] = order.map((k, idx) => ({
    atTick: T + idx * gap,
    intervention: mk(k, `i-${k}`),
  }));
  return run({ label, schedule, totalTicks: HORIZON });
}

const fwdSpread = orderedRun(["bridge", "merchant", "warehouse"], 1, "A->B->C (1 tick apart)");
const revSpread = orderedRun(["warehouse", "merchant", "bridge"], 1, "C->B->A (1 tick apart)");
const fwdSame = run({
  label: "A->B->C (same tick)",
  schedule: [
    { atTick: T, intervention: iBridge("i-bridge") },
    { atTick: T, intervention: iMerchant("i-merchant") },
    { atTick: T, intervention: iWarehouse("i-warehouse") },
  ],
  totalTicks: HORIZON,
});
const revSame = run({
  label: "C->B->A (same tick)",
  schedule: [
    { atTick: T, intervention: iWarehouse("i-warehouse") },
    { atTick: T, intervention: iMerchant("i-merchant") },
    { atTick: T, intervention: iBridge("i-bridge") },
  ],
  totalTicks: HORIZON,
});

console.log(row(fwdSpread.label, fwdSpread.final));
console.log(row(revSpread.label, revSpread.final));
console.log(row(fwdSame.label, fwdSame.final));
console.log(row(revSame.label, revSame.final));

console.log("\nspread across ticks — fields differing between A->B->C and C->B->A:");
const spreadDiffs = differingFields(fwdSpread.final, revSpread.final);
console.log(`  ${spreadDiffs.join(", ") || "(none — order independent)"}`);
for (const d of diff(fwdSpread.final, revSpread.final).filter((x) => x.differs)) {
  console.log(`    ${d.field.padEnd(18)} fwd ${f(Number(d.a))} vs rev ${f(Number(d.b))} (delta ${f(d.delta)})`);
}

console.log("\nsame tick — fields differing between A->B->C and C->B->A:");
const sameDiffs = differingFields(fwdSame.final, revSame.final);
console.log(`  ${sameDiffs.join(", ") || "(none — order independent within a tick)"}`);
for (const d of diff(fwdSame.final, revSame.final).filter((x) => x.differs)) {
  console.log(`    ${d.field.padEnd(18)} fwd ${f(Number(d.a))} vs rev ${f(Number(d.b))} (delta ${f(d.delta)})`);
}

console.log("\nstate hashes:");
console.log(`  spread fwd ${fwdSpread.final.stateHash.slice(0, 16)}  rev ${revSpread.final.stateHash.slice(0, 16)}  equal=${fwdSpread.final.stateHash === revSpread.final.stateHash}`);
console.log(`  same   fwd ${fwdSame.final.stateHash.slice(0, 16)}  rev ${revSame.final.stateHash.slice(0, 16)}  equal=${fwdSame.final.stateHash === revSame.final.stateHash}`);
console.log("trace hashes (causal history — may differ even when state matches):");
console.log(`  same   fwd ${fwdSame.final.traceHash.slice(0, 16)}  rev ${revSame.final.traceHash.slice(0, 16)}  equal=${fwdSame.final.traceHash === revSame.final.traceHash}`);

// tick-boundary sensitivity: same order, different spacing
const gap0 = fwdSame.final;
const gap1 = fwdSpread.final;
const gap5 = orderedRun(["bridge", "merchant", "warehouse"], 5, "A->B->C (5 ticks apart)").final;
console.log("\ntick-boundary sensitivity (same order, different spacing):");
console.log(row("gap 0 (same tick)", gap0));
console.log(row("gap 1", gap1));
console.log(row("gap 5", gap5));
console.log(`  gap0 vs gap1 differ in: ${differingFields(gap0, gap1).join(", ") || "(none)"}`);
console.log(`  gap1 vs gap5 differ in: ${differingFields(gap1, gap5).join(", ") || "(none)"}`);

// ---------------------------------------------------------------------------
section("EXPERIMENT D — same-tick batching determinism");
// ---------------------------------------------------------------------------

const batchA = run({
  label: "batch order 1 (canonical)",
  schedule: [
    { atTick: T, intervention: iBridge("i-bridge") },
    { atTick: T, intervention: iMerchant("i-merchant") },
    { atTick: T, intervention: iWarehouse("i-warehouse") },
  ],
  totalTicks: HORIZON,
  canonicalBatch: true,
});
const batchB = run({
  label: "batch order 2 (canonical)",
  schedule: [
    { atTick: T, intervention: iWarehouse("i-warehouse") },
    { atTick: T, intervention: iBridge("i-bridge") },
    { atTick: T, intervention: iMerchant("i-merchant") },
  ],
  totalTicks: HORIZON,
  canonicalBatch: true,
});

console.log(row(batchA.label, batchA.final));
console.log(row(batchB.label, batchB.final));
console.log(`\ncanonical batching, different arrival order:`);
console.log(`  stateHash equal = ${batchA.final.stateHash === batchB.final.stateHash}`);
console.log(`  traceHash equal = ${batchA.final.traceHash === batchB.final.traceHash}`);
console.log(`  differing fields: ${differingFields(batchA.final, batchB.final).join(", ") || "(none)"}`);

console.log("\nsubmission sequence numbers assigned (canonical run A):");
for (const i of batchA.engine.accepted) {
  console.log(`  seq ${i.provenance.sequence} <- ${i.id} (${i.action}) at tick ${i.tick}`);
}

// ---------------------------------------------------------------------------
section("EXPERIMENT E — causal provenance for the combined case");
// ---------------------------------------------------------------------------

const combined = run({
  label: "bridge + merchant + warehouse + rally",
  schedule: [
    { atTick: T, intervention: iBridge() },
    { atTick: T, intervention: iMerchant() },
    { atTick: T, intervention: iWarehouse() },
    { atTick: T, intervention: iRally() },
  ],
  totalTicks: 25,
});

for (const q of askWhy(combined.state)) {
  console.log(`\n${q.question}`);
  console.log(`  quantity: ${q.quantity}  explained: ${q.explanation.explained}`);
  console.log(`  root causes (${q.explanation.roots.length}):`);
  for (const r of q.explanation.roots) {
    console.log(`    - ${r.interventionId} (${r.action} on ${r.targetId} @${r.location}, tick ${r.tick})`);
  }
  console.log(`  ancestor chain sample:`);
  for (const path of q.explanation.paths.slice(0, 4)) {
    console.log(`    ${path.join(" <- ")}`);
  }
  console.log(`  nodes in subgraph: ${q.explanation.nodes.length}`);
}

console.log("\nmulti-parent check — hostility should have >1 contributing intervention:");
console.log(`  hostility roots: ${rootCauseIds(combined.state, key.hostility("MG")).join(", ")}`);
console.log(`  price roots:     ${rootCauseIds(combined.state, key.price("RF", "grain")).join(", ")}`);
console.log(`  patrol roots:    ${rootCauseIds(combined.state, key.patrolDemand("RF")).join(", ")}`);
console.log(`  unrest roots:    ${rootCauseIds(combined.state, key.unrest("RF")).join(", ")}`);

// ---------------------------------------------------------------------------
section("EXPERIMENT F — negative isolation (civic must not reach the economy)");
// ---------------------------------------------------------------------------

const civicOnly = run({
  label: "rally only",
  schedule: [{ atTick: T, intervention: iRally() }],
  totalTicks: HORIZON,
});
const shrineOnly = individual.shrine;

console.log(row("control", control.final));
console.log(row("rally only", civicOnly.final));
console.log(row("shrine destroyed", shrineOnly.final));

const economicFields = ["tradeCapacity", "tradeVolume", "rfGrainStock", "rfGrainPrice", "htGrainPrice", "psGrainPrice", "warehouseReserve", "mgIncomeRate", "mgTreasury"] as const;
for (const [label, r] of [["rally", civicOnly], ["shrine", shrineOnly]] as const) {
  // Compare across the WHOLE trajectory, not just the endpoint: an economic leak that
  // appeared and decayed would be invisible at the horizon.
  const leakedEver = economicFields.filter((fld) =>
    r.series.some((o, idx) => Math.abs(Number(o[fld]) - Number(control.series[idx]![fld])) > 1e-9),
  );
  console.log(`\n${label}: economic fields that EVER differed from control -> ${leakedEver.join(", ") || "(NONE — isolation holds across all 40 ticks)"}`);
  console.log(
    `  civic effect did occur: peak unrest ${f(r.summary.peakUnrest)} (control ${f(control.summary.peakUnrest)}), ` +
      `peak patrol ${f(r.summary.peakPatrolDemand)} (control ${f(control.summary.peakPatrolDemand)})`,
  );
  console.log(`  price provenance roots:  ${rootCauseIds(r.state, key.price("RF", "grain")).join(", ") || "(none)"}`);
  console.log(`  income provenance roots: ${rootCauseIds(r.state, key.income("MG")).join(", ") || "(none)"}`);
  console.log(`  unrest provenance roots: ${rootCauseIds(r.state, key.unrest("RF")).join(", ") || "(none)"}`);
  const fired = r.state.resolutionLog.filter((d) => d.fired);
  console.log(`  domains that resolved:   ${[...new Set(fired.map((d) => d.domain))].sort().join(", ") || "(none)"}`);
}

// ---------------------------------------------------------------------------
section("EXPERIMENT G — deterministic replay of a multi-intervention sequence");
// ---------------------------------------------------------------------------

function replay(): ReturnType<typeof run> {
  return run({
    label: "replay",
    schedule: [
      { atTick: 8, intervention: iBridge() },
      { atTick: 10, intervention: iMerchant() },
      { atTick: 10, intervention: iRally() },
      { atTick: 13, intervention: iWarehouse() },
    ],
    totalTicks: 35,
  });
}

const replays = [replay(), replay(), replay(), replay(), replay()];
const hashes = replays.map((r) => r.final.stateHash);
const traces = replays.map((r) => r.final.traceHash);
const decisionSigs = replays.map((r) =>
  r.state.resolutionLog.map((d) => `${d.tick}:${d.regionId}:${d.domain}:${d.fired ? 1 : 0}:${d.pressure.toFixed(9)}`).join("|"),
);

console.log(`runs: ${replays.length}`);
console.log(`stateHash all equal:      ${new Set(hashes).size === 1}  (${hashes[0]?.slice(0, 24)})`);
console.log(`traceHash all equal:      ${new Set(traces).size === 1}  (${traces[0]?.slice(0, 24)})`);
console.log(`resolution decisions equal: ${new Set(decisionSigs).size === 1}  (${replays[0]?.state.resolutionLog.length} decisions logged)`);
console.log(`provenance node counts:   ${replays.map((r) => r.state.provenance.length).join(", ")}`);

const firedCount = replays[0]?.state.resolutionLog.filter((d) => d.fired).length ?? 0;
const notFired = (replays[0]?.state.resolutionLog.length ?? 0) - firedCount;
console.log(`resolution decisions: ${firedCount} fired, ${notFired} checked-but-below-threshold`);

// ---------------------------------------------------------------------------
section("QUOTA BEHAVIOUR SUMMARY");
// ---------------------------------------------------------------------------

for (const r of [individual.bridge, individual.merchant, individual.warehouse, individual.rally, allTogether]) {
  const fired = r.state.resolutionLog.filter((d) => d.fired);
  const byDomain = new Map<string, number>();
  for (const d of fired) byDomain.set(d.domain, (byDomain.get(d.domain) ?? 0) + 1);
  console.log(
    `${r.label.padEnd(26)} checks ${String(r.state.resolutionLog.length).padStart(3)} | fired ${String(fired.length).padStart(2)} | ` +
      `${[...byDomain.entries()].sort().map(([d, n]) => `${d}:${n}`).join(" ") || "(none)"}`,
  );
}
