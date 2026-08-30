import { describe, expect, it } from "vitest";
import { advance, convergenceConfig, createEngine, createWorld, submitBatch, submitIntervention, tick } from "../core/world.js";
import { stateHash, traceHash } from "../core/hash.js";
import { addPending, generatePressure, saturate, pendingCausesOf } from "../core/propagation.js";
import { createTrace, isTrueConvergence, observeSignal, type ConvergenceConfig } from "../core/dynamics.js";
import { explain, key } from "../core/provenance.js";
import { DEFAULT_CONFIG, uniformThresholds } from "../core/config.js";
import { equilibriumProfitability } from "../game/investment.js";
import { WORLD_SEED } from "../game/content.js";
import { iBridge, iMerchant, iRally, iSubsidy, iWarehouse, run, type RunOptions } from "./harness.js";

/**
 * Feedback & convergence adversarial pass (docs/RECONNAISSANCE.md §16).
 * Every architectural assumption changed by this pass has a regression test here.
 */

const T = 10;

const convCfg: ConvergenceConfig = convergenceConfig(DEFAULT_CONFIG);

function loopRun(overrides: Partial<RunOptions> = {}): ReturnType<typeof run> {
  return run({
    label: "loop",
    schedule: [
      { atTick: T, intervention: iBridge() },
      { atTick: T, intervention: iWarehouse() },
    ],
    totalTicks: 120,
    ...overrides,
  });
}

// ===========================================================================
describe("§16.1 feedback loop construction", () => {
  it("the loop's equilibrium is an EXACT fixed point, so a quiet world stays quiet", () => {
    // If anyone retunes margin / tradeRate / carryCost / reference and breaks this identity,
    // the baseline world starts drifting on its own and every experiment becomes unreadable.
    const engine = createEngine();
    const state = createWorld({ seed: WORLD_SEED }, engine);
    expect(equilibriumProfitability(state)).toBeCloseTo(state.config.investmentProfitReference, 12);

    advance(state, engine, 300);
    expect(state.regions["RF"]!.prices["grain"]!).toBeCloseTo(10, 9);
    expect(state.regions["RF"]!.stocks["grain"]!).toBeCloseTo(50, 9);
    expect(state.regions["HT"]!.tradeInvestment).toBeCloseTo(state.config.investmentMax, 9);
    // and no anomaly is invented for a world that never moved
    expect(state.diagnostics).toHaveLength(0);
  });

  it("the loop closes: price -> profitability -> investment -> capacity -> supply -> price", () => {
    const r = loopRun({ totalTicks: 60 });
    const ht = r.state.regions["HT"]!;

    // investment fell below its starting value, driven by the destination price
    expect(ht.tradeInvestment).toBeLessThan(DEFAULT_CONFIG.investmentMax);
    expect(ht.merchantProfitability).toBeLessThan(DEFAULT_CONFIG.investmentProfitReference);
    // and capacity throttling fed back into throughput
    expect(ht.tradeCapacityFactor).toBeLessThan(1);

    // provenance must show the cycle, not just the endpoints
    const ex = explain(r.state, key.investment("HT"));
    expect(ex.explained).toBe(true);
    expect(ex.paths.some((p) => p.includes("trade_investment"))).toBe(true);
  });

  it("no scenario-specific rule: the loop is driven by generic price/investment state", () => {
    // The loop must also engage for a DIFFERENT intervention that merely raises price.
    const viaWarehouse = run({
      label: "warehouse only",
      schedule: [{ atTick: T, intervention: iWarehouse() }],
      totalTicks: 120,
    });
    expect(viaWarehouse.state.regions["HT"]!.tradeInvestment).toBeLessThan(DEFAULT_CONFIG.investmentMax);
    expect(viaWarehouse.summary.investmentReversals).toBe(0);
  });
});

