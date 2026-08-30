import { runCell } from "./sweep.js";
import { uniformThresholds } from "../core/config.js";

/**
 * Candidate probe: finer-grained search around the defaults, to pick a calibrated
 * configuration rather than keeping the original guess. Not part of the test suite —
 * a one-shot analysis tool. Run: npx tsx src/poc/calibrate.ts
 */
const CANDIDATES: Array<[threshold: number, decay: number, boundaryDecay: number]> = [
  [0.6, 0.9, 0.35], // current defaults
  [0.6, 0.85, 0.3],
  [0.6, 0.8, 0.3],
  [0.6, 0.8, 0.2],
  [0.6, 0.75, 0.3],
  [0.6, 0.7, 0.3],
  [0.75, 0.8, 0.3],
  [0.9, 0.8, 0.2],
  [0.9, 0.7, 0.2],
];

console.log("thresh | decay | bDecay | latency | passes | signals | settle | peakHost | quota | locality | guards");
console.log("-".repeat(100));
for (const [t, d, b] of CANDIDATES) {
  const r = runCell({
    thresholds: uniformThresholds(t),
    ledgerDecayPerTick: d,
    boundaryDecay: b,
  });
  const f = (n: number | null, k = 2) => (n === null ? "  -  " : n.toFixed(k));
  console.log(
    `${f(t).padStart(6)} | ${f(d).padStart(5)} | ${f(b).padStart(6)} | ${f(r.latencyTicks, 0).padStart(7)} | ` +
      `${String(r.resolutionPasses).padStart(6)} | ${String(r.boundarySignals).padStart(7)} | ${f(r.settleTicks, 0).padStart(6)} | ` +
      `${f(r.peakHostility).padStart(8)} | ${(r.quotaFired ? "yes" : "NO").padStart(5)} | ${(r.psUnaffected ? "yes" : "NO").padStart(8)} | ${r.guardsPatrolled ? "yes" : "NO"}`,
  );
}
