import {
  iBridge,
  iMerchant,
  iRally,
  iSubsidy,
  iWarehouse,
  run,
  type Observation,
  type RunResult,
} from "./harness.js";
import { uniformThresholds } from "../core/config.js";
import { isTrueConvergence } from "../core/dynamics.js";
import { explain, key } from "../core/provenance.js";

/**
 * Feedback & convergence evidence driver (docs/RECONNAISSANCE.md §16).
 * Run: npx tsx src/poc/feedback.ts
 *
 * Prints the numbers behind the report. Assertions live in feedback.test.ts.
 */

const T = 10;
const f = (n: number, d = 2) => n.toFixed(d);
const section = (t: string) => console.log(`\n${"=".repeat(100)}\n${t}\n${"=".repeat(100)}`);

function loop(overrides: Parameters<typeof run>[0]["configOverrides"] = undefined, ticks = 160): RunResult {
  return run({
    label: "bridge+granary",
    schedule: [
      { atTick: T, intervention: iBridge() },
      { atTick: T, intervention: iWarehouse() },
    ],
    totalTicks: ticks,
    ...(overrides ? { configOverrides: overrides } : {}),
  });
}

function summarise(r: RunResult): string {
  const s = r.summary;
  return (
    `starve ${String(s.starvationTick ?? "never").padStart(6)} | peakPrice ${f(s.peakRFPrice).padStart(7)} | ` +
    `minStock ${f(s.minRFStock).padStart(6)} | HTinv ${f(s.minHTInvestment)}..${f(s.maxHTInvestment)} | ` +
    `fired ${String(s.resolutionsFired).padStart(3)} | diag ${String(s.finalDiagnosticCount).padStart(3)}`
  );
}

// ---------------------------------------------------------------------------
section("§16.1 THE FEEDBACK LOOP — baseline is an exact fixed point");
// ---------------------------------------------------------------------------
const quiet = run({ label: "no intervention", schedule: [], totalTicks: 400 });
console.log(`control @t400: price ${f(quiet.final.rfGrainPrice, 9)} stock ${f(quiet.final.rfGrainStock, 9)}`);
console.log(`HT investment ${f(quiet.final.htTradeInvestment, 9)}  profitability ${f(quiet.final.htProfitability, 9)}`);
console.log(`diagnostics ${quiet.state.diagnostics.length}  resolutions fired ${quiet.summary.resolutionsFired}`);
console.log("-> a world at rest sits ON the loop's fixed point; no drift, no invented anomalies");

const loopRun = loop();
console.log("\nloop engaged (bridge + granary destroyed at t10):");
console.log(`  ${summarise(loopRun)}`);
console.log("\n  price / investment / stock trajectory:");
for (const o of loopRun.series.filter((x) => x.tick % 10 === 0 || (x.tick >= 10 && x.tick <= 16))) {
  console.log(
    `    t${String(o.tick).padStart(3)} price ${f(o.rfGrainPrice).padStart(6)} stock ${f(o.rfGrainStock).padStart(6)} ` +
      `HTinv ${f(o.htTradeInvestment, 3)} profit ${f(o.htProfitability, 3).padStart(7)} vol ${f(o.tradeVolume, 1)}`,
  );
}

// ---------------------------------------------------------------------------
section("§16.2–16.4 CONVERGENCE CLASSIFICATION");
// ---------------------------------------------------------------------------
console.log("signal                    classification        @tick  stable alt  growth  divergedEver");
for (const [name, t] of Object.entries(loopRun.state.dynamics).sort(([a], [b]) => (a < b ? -1 : 1))) {
  console.log(
    `${name.padEnd(25)} ${t.classification.padEnd(21)} ${String(t.classifiedAtTick).padStart(5)}  ` +
      `${String(t.stableCount).padStart(6)} ${String(t.alternations).padStart(3)}  ${f(t.growth, 3).padStart(6)}  ${t.divergedEver}`,
  );
}
const trueConv = Object.values(loopRun.state.dynamics).filter((t) => isTrueConvergence(t.classification)).length;
const atBound = Object.values(loopRun.state.dynamics).filter((t) => t.classification === "converged_at_bound").length;
console.log(`\ntruly converged: ${trueConv}   stable only at a clamp: ${atBound}`);
console.log("-> 'price pinned at the ceiling' is NOT reported as convergence");