// ===========================================================================
describe("§16.2 convergence semantics", () => {
  const feed = (values: number[], bounds?: { min?: number; max?: number }) => {
    const trace = createTrace("t");
    values.forEach((v, i) => observeSignal(trace, v, i + 1, convCfg, bounds));
    return trace;
  };

  it("distinguishes stable convergence", () => {
    const t = feed([1.0, 1.4, 1.7, 1.8, 1.81, 1.81, 1.81, 1.81]);
    expect(t.classification).toBe("converged");
    expect(isTrueConvergence(t.classification)).toBe(true);
  });

  it("distinguishes oscillation from convergence", () => {
    const t = feed([1, 2, 1, 2, 1, 2, 1, 2]);
    expect(t.classification).toBe("oscillating");
    expect(isTrueConvergence(t.classification)).toBe(false);
  });

  it("distinguishes divergence from both", () => {
    const t = feed([1, 2, 4, 8, 16, 32]);
    expect(t.classification).toBe("diverging");
    expect(t.divergedEver).toBe(true);
  });

  it("does not call a still-moving signal converged", () => {
    const t = feed([1, 1.5, 2.0, 2.5]);
    expect(t.classification).toBe("settling");
  });

  it("CONVERGED AT A BOUND is not reported as convergence", () => {
    // Numerically identical to convergence; causally completely different.
    const t = feed([10, 20, 35, 40, 40, 40, 40], { min: 3, max: 40 });
    expect(t.classification).toBe("converged_at_bound");
    expect(isTrueConvergence(t.classification)).toBe(false);
    expect(t.atBound).toBe(true);
  });

  it("a signal that never moved is 'converged', not 'pinned at a bound'", () => {
    const t = feed([40, 40, 40, 40, 40], { min: 3, max: 40 });
    expect(t.classification).toBe("converged");
    expect(t.movedEver).toBe(false);
  });

  it("a terminal verdict is revoked when the signal starts moving again", () => {
    const t = feed([1, 1, 1, 1, 5]);
    expect(t.classification).toBe("settling");
  });

  it("computational cutoff is a SEPARATE class from every semantic verdict", () => {
    const engine = createEngine();
    const state = createWorld({ seed: WORLD_SEED }, engine);
    // exceed the generation bound directly
    const ok = generatePressure(state, "RF", "economy", 0.5, +1, state.config.maxCausalGeneration, ["c"], {});
    expect(ok).toBe(false);
    const cut = state.diagnostics.filter((d) => d.kind === "recurrence_cutoff");
    expect(cut).toHaveLength(1);
    expect(String(cut[0]!.detail.note)).toContain("not convergence");
  });
});

// ===========================================================================
describe("§16.3 monotone propagation is NOT assumed", () => {
  it("a domain's state can move down and then back up (relief after stress)", () => {
    const engine = createEngine();
    const state = createWorld({ seed: WORLD_SEED }, engine);
    advance(state, engine, 5);

    // stress: destroy the granary -> ecology pressure disruptive
    submitIntervention(state, iWarehouse("w"), engine);
    advance(state, engine, 3);
    const stressed = state.regions["RF"]!.stocks["grain"]!;

    // relief: subsidise -> ecology pressure relieving, same domain, opposite direction
    submitIntervention(state, iSubsidy("s"), engine);
    advance(state, engine, 6);

    // the ledger accepted BOTH directions in the same domain over the run
    const decisions = state.resolutionLog.filter((d) => d.regionId === "RF" && d.domain === "ecology");
    expect(decisions.some((d) => d.netValence > 0)).toBe(true);
    expect(decisions.some((d) => d.netValence <= 0)).toBe(true);
    expect(stressed).toBeGreaterThan(0);
  });

  it("valence is carried through resolution, not discarded", () => {
    const r = run({
      label: "subsidy",
      schedule: [{ atTick: T, intervention: iSubsidy() }],
      totalTicks: 30,
    });
    const fired = r.state.resolutionLog.filter((d) => d.fired && d.domain === "ecology");
    expect(fired.length).toBeGreaterThan(0);
    // a purely relieving cause resolves with negative net valence
    expect(fired.every((d) => d.netValence < 0)).toBe(true);
  });
});

// ===========================================================================
describe("§16.4 competing causes", () => {
  const opposing = (reverse: boolean) =>
    run({
      label: reverse ? "subsidy first" : "granary first",
      schedule: reverse
        ? [
            { atTick: T, intervention: iSubsidy("s") },
            { atTick: T, intervention: iWarehouse("w") },
          ]
        : [
            { atTick: T, intervention: iWarehouse("w") },
            { atTick: T, intervention: iSubsidy("s") },
          ],
      totalTicks: 80,
    });

  it("salience ADDS while direction NETS — opposing causes do not erase each other", () => {
    const engine = createEngine();
    const state = createWorld({ seed: WORLD_SEED }, engine);
    advance(state, engine, 5);
    submitIntervention(state, iWarehouse("w"), engine);
    submitIntervention(state, iSubsidy("s"), engine);

    const e = state.pendingContributions["RF"]!["ecology"]!;
    // both causes present in salience...
    expect(e.raw).toBeCloseTo(1.4, 9);
    expect(e.negativeRaw).toBeGreaterThan(0);
    expect(e.positiveRaw).toBeGreaterThan(0);
    // ...and exactly cancelling in direction
    expect(e.netValence).toBeCloseTo(0, 9);
    // crucially NOT silent: salience is above threshold, so the domain still resolves
    expect(e.pressure).toBeGreaterThan(state.config.thresholds.ecology);
    expect(pendingCausesOf(state, "RF", "ecology")).toHaveLength(2);
  });

  it("a contested resolution is flagged explicitly, never quietly averaged", () => {
    const r = opposing(false);
    const contested = r.state.resolutionLog.filter((d) => d.contested);
    expect(contested.length).toBeGreaterThan(0);
    const diag = r.state.diagnostics.filter((d) => d.kind === "contested_resolution");
    expect(diag.length).toBeGreaterThan(0);
    expect(String(diag[0]!.detail.note)).toContain("contest recorded");
  });

  it("opposing causes are order-independent within a tick (bit-identical state)", () => {
    const a = opposing(false);
    const b = opposing(true);
    expect(a.final.stateHash).toBe(b.final.stateHash);
  });

  it("both causes remain visible in provenance and in the resolution record", () => {
    const r = opposing(false);

    // The contest itself is recorded with both sides' magnitudes.
    const contested = r.state.resolutionLog.filter((d) => d.domain === "ecology" && d.contested);
    expect(contested.length).toBeGreaterThan(0);
    const diag = r.state.diagnostics.find((d) => d.kind === "contested_resolution" && d.domain === "ecology")!;
    expect(Number(diag.detail.negativePressure)).toBeGreaterThan(0);
    expect(Number(diag.detail.positivePressure)).toBeGreaterThan(0);

    // The disruptive cause is traceable through the store it emptied.
    const reserve = explain(r.state, "RF:reserve:grain_warehouse");
    expect(reserve.explained).toBe(true);
    expect(reserve.roots.map((x) => x.interventionId)).toContain("w");

    // The relieving cause is traceable through the investment it supported.
    const investment = explain(r.state, key.investment("RF"));
    expect(investment.explained).toBe(true);
    expect(investment.roots.map((x) => x.interventionId)).toContain("s");
  });

  it("relief genuinely changes the outcome: subsidy prevents the collapse the granary loss causes", () => {
    const granary = run({
      label: "granary",
      schedule: [{ atTick: T, intervention: iWarehouse() }],
      totalTicks: 80,
    });
    const both = opposing(false);
    expect(granary.summary.starvationTick).not.toBeNull();
    expect(both.summary.starvationTick).toBeNull();
  });
});