// ---------------------------------------------------------------------------
section("§16.4 COMPETING CAUSES — granary destroyed vs merchant subsidy, same epoch");
// ---------------------------------------------------------------------------
const competing = {
  granary: run({ label: "granary only", schedule: [{ atTick: T, intervention: iWarehouse("w") }], totalTicks: 100 }),
  subsidy: run({ label: "subsidy only", schedule: [{ atTick: T, intervention: iSubsidy("s") }], totalTicks: 100 }),
  wThenS: run({
    label: "granary then subsidy",
    schedule: [
      { atTick: T, intervention: iWarehouse("w") },
      { atTick: T, intervention: iSubsidy("s") },
    ],
    totalTicks: 100,
  }),
  sThenW: run({
    label: "subsidy then granary",
    schedule: [
      { atTick: T, intervention: iSubsidy("s") },
      { atTick: T, intervention: iWarehouse("w") },
    ],
    totalTicks: 100,
  }),
};
for (const r of Object.values(competing)) {
  const contested = r.state.resolutionLog.filter((d) => d.contested).length;
  console.log(`${r.label.padEnd(22)} ${summarise(r)} | contested ${contested} | hash ${r.final.stateHash.slice(0, 10)}`);
}
console.log(
  `\nsame-tick order independence: ${competing.wThenS.final.stateHash === competing.sThenW.final.stateHash ? "IDENTICAL state hash" : "DIFFERENT — bug"}`,
);
console.log("relief changes the outcome:");
console.log(`  granary alone starves at t${competing.granary.summary.starvationTick}`);
console.log(`  granary + subsidy starves: ${competing.wThenS.summary.starvationTick ?? "never"}`);

const contestDiag = competing.wThenS.state.diagnostics.filter((d) => d.kind === "contested_resolution");
console.log(`\ncontested_resolution diagnostics: ${contestDiag.length}`);
for (const d of contestDiag.slice(0, 3)) {
  console.log(
    `  t${d.tick} ${d.regionId} ${d.domain}: negative ${f(Number(d.detail.negativePressure))} vs positive ${f(Number(d.detail.positivePressure))}, net ${f(Number(d.detail.netValence), 6)}`,
  );
}
console.log("-> salience ADDS (so the domain still resolves), direction NETS (so relief actually offsets)");

// ---------------------------------------------------------------------------
section("§16.6 DECAY UNDER FEEDBACK — minimal regime sweep");
// ---------------------------------------------------------------------------
console.log("decay | fired | maxGen | genNodes | ledgersDrained | starve | diagnostics");
for (const decay of [0.6, 0.7, 0.8, 0.9, 0.95, 0.99]) {
  const r = loop({ seed: 42, ledgerDecayPerTick: decay });
  const fired = r.state.resolutionLog.filter((d) => d.fired);
  const drained = Object.values(r.state.regions).every((x) => Object.keys(x.ledger).length === 0);
  const counts: Record<string, number> = {};
  for (const d of r.state.diagnostics) counts[d.kind] = (counts[d.kind] ?? 0) + 1;
  console.log(
    `${f(decay).padStart(5)} | ${String(fired.length).padStart(5)} | ${String(Math.max(0, ...fired.map((d) => d.generation))).padStart(6)} | ` +
      `${String(r.state.provenance.filter((n) => n.label === "economy_pressure_generated").length).padStart(8)} | ` +
      `${String(drained).padStart(14)} | ${String(r.summary.starvationTick ?? "never").padStart(6)} | ${JSON.stringify(counts)}`,
  );
}
console.log("\n-> regimes: decay <= 0.95 drains; 0.99 PERSISTS (pressure never fully clears).");
console.log("   Work stays bounded in every regime; the persistent regime is visible, not silent.");

// ---------------------------------------------------------------------------
section("§16.7 CROSS-REGION CAUSAL CYCLES — inherited vs newly generated");
// ---------------------------------------------------------------------------
console.log("fired resolutions with origin + generation:");
for (const d of loopRun.state.resolutionLog.filter((x) => x.fired)) {
  console.log(
    `  t${String(d.tick).padStart(3)} ${d.regionId} ${d.domain.padEnd(8)} p=${f(d.pressure, 3)} origin=${d.origin.padEnd(9)} gen=${d.generation} net=${f(d.netValence, 2).padStart(6)} contested=${d.contested}`,
  );
}
const sigs = loopRun.state.events.filter((e) => e.type === "world.boundary_signal");
const byOrigin: Record<string, number> = {};
for (const s of sigs) byOrigin[String(s.data.origin)] = (byOrigin[String(s.data.origin)] ?? 0) + 1;
console.log(`\nboundary signals by origin: ${JSON.stringify(byOrigin)} (total ${sigs.length})`);
console.log("-> `boundary` (inherited) NEVER appears as a signal source: inherited pressure cannot relay.");
console.log("   `generated` DOES: a real state transition is new causality and is allowed to propagate.");