// ===========================================================================
describe("§16.5 saturation attacked systematically", () => {
  const knee = DEFAULT_CONFIG.pressureSoftKnee;
  const cap = DEFAULT_CONFIG.capPerDomainRegionTick;

  it("one / two / many / repeated / mixed causes all behave as specified", () => {
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const one = saturate(1.0, knee, cap);
    const two = saturate(sum([1.0, 0.2]), knee, cap);
    const many = saturate(sum(Array(10).fill(0.2)), knee, cap);
    const repeated = saturate(sum(Array(8).fill(1.0)), knee, cap);
    const mixed = saturate(sum([0.05, 0.4, 1.0, 0.2, 0.7]), knee, cap);

    expect(one).toBeCloseTo(1.0, 12); // identity below the knee
    expect(two).toBeGreaterThan(one); // non-erasure
    expect(many).toBeGreaterThan(one);
    expect(repeated).toBeLessThan(cap); // boundedness
    expect(mixed).toBeGreaterThan(two);
  });

  it("monotonicity: adding positive salience never decreases pressure, and strictly increases below saturation", () => {
    let raw = 0;
    let prev = -1;
    for (let i = 1; i <= 400; i++) {
      raw += (i % 7 + 1) * 0.03;
      const p = saturate(raw, knee, cap);
      expect(p).toBeGreaterThanOrEqual(prev);
      // Strictness holds until exp() underflows and the curve reaches the cap exactly
      // (raw ~= 38 for knee 1 / cap 2). Boundedness is unaffected.
      if (raw < 30) expect(p).toBeGreaterThan(prev);
      prev = p;
    }
    expect(prev).toBeLessThanOrEqual(cap);
  });

  it("boundedness holds for absurd input", () => {
    expect(saturate(1e6, knee, cap)).toBeLessThanOrEqual(cap);
    expect(saturate(Number.MAX_SAFE_INTEGER, knee, cap)).toBeLessThanOrEqual(cap);
  });

  it("BIT-EXACT commutativity across mixed magnitudes and opposing valences", () => {
    // The regression test for the float non-associativity failure. Incremental accumulation
    // produced order-dependent bits (~4e-16), enough to change a state hash.
    const contribs: Array<[number, number, string]> = [
      [1.0, +1, "a"],
      [0.2, +1, "b"],
      [0.7, -1, "c"],
      [0.05, -1, "d"],
      [0.4, +1, "e"],
    ];
    const build = (order: typeof contribs) => {
      const engine = createEngine();
      const state = createWorld({ seed: WORLD_SEED }, engine);
      for (const [p, v, c] of order) addPending(state, "RF", "economy", p, v, "primary", 0, [c]);
      return state;
    };

    const orders: Array<typeof contribs> = [
      contribs,
      [...contribs].reverse(),
      [contribs[2]!, contribs[0]!, contribs[4]!, contribs[1]!, contribs[3]!],
      [contribs[3]!, contribs[1]!, contribs[4]!, contribs[2]!, contribs[0]!],
    ];
    const states = orders.map(build);
    const entries = states.map((s) => s.pendingContributions["RF"]!["economy"]!);
    const first = entries[0]!;
    for (const e of entries) {
      expect(Object.is(e.raw, first.raw)).toBe(true);
      expect(Object.is(e.pressure, first.pressure)).toBe(true);
      expect(Object.is(e.netValence, first.netValence)).toBe(true);
      expect(Object.is(e.negativeRaw, first.negativeRaw)).toBe(true);
      expect(Object.is(e.positiveRaw, first.positiveRaw)).toBe(true);
    }
    // cause ids are trace-side now, and canonically sorted regardless of arrival order
    const causeSets = states.map((s) => pendingCausesOf(s, "RF", "economy"));
    for (const c of causeSets) expect(c).toEqual(causeSets[0]!);
  });

  it("no independent cause is erased even when the first cause reaches the knee", () => {
    const engine = createEngine();
    const state = createWorld({ seed: WORLD_SEED }, engine);
    addPending(state, "RF", "economy", knee, +1, "primary", 0, ["big"]);
    const afterFirst = state.pendingContributions["RF"]!["economy"]!.pressure;
    addPending(state, "RF", "economy", 0.05, +1, "primary", 0, ["tiny"]);
    const afterSecond = state.pendingContributions["RF"]!["economy"]!.pressure;
    expect(afterSecond).toBeGreaterThan(afterFirst);
  });
});

// ===========================================================================
describe("§16.6 decay under feedback", () => {
  it("pressure drains at calibrated decay even with the loop active", () => {
    const r = loopRun({ totalTicks: 160 });
    for (const region of Object.values(r.state.regions)) {
      expect(Object.keys(region.ledger)).toHaveLength(0);
    }
  });

  it("near-unity decay is the regime where pressure stops draining — and it is observable", () => {
    const drains = loopRun({ totalTicks: 160, configOverrides: { seed: WORLD_SEED, ledgerDecayPerTick: 0.8 } });
    const persists = loopRun({ totalTicks: 160, configOverrides: { seed: WORLD_SEED, ledgerDecayPerTick: 0.99 } });

    const empty = (r: ReturnType<typeof run>) =>
      Object.values(r.state.regions).every((x) => Object.keys(x.ledger).length === 0);
    expect(empty(drains)).toBe(true);
    expect(empty(persists)).toBe(false);
  });

  it("feedback does not produce unbounded resolution work at any tested decay", () => {
    for (const decay of [0.6, 0.7, 0.8, 0.9, 0.95]) {
      const r = loopRun({ totalTicks: 160, configOverrides: { seed: WORLD_SEED, ledgerDecayPerTick: decay } });
      const fired = r.state.resolutionLog.filter((d) => d.fired).length;
      // 160 ticks x 3 regions x 4 domains = 1920 possible; feedback must stay far below.
      expect(fired).toBeLessThan(40);
    }
  });
});

// ===========================================================================
describe("§16.7 cross-region causal cycles", () => {
  it("INHERITED (boundary) pressure never relays", () => {
    const r = loopRun({ totalTicks: 120 });
    const signals = r.state.events.filter((e) => e.type === "world.boundary_signal");
    expect(signals.length).toBeGreaterThan(0);
    // every emitted signal came from primary or generated pressure, never inherited
    expect(signals.every((e) => e.data.origin === "primary" || e.data.origin === "generated")).toBe(true);
  });

  it("GENERATED pressure — a real state transition — DOES propagate, and is distinguishable", () => {
    const r = loopRun({ totalTicks: 120 });
    const generated = r.state.resolutionLog.filter((d) => d.fired && d.origin === "generated");
    expect(generated.length).toBeGreaterThan(0);
    expect(generated.every((d) => d.generation >= 1)).toBe(true);

    // and it is visible as such in provenance
    const genNodes = r.state.provenance.filter((n) => n.label === "economy_pressure_generated");
    expect(genNodes.length).toBeGreaterThan(0);
    expect(String(genNodes[0]!.detail?.note)).toContain("NOT inherited");
  });

  it("recurrence is BOUNDED by causal generation, and hitting the bound is reported", () => {
    // Make recurrence easy: low threshold, tiny materiality, high loop gain.
    const r = loopRun({
      totalTicks: 160,
      configOverrides: {
        seed: WORLD_SEED,
        thresholds: uniformThresholds(0.3),
        generationMateriality: 0.02,
      },
    });
    const maxGen = Math.max(0, ...r.state.resolutionLog.filter((d) => d.fired).map((d) => d.generation));
    expect(maxGen).toBeLessThanOrEqual(r.state.config.maxCausalGeneration);

    const cutoffs = r.state.diagnostics.filter((d) => d.kind === "recurrence_cutoff");
    expect(cutoffs.length).toBeGreaterThan(0);
    expect(Number(cutoffs[0]!.detail.attemptedGeneration)).toBeGreaterThan(r.state.config.maxCausalGeneration);
  });

  it("raising the generation bound permits deeper chains — the bound is the limiter, not luck", () => {
    const opts = {
      totalTicks: 160,
      configOverrides: { seed: WORLD_SEED, thresholds: uniformThresholds(0.3), generationMateriality: 0.02 },
    };
    const tight = loopRun({ ...opts, configOverrides: { ...opts.configOverrides, maxCausalGeneration: 1 } });
    const loose = loopRun({ ...opts, configOverrides: { ...opts.configOverrides, maxCausalGeneration: 6 } });

    const gen = (r: ReturnType<typeof run>) =>
      Math.max(0, ...r.state.resolutionLog.filter((d) => d.fired).map((d) => d.generation));
    expect(gen(tight)).toBeLessThanOrEqual(1);
    expect(gen(loose)).toBeGreaterThan(gen(tight));
    // and the tight run must SAY it was cut off
    expect(tight.state.diagnostics.some((d) => d.kind === "recurrence_cutoff")).toBe(true);
  });

  it("cross-region cycles terminate: all ledgers drain and work stays finite", () => {
    const r = loopRun({
      totalTicks: 200,
      configOverrides: { seed: WORLD_SEED, thresholds: uniformThresholds(0.3), generationMateriality: 0.02 },
    });
    for (const region of Object.values(r.state.regions)) {
      expect(Object.keys(region.ledger)).toHaveLength(0);
    }
    expect(r.state.resolutionLog.filter((d) => d.fired).length).toBeLessThan(60);
  });
});