console.log("\ngeneration bound under aggressive recurrence settings:");
for (const maxGen of [1, 3, 6]) {
  const r = loop({ seed: 42, thresholds: uniformThresholds(0.3), generationMateriality: 0.02, maxCausalGeneration: maxGen });
  const fired = r.state.resolutionLog.filter((d) => d.fired);
  const cutoffs = r.state.diagnostics.filter((d) => d.kind === "recurrence_cutoff").length;
  console.log(
    `  maxCausalGeneration=${maxGen}: fired ${String(fired.length).padStart(3)} observedMaxGen ${Math.max(0, ...fired.map((d) => d.generation))} recurrence_cutoff diagnostics ${cutoffs}`,
  );
}
console.log("-> the bound is the limiter, and hitting it is REPORTED as a computational cutoff.");

// ---------------------------------------------------------------------------
section("§16.8 CAUSAL TRACE — what caused the second iteration?");
// ---------------------------------------------------------------------------
const genNodes = loopRun.state.provenance.filter((n) => n.label === "economy_pressure_generated");
console.log(`generated-pressure nodes: ${genNodes.length}`);
for (const n of genNodes) {
  console.log(
    `  t${n.tick} ${n.regionId} generation=${n.detail?.generation} transition=${n.detail?.transition} value=${f(n.value ?? 0, 4)}`,
  );
}
const inv = explain(loopRun.state, key.investment("HT"));
console.log(`\nwhy did HT trade investment change? roots: ${inv.roots.map((r) => r.interventionId).join(", ")}`);
for (const p of inv.paths.slice(0, 4)) console.log(`  ${p.join(" <- ")}`);

// ---------------------------------------------------------------------------
section("§16.9 DETERMINISM UNDER CONVERGENCE — 5 replays");
// ---------------------------------------------------------------------------
const replay = () =>
  run({
    label: "replay",
    schedule: [
      { atTick: 8, intervention: iBridge() },
      { atTick: 10, intervention: iWarehouse() },
      { atTick: 10, intervention: iRally() },
      { atTick: 16, intervention: iSubsidy() },
      { atTick: 22, intervention: iMerchant() },
    ],
    totalTicks: 140,
  });
const replays = [replay(), replay(), replay(), replay(), replay()];
const classSig = (r: RunResult) =>
  Object.entries(r.state.dynamics)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v.classification}@${v.classifiedAtTick}`)
    .join("|");
const decisionSig = (r: RunResult) =>
  r.state.resolutionLog
    .map((d) => `${d.tick}:${d.regionId}:${d.domain}:${d.fired ? 1 : 0}:${d.origin}:${d.generation}:${d.pressure.toFixed(15)}`)
    .join("|");
const diagSig = (r: RunResult) => r.state.diagnostics.map((d) => `${d.tick}:${d.kind}:${d.signal ?? d.domain ?? ""}`).join("|");
const seriesEqual = replays.every((r) => JSON.stringify(r.series) === JSON.stringify(replays[0]!.series));

console.log(`runs: ${replays.length}`);
console.log(`stateHash identical:              ${new Set(replays.map((r) => r.final.stateHash)).size === 1}  (${replays[0]!.final.stateHash.slice(0, 24)})`);
console.log(`traceHash identical:              ${new Set(replays.map((r) => r.final.traceHash)).size === 1}  (${replays[0]!.final.traceHash.slice(0, 24)})`);
console.log(`per-tick series identical:        ${seriesEqual}`);
console.log(`resolution decisions identical:   ${new Set(replays.map(decisionSig)).size === 1}  (${replays[0]!.state.resolutionLog.length} decisions)`);
console.log(`convergence classes identical:    ${new Set(replays.map(classSig)).size === 1}`);
console.log(`diagnostics identical:            ${new Set(replays.map(diagSig)).size === 1}  (${replays[0]!.state.diagnostics.length} diagnostics)`);

// ---------------------------------------------------------------------------
section("§16.10 FAILURE MODES ARE EXPOSED");
// ---------------------------------------------------------------------------
const kinds: Record<string, number> = {};
for (const d of loopRun.state.diagnostics) kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
console.log(`collapse scenario diagnostics: ${JSON.stringify(kinds)}`);
for (const d of loopRun.state.diagnostics.slice(0, 8)) {
  console.log(`  t${String(d.tick).padStart(3)} ${d.kind.padEnd(24)} ${(d.signal ?? `${d.regionId}/${d.domain}`) ?? ""}`);
}
console.log(`\nquiet world diagnostics: ${quiet.state.diagnostics.length} (anomalies are not manufactured)`);
const priceTrace = loopRun.state.dynamics["RF:price:grain"]!;
console.log(
  `RF grain price: classification="${priceTrace.classification}" atBound=${priceTrace.atBound} divergedEver=${priceTrace.divergedEver}`,
);
console.log("-> a clamped collapse reports converged_at_bound + convergence_not_reached, never 'converged'");