// ===========================================================================
describe("§16.8 causal trace requirements", () => {
  it("answers 'what caused the second iteration?' with generation and origin, not a guess", () => {
    const r = loopRun({ totalTicks: 120 });
    const laterGenerations = r.state.resolutionLog.filter((d) => d.fired && d.generation >= 1);
    expect(laterGenerations.length).toBeGreaterThan(0);

    for (const d of laterGenerations) {
      // A later iteration must declare WHICH kind of causality drove it.
      expect(["generated", "primary"]).toContain(d.origin);
    }
  });

  it("inherited pressure and newly generated causality are NOT conflated", () => {
    const r = loopRun({ totalTicks: 120 });
    const origins = new Set(r.state.resolutionLog.map((d) => d.origin));
    // all three kinds are representable and distinct in the record
    expect(origins.has("primary")).toBe(true);
    expect(origins.has("generated")).toBe(true);

    // provenance labels them differently too
    const generatedNodes = r.state.provenance.filter((n) => n.detail?.origin === "generated");
    const primaryNodes = r.state.provenance.filter((n) => n.detail?.origin === "primary");
    expect(generatedNodes.length).toBeGreaterThan(0);
    expect(primaryNodes.length).toBeGreaterThan(0);
    for (const n of generatedNodes) expect(Number(n.detail?.generation)).toBeGreaterThanOrEqual(1);
    for (const n of primaryNodes) expect(Number(n.detail?.generation)).toBe(0);
  });

  it("a generated cause traces back to the state transition that produced it", () => {
    const r = loopRun({ totalTicks: 120 });
    const genNode = r.state.provenance.find((n) => n.label === "economy_pressure_generated");
    expect(genNode).toBeDefined();
    expect(String(genNode!.detail?.transition)).toBe("trade_investment_collapse");
    expect(genNode!.parents.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
describe("§16.9 determinism under convergence", () => {
  const scenario = () =>
    run({
      label: "feedback replay",
      schedule: [
        { atTick: 8, intervention: iBridge() },
        { atTick: 10, intervention: iWarehouse() },
        { atTick: 10, intervention: iRally() },
        { atTick: 16, intervention: iSubsidy() },
        { atTick: 22, intervention: iMerchant() },
      ],
      totalTicks: 140,
    });

  it("five runs are identical in state, trace, per-tick series and resolution decisions", () => {
    const runs = [scenario(), scenario(), scenario(), scenario(), scenario()];

    expect(new Set(runs.map((r) => r.final.stateHash)).size).toBe(1);
    expect(new Set(runs.map((r) => r.final.traceHash)).size).toBe(1);
    expect(runs[0]!.series).toEqual(runs[1]!.series);

    const sig = (r: ReturnType<typeof run>) =>
      r.state.resolutionLog
        .map(
          (d) =>
            `${d.tick}:${d.regionId}:${d.domain}:${d.fired ? 1 : 0}:${d.origin}:${d.generation}:${d.contested ? 1 : 0}:${d.pressure.toFixed(15)}:${d.netValence.toFixed(15)}`,
        )
        .join("|");
    expect(new Set(runs.map(sig)).size).toBe(1);
  });

  it("convergence CLASSIFICATIONS replay identically", () => {
    const runs = [scenario(), scenario(), scenario(), scenario(), scenario()];
    const classes = (r: ReturnType<typeof run>) =>
      Object.entries(r.state.dynamics)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `${k}=${v.classification}@${v.classifiedAtTick}:${v.stableCount}:${v.alternations}`)
        .join("|");
    expect(new Set(runs.map(classes)).size).toBe(1);
    // and the classification set is non-trivial
    expect(classes(runs[0]!).length).toBeGreaterThan(50);
  });

  it("diagnostics replay identically, including cutoff decisions", () => {
    const runs = [scenario(), scenario(), scenario()];
    const diag = (r: ReturnType<typeof run>) =>
      r.state.diagnostics.map((d) => `${d.tick}:${d.kind}:${d.regionId ?? ""}:${d.domain ?? ""}:${d.signal ?? ""}`).join("|");
    expect(new Set(runs.map(diag)).size).toBe(1);
  });

  it("snapshot/restore preserves feedback and convergence state exactly", () => {
    const engine = createEngine();
    const state = createWorld({ seed: WORLD_SEED }, engine);
    advance(state, engine, 8);
    submitIntervention(state, iBridge(), engine);
    advance(state, engine, 12);
    const snap = structuredClone(state);
    const straightThrough = (() => {
      const s = structuredClone(state);
      const e = createEngine();
      e.rng.restore(s.rngState);
      advance(s, e, 30);
      return { state: stateHash(s), trace: traceHash(s) };
    })();

    const e2 = createEngine();
    e2.rng.restore(snap.rngState);
    const restored = structuredClone(snap);
    advance(restored, e2, 30);

    expect(stateHash(restored)).toBe(straightThrough.state);
    expect(traceHash(restored)).toBe(straightThrough.trace);
  });
});

// ===========================================================================
describe("§16.10 failure modes are exposed, never silently clamped", () => {
  it("a collapse pinned at the price ceiling is reported as bound-limited, NOT converged", () => {
    const r = loopRun({ totalTicks: 160 });
    const priceTrace = r.state.dynamics["RF:price:grain"]!;
    expect(priceTrace).toBeDefined();
    expect(priceTrace.classification).toBe("converged_at_bound");
    expect(isTrueConvergence(priceTrace.classification)).toBe(false);
    expect(r.state.diagnostics.some((d) => d.kind === "convergence_not_reached" && d.signal === "RF:price:grain")).toBe(
      true,
    );
  });

  it("divergence during the collapse is detected and recorded", () => {
    const r = loopRun({ totalTicks: 160 });
    expect(r.state.diagnostics.some((d) => d.kind === "divergence_detected")).toBe(true);
    const diverged = Object.values(r.state.dynamics).filter((t) => t.divergedEver);
    expect(diverged.length).toBeGreaterThan(0);
  });

  it("a quiet world produces NO diagnostics — anomalies are not manufactured", () => {
    const quiet = run({ label: "quiet", schedule: [], totalTicks: 200 });
    expect(quiet.state.diagnostics).toHaveLength(0);
    expect(quiet.state.resolutionLog.filter((d) => d.fired)).toHaveLength(0);
  });

  it("every diagnostic kind carries the structured detail needed to act on it", () => {
    const r = loopRun({
      totalTicks: 160,
      configOverrides: { seed: WORLD_SEED, thresholds: uniformThresholds(0.3), generationMateriality: 0.02 },
    });
    expect(r.state.diagnostics.length).toBeGreaterThan(0);
    for (const d of r.state.diagnostics) {
      expect(typeof d.tick).toBe("number");
      expect(d.detail).toBeTruthy();
      expect(Object.keys(d.detail).length).toBeGreaterThan(0);
      expect([
        "recurrence_cutoff",
        "contested_resolution",
        "oscillation_detected",
        "divergence_detected",
        "convergence_not_reached",
      ]).toContain(d.kind);
    }
  });

  it("contradictory contributions surface as a contest rather than a quiet average", () => {
    const engine = createEngine();
    const state = createWorld({ seed: WORLD_SEED }, engine);
    advance(state, engine, 5);
    submitIntervention(state, iWarehouse("w"), engine);
    submitIntervention(state, iSubsidy("s"), engine);
    tick(state, engine);

    const contested = state.resolutionLog.filter((d) => d.contested);
    expect(contested.length).toBeGreaterThan(0);
    // net direction is ~zero, yet the resolution DID happen (not silently skipped)
    const eco = contested.find((d) => d.domain === "ecology");
    expect(eco).toBeDefined();
    expect(Math.abs(eco!.netValence)).toBeLessThan(1e-6);
    expect(eco!.fired).toBe(true);
  });
});

// ===========================================================================
describe("§16 invariants preserved from earlier passes", () => {
  it("same-tick ordering remains canonical under the feedback model", () => {
    const build = (reverse: boolean) => {
      const list = [iBridge("i-bridge"), iWarehouse("i-warehouse"), iSubsidy("i-subsidy")];
      return run({
        label: reverse ? "rev" : "fwd",
        schedule: (reverse ? [...list].reverse() : list).map((intervention) => ({ atTick: T, intervention })),
        totalTicks: 100,
        canonicalBatch: true,
      });
    };
    const a = build(false);
    const b = build(true);
    expect(a.final.stateHash).toBe(b.final.stateHash);
    expect(a.final.traceHash).toBe(b.final.traceHash);
  });

  it("legitimate temporal order dependence remains explainable under feedback", () => {
    const early = run({
      label: "subsidy early",
      schedule: [
        { atTick: T, intervention: iWarehouse("w") },
        { atTick: T + 2, intervention: iSubsidy("s") },
      ],
      totalTicks: 100,
    });
    const late = run({
      label: "subsidy late",
      schedule: [
        { atTick: T, intervention: iWarehouse("w") },
        { atTick: T + 20, intervention: iSubsidy("s") },
      ],
      totalTicks: 100,
    });

    expect(early.final.stateHash).not.toBe(late.final.stateHash);
    // WHEN relief arrives changes the outcome in the causally sensible direction: earlier
    // relief postpones the collapse. Peak price cannot be the discriminator here because
    // both runs eventually pin at the price ceiling — the trajectory is the evidence.
    expect(early.summary.starvationTick).not.toBeNull();
    expect(late.summary.starvationTick).not.toBeNull();
    expect(early.summary.starvationTick!).toBeGreaterThan(late.summary.starvationTick!);
  });

  it("domain isolation still holds: a civic action never touches the economy or the loop", () => {
    const control = run({ label: "control", schedule: [], totalTicks: 120 });
    const rally = run({ label: "rally", schedule: [{ atTick: T, intervention: iRally() }], totalTicks: 120 });

    for (let i = 0; i < control.series.length; i++) {
      expect(rally.series[i]!.rfGrainPrice).toBeCloseTo(control.series[i]!.rfGrainPrice, 9);
      expect(rally.series[i]!.htTradeInvestment).toBeCloseTo(control.series[i]!.htTradeInvestment, 9);
    }
    expect(rally.summary.peakUnrest).toBeGreaterThan(0);
  });

  it("the batch API's canonical order is bit-stable with opposing causes present", () => {
    const engine1 = createEngine();
    const s1 = createWorld({ seed: WORLD_SEED }, engine1);
    submitBatch(s1, [iWarehouse("w"), iSubsidy("s"), iBridge("b")], engine1);

    const engine2 = createEngine();
    const s2 = createWorld({ seed: WORLD_SEED }, engine2);
    submitBatch(s2, [iSubsidy("s"), iBridge("b"), iWarehouse("w")], engine2);

    expect(stateHash(s1)).toBe(stateHash(s2));
    expect(traceHash(s1)).toBe(traceHash(s2));
  });
});
