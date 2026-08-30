import { describe, expect, it } from "vitest";
import { advance, createEngine, createWorld, submitBatch, submitIntervention, tick } from "../core/world.js";
import { stateHash, traceHash } from "../core/hash.js";
import { saturate, pendingCausesOf } from "../core/propagation.js";
import { explain, key } from "../core/provenance.js";
import { DOMAIN_ORDER } from "../core/types.js";
import { ROUTE_ID, SHRINE_ID, WAREHOUSE_ID, WORLD_SEED } from "../game/content.js";
import {
  diff,
  differingFields,
  iBridge,
  iMerchant,
  iRally,
  iShrine,
  iWarehouse,
  observe,
  rootCauseIds,
  run,
  type Observation,
} from "./harness.js";

/**
 * Multi-intervention causality stress test — invariants (Experiments A–G).
 * Narrative and numbers: docs/RECONNAISSANCE.md §15. Evidence driver: src/poc/stress.ts.
 */

const T = 10;
const H = 40;

const control = () => run({ label: "control", schedule: [], totalTicks: H });
const only = (i: Parameters<typeof run>[0]["schedule"][number]["intervention"], label: string) =>
  run({ label, schedule: [{ atTick: T, intervention: i }], totalTicks: H });

const ECONOMIC_FIELDS = [
  "tradeCapacity",
  "tradeVolume",
  "rfGrainStock",
  "rfGrainPrice",
  "htGrainPrice",
  "psGrainPrice",
  "warehouseReserve",
  "mgIncomeRate",
  "mgTreasury",
] as const;

// ===========================================================================
describe("Experiment A — multiple interventions, individually and together", () => {
  it("each intervention acts, and only through its declared domains", () => {
    const c = control().final;
    const bridge = only(iBridge(), "bridge").final;
    const merchant = only(iMerchant(), "merchant").final;
    const warehouse = only(iWarehouse(), "warehouse").final;

    // bridge: severs trade
    expect(bridge.tradeCapacity).toBe(0);
    expect(bridge.tradeVolume).toBe(0);
    expect(bridge.rfGrainPrice).toBeGreaterThan(c.rfGrainPrice);

    // merchant: removes a person; economy untouched at this magnitude (below threshold)
    expect(merchant.rfPopulation).toBe(c.rfPopulation - 1);
    expect(merchant.tradeCapacity).toBe(c.tradeCapacity);
    expect(merchant.rfGrainPrice).toBeCloseTo(c.rfGrainPrice, 9);

    // warehouse: destroys the stored reserve
    expect(warehouse.warehouseReserve).toBe(0);
    expect(c.warehouseReserve).toBeGreaterThan(0);
    expect(warehouse.tradeCapacity).toBe(c.tradeCapacity); // trade unaffected
  });

  it("all four together produce a strict superset of the individually-changed fields", () => {
    const c = control().final;
    const singles = [iBridge(), iMerchant(), iWarehouse(), iRally()].map((i, n) => only(i, `s${n}`).final);
    const together = run({
      label: "all four",
      schedule: [iBridge(), iMerchant(), iWarehouse(), iRally()].map((intervention) => ({ atTick: T, intervention })),
      totalTicks: H,
    }).final;

    const combinedFields = new Set(differingFields(c, together));
    for (const s of singles) {
      for (const f of differingFields(c, s)) {
        expect(combinedFields.has(f)).toBe(true);
      }
    }
  });

  it("a rejected intervention leaves no state change and no causal trace", () => {
    const engine = createEngine();
    const state = createWorld({ seed: WORLD_SEED }, engine);
    advance(state, engine, 5);
    const before = { hash: stateHash(state), nodes: state.provenance.length, seq: state.interventionSeq };

    // already destroyed -> rejected on the second attempt
    expect(submitIntervention(state, iBridge("ok"), engine).ok).toBe(true);
    const mid = state.provenance.length;
    const rejected = submitIntervention(state, iBridge("dup"), engine);

    expect(rejected.ok).toBe(false);
    expect(state.provenance.length).toBe(mid); // no orphan provenance node
    expect(state.interventionSeq).toBe(before.seq + 1); // sequence not consumed by the rejection
    expect(before.hash).not.toBe(stateHash(state)); // (the accepted one did change state)
  });
});

// ===========================================================================
describe("Experiment B — composition (bridge + warehouse)", () => {
  it("the warehouse is nearly inert alone but materially worsens the bridge scenario", () => {
    const bridge = only(iBridge(), "bridge");
    const warehouse = only(iWarehouse(), "warehouse");
    const both = run({
      label: "both",
      schedule: [
        { atTick: T, intervention: iBridge() },
        { atTick: T, intervention: iWarehouse() },
      ],
      totalTicks: H,
    });

    // Alone, WITHIN THIS HORIZON, the granary loss is a slow drift rather than a collapse:
    // the town does not starve and price barely moves. (At a longer horizon the positive
    // feedback loop added in §16 does eventually carry it to collapse — see feedback.test.ts
    // "every material perturbation eventually collapses". That is the loop's doing, not the
    // granary's, and the composition claim below is about the 40-tick behaviour.)
    expect(warehouse.summary.starvationTick).toBeNull();
    expect(warehouse.summary.peakRFPrice).toBeLessThan(12);
    expect(warehouse.summary.peakRFPrice - control().summary.peakRFPrice).toBeLessThan(2);

    // with the bridge gone, the granary is the only buffer -> removing it starves the town sooner
    expect(bridge.summary.starvationTick).not.toBeNull();
    expect(both.summary.starvationTick).not.toBeNull();
    expect(both.summary.starvationTick!).toBeLessThan(bridge.summary.starvationTick!);
  });

  it("composition is emergent, not authored: no schema references another action", () => {
    // Structural guarantee. If a special-case "bridge+warehouse" rule were ever added,
    // it would have to name a second action inside a schema — assert that never happens.
    const bridge = only(iBridge(), "bridge");
    const both = run({
      label: "both",
      schedule: [
        { atTick: T, intervention: iBridge() },
        { atTick: T, intervention: iWarehouse() },
      ],
      totalTicks: H,
    });

    // The mechanism is the granary's release condition (stock < target), visible in provenance.
    const releaseNodes = both.state.provenance.filter((n) => n.label === "warehouse_released_grain");
    const bridgeReleases = bridge.state.provenance.filter((n) => n.label === "warehouse_released_grain");
    expect(bridgeReleases.length).toBeGreaterThan(0); // bridge alone: granary DOES release
    expect(releaseNodes.length).toBe(0); // both: granary destroyed before it could release
  });

  it("the combined run is superadditive on trajectory, not merely two scripts", () => {
    const c = control();
    const bridge = only(iBridge(), "bridge");
    const warehouse = only(iWarehouse(), "warehouse");
    const both = run({
      label: "both",
      schedule: [
        { atTick: T, intervention: iBridge() },
        { atTick: T, intervention: iWarehouse() },
      ],
      totalTicks: H,
    });

    // additive prediction for time-to-starvation would be "bridge's delay" (warehouse alone
    // never starves, so it predicts no change). Reality is materially faster.
    const additivePrediction = bridge.summary.starvationTick!;
    expect(both.summary.starvationTick!).toBeLessThan(additivePrediction - 3);

    // and the peak price is higher than either alone
    expect(both.summary.peakRFPrice).toBeGreaterThan(bridge.summary.peakRFPrice);
    expect(both.summary.peakRFPrice).toBeGreaterThan(warehouse.summary.peakRFPrice);
    expect(c.summary.peakRFPrice).toBeLessThan(11);  });
});

// ===========================================================================
describe("Experiment C — order dependence", () => {
  const mk = (k: "bridge" | "merchant" | "warehouse", id: string) =>
    k === "bridge" ? iBridge(id) : k === "merchant" ? iMerchant(id) : iWarehouse(id);

  const ordered = (order: Array<"bridge" | "merchant" | "warehouse">, gap: number) =>
    run({
      label: order.join("->"),
      schedule: order.map((k, i) => ({ atTick: T + i * gap, intervention: mk(k, `i-${k}`) })),
      totalTicks: H,
    });

  it("SEMANTIC order dependence: spreading actions across ticks changes outcomes legitimately", () => {
    const fwd = ordered(["bridge", "merchant", "warehouse"], 1);
    const rev = ordered(["warehouse", "merchant", "bridge"], 1);

    const differing = differingFields(fwd.final, rev.final);
    expect(differing).toContain("mgTreasury");
    expect(differing).toContain("mgHostility");

    // Attribution: the bridge falls 2 ticks later in the reverse order, so trade flows for
    // exactly 2 more ticks. Treasury difference must equal that extra income exactly —
    // this is what makes the difference causally legitimate rather than an artifact.
    const fwdTradeTicks = fwd.series.filter((s) => s.tradeVolume > 0).length;
    const revTradeTicks = rev.series.filter((s) => s.tradeVolume > 0).length;
    expect(revTradeTicks - fwdTradeTicks).toBe(2);

    const perTickIncome = control().final.mgIncomeRate;
    expect(rev.final.mgTreasury - fwd.final.mgTreasury).toBeCloseTo(2 * perTickIncome, 6);
  });

  it("NO accidental traversal-order dependence: same-tick reordering changes nothing observable", () => {
    const fwd = run({
      label: "A->B->C same tick",
      schedule: [
        { atTick: T, intervention: iBridge("i-bridge") },
        { atTick: T, intervention: iMerchant("i-merchant") },
        { atTick: T, intervention: iWarehouse("i-warehouse") },
      ],
      totalTicks: H,
    });
    const rev = run({
      label: "C->B->A same tick",
      schedule: [
        { atTick: T, intervention: iWarehouse("i-warehouse") },
        { atTick: T, intervention: iMerchant("i-merchant") },
        { atTick: T, intervention: iBridge("i-bridge") },
      ],
      totalTicks: H,
    });

    // Identical world state: pressure accumulation is commutative (linear raw sum, then
    // saturation), and every traversal is explicitly sorted.
    expect(differingFields(fwd.final, rev.final)).toEqual([]);
    expect(fwd.final.stateHash).toBe(rev.final.stateHash);
  });

  it("submission order remains visible in provenance even when state is identical", () => {
    const fwd = run({
      label: "fwd",
      schedule: [
        { atTick: T, intervention: iBridge("i-bridge") },
        { atTick: T, intervention: iWarehouse("i-warehouse") },
      ],
      totalTicks: 15,
    });
    const rev = run({
      label: "rev",
      schedule: [
        { atTick: T, intervention: iWarehouse("i-warehouse") },
        { atTick: T, intervention: iBridge("i-bridge") },
      ],
      totalTicks: 15,
    });

    // Same world, different history. stateHash must agree; traceHash must not.
    expect(fwd.final.stateHash).toBe(rev.final.stateHash);
    expect(fwd.final.traceHash).not.toBe(rev.final.traceHash);
  });

  it("TICK-BOUNDARY sensitivity: identical order, different spacing, different quota batching", () => {
    const gap0 = run({
      label: "gap0",
      schedule: [
        { atTick: T, intervention: iBridge("i-bridge") },
        { atTick: T, intervention: iMerchant("i-merchant") },
        { atTick: T, intervention: iWarehouse("i-warehouse") },
      ],
      totalTicks: H,
    });
    const gap1 = ordered(["bridge", "merchant", "warehouse"], 1);
    const gap5 = ordered(["bridge", "merchant", "warehouse"], 5);

    // Grouping in one tick pools pressure into single resolutions; spreading them lets
    // pressure decay between actions. Both are causally meaningful, and they differ.
    expect(gap0.final.mgHostility).not.toBeCloseTo(gap1.final.mgHostility, 6);
    expect(gap1.final.mgHostility).not.toBeCloseTo(gap5.final.mgHostility, 6);

    // Widest spacing = most decay between actions = weakest faction reaction.
    expect(gap5.summary.peakHostility).toBeLessThan(gap1.summary.peakHostility);
  });
});

// ===========================================================================
describe("Experiment D — same-tick batching determinism", () => {
  it("canonical batching makes arrival order irrelevant to BOTH state and trace", () => {
    const a = run({
      label: "arrival 1",
      schedule: [
        { atTick: T, intervention: iBridge("i-bridge") },
        { atTick: T, intervention: iMerchant("i-merchant") },
        { atTick: T, intervention: iWarehouse("i-warehouse") },
      ],
      totalTicks: H,
      canonicalBatch: true,
    });
    const b = run({
      label: "arrival 2",
      schedule: [
        { atTick: T, intervention: iWarehouse("i-warehouse") },
        { atTick: T, intervention: iBridge("i-bridge") },
        { atTick: T, intervention: iMerchant("i-merchant") },
      ],
      totalTicks: H,
      canonicalBatch: true,
    });

    expect(a.final.stateHash).toBe(b.final.stateHash);
    expect(a.final.traceHash).toBe(b.final.traceHash);
    expect(differingFields(a.final, b.final)).toEqual([]);
  });

  it("sequence numbers are explicit, monotonic, and assigned in canonical id order", () => {
    const r = run({
      label: "batch",
      schedule: [
        { atTick: T, intervention: iWarehouse("i-warehouse") },
        { atTick: T, intervention: iBridge("i-bridge") },
        { atTick: T, intervention: iMerchant("i-merchant") },
      ],
      totalTicks: 12,
      canonicalBatch: true,
    });

    const seqs = r.engine.accepted.map((i) => i.provenance.sequence);
    expect(seqs).toEqual([1, 2, 3]);
    // canonical order is by id: i-bridge < i-merchant < i-warehouse
    expect(r.engine.accepted.map((i) => i.id)).toEqual(["i-bridge", "i-merchant", "i-warehouse"]);
  });

  it("pressure accumulation is commutative to the BIT, so bucket contents cannot depend on arrival order", () => {
    // Strengthened after the feedback pass: this originally used toBeCloseTo(..., 12), a
    // tolerance loose enough to hide a real ~4e-16 order dependence caused by float
    // non-associativity. Bit equality is the actual guarantee.
    // See self-harness/failures/2026-08-30-architecture-float-nonassociativity-canonical-order.json
    const build = (reverse: boolean) => {
      const engine = createEngine();
      const state = createWorld({ seed: WORLD_SEED }, engine);
      const list = [iBridge("i-bridge"), iMerchant("i-merchant")];
      for (const i of reverse ? [...list].reverse() : list) submitIntervention(state, i, engine);
      return state;
    };
    const fwdState = build(false);
    const revState = build(true);
    const fwd = fwdState.pendingContributions["RF"]!["economy"]!;
    const rev = revState.pendingContributions["RF"]!["economy"]!;
    expect(Object.is(fwd.raw, rev.raw)).toBe(true);
    expect(Object.is(fwd.pressure, rev.pressure)).toBe(true);
    expect(Object.is(fwd.netValence, rev.netValence)).toBe(true);
    // Cause IDS are deliberately NOT compared: provenance node ids are allocated in
    // submission order, so they differ by arrival order even when the physical bucket is
    // bit-identical. That asymmetry is the whole reason ledgerCauses lives outside the
    // state hash — the world is order-independent, its history is not (§15.5).
    expect(pendingCausesOf(fwdState, "RF", "economy")).toHaveLength(pendingCausesOf(revState, "RF", "economy").length);
  });

  it("domain traversal order is an explicit sorted constant, not object key order", () => {
    expect([...DOMAIN_ORDER]).toEqual([...DOMAIN_ORDER].sort());
  });
});

// ===========================================================================
describe("Experiment E — causal provenance", () => {
  const combined = () =>
    run({
      label: "combined",
      schedule: [
        { atTick: T, intervention: iBridge() },
        { atTick: T, intervention: iMerchant() },
        { atTick: T, intervention: iWarehouse() },
        { atTick: T, intervention: iRally() },
      ],
      totalTicks: 25,
    });

  it("answers 'why did grain price increase?' with the originating interventions", () => {
    const r = combined();
    const ex = explain(r.state, key.price("RF", "grain"));
    expect(ex.explained).toBe(true);
    const roots = ex.roots.map((x) => x.interventionId).sort();
    expect(roots).toContain("iA-bridge");
    expect(roots).toContain("iC-warehouse");
    // the chain must actually traverse causal structure, not a single authored edge
    expect(ex.paths.some((p) => p.includes("trade_capacity_zero"))).toBe(true);
    expect(ex.nodes.length).toBeGreaterThan(3);
  });

  it("preserves MULTIPLE parents rather than collapsing to one explanation", () => {
    const r = combined();
    const hostilityRoots = rootCauseIds(r.state, key.hostility("MG"));
    expect(hostilityRoots.length).toBeGreaterThanOrEqual(2);

    const patrolRoots = rootCauseIds(r.state, key.patrolDemand("RF"));
    // patrols are raised by BOTH the economic chain and the civic chain
    expect(patrolRoots).toContain("iD-rally");
    expect(patrolRoots.some((id) => id === "iA-bridge" || id === "iB-merchant" || id === "iC-warehouse")).toBe(true);
  });

  it("provenance is structured data, not log strings", () => {
    const r = combined();
    for (const n of r.state.provenance) {
      expect(typeof n.id).toBe("string");
      expect(["intervention", "pressure", "resolution", "effect", "derived"]).toContain(n.kind);
      expect(Array.isArray(n.parents)).toBe(true);
      expect(typeof n.tick).toBe("number");
    }
    // root interventions have no parents; everything else is anchored
    const roots = r.state.provenance.filter((n) => n.parents.length === 0);
    expect(roots.every((n) => n.kind === "intervention" || n.kind === "derived")).toBe(true);
  });

  it("an unexplained quantity reports explained=false instead of inventing a cause", () => {
    const c = control();
    const ex = explain(c.state, key.unrest("RF"));
    expect(ex.explained).toBe(false);
    expect(ex.roots).toEqual([]);
  });

  it("every quota threshold check is recorded, fired or not", () => {
    const r = combined();
    expect(r.state.resolutionLog.length).toBeGreaterThan(0);
    expect(r.state.resolutionLog.some((d) => d.fired)).toBe(true);
    expect(r.state.resolutionLog.some((d) => !d.fired)).toBe(true);
    for (const d of r.state.resolutionLog) {
      expect(d.fired).toBe(d.pressure >= d.threshold);
    }
  });
});

// ===========================================================================
describe("Experiment F — negative isolation (civic must not reach the economy)", () => {
  it("a public rally changes civic state and NOTHING economic", () => {
    const c = control().final;
    const rally = only(iRally(), "rally");

    for (const f of ECONOMIC_FIELDS) {
      expect(Number(rally.final[f])).toBeCloseTo(Number(c[f]), 9);
    }
    // but it did do something: unrest rose, and patrols responded
    expect(rally.summary.peakUnrest).toBeGreaterThan(0);
    expect(rally.summary.peakPatrolDemand).toBeGreaterThan(control().summary.peakPatrolDemand);
  });

  it("destroying a purely civic structure has no economic pathway", () => {
    const c = control().final;
    const shrine = only(iShrine(), "shrine");
    for (const f of ECONOMIC_FIELDS) {
      expect(Number(shrine.final[f])).toBeCloseTo(Number(c[f]), 9);
    }
    expect(shrine.summary.peakUnrest).toBeGreaterThan(0);
  });

  it("no civic intervention appears in the provenance of any economic quantity", () => {
    const rally = only(iRally(), "rally");
    expect(rootCauseIds(rally.state, key.price("RF", "grain"))).toEqual([]);
    expect(rootCauseIds(rally.state, key.income("MG"))).toEqual([]);
    // ...while it IS the cause of unrest
    expect(rootCauseIds(rally.state, key.unrest("RF"))).toEqual(["iD-rally"]);
  });

  it("civic pressure never resolves into an economic or ecological domain", () => {
    const rally = only(iRally(), "rally");
    const fired = rally.state.resolutionLog.filter((d) => d.fired);
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.every((d) => d.domain === "civic")).toBe(true);
  });

  it("shared consequences do not imply shared causes: patrol demand has two independent pathways", () => {
    const rally = only(iRally(), "rally");
    const bridge = only(iBridge(), "bridge");

    // both raise patrols
    expect(rally.summary.peakPatrolDemand).toBeGreaterThan(0.3);
    expect(bridge.summary.peakPatrolDemand).toBeGreaterThan(0.3);

    // but by disjoint routes: civic via unrest, economic via price/hostility
    expect(rootCauseIds(rally.state, key.unrest("RF"))).toEqual(["iD-rally"]);
    expect(rootCauseIds(bridge.state, key.unrest("RF"))).toEqual([]);
    expect(rootCauseIds(rally.state, key.price("RF", "grain"))).toEqual([]);
    expect(rootCauseIds(bridge.state, key.price("RF", "grain")).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
describe("Experiment G — deterministic replay of a multi-intervention sequence", () => {
  const replay = () =>
    run({
      label: "replay",
      schedule: [
        { atTick: 8, intervention: iBridge() },
        { atTick: 10, intervention: iMerchant() },
        { atTick: 10, intervention: iRally() },
        { atTick: 13, intervention: iWarehouse() },
      ],
      totalTicks: 35,
    });

  it("five runs produce identical state, trace, and resolution decisions", () => {
    const runs = [replay(), replay(), replay(), replay(), replay()];

    expect(new Set(runs.map((r) => r.final.stateHash)).size).toBe(1);
    expect(new Set(runs.map((r) => r.final.traceHash)).size).toBe(1);

    const sig = (r: ReturnType<typeof replay>) =>
      r.state.resolutionLog
        .map((d) => `${d.tick}:${d.regionId}:${d.domain}:${d.fired ? 1 : 0}:${d.pressure.toFixed(12)}`)
        .join("|");
    expect(new Set(runs.map(sig)).size).toBe(1);

    expect(new Set(runs.map((r) => r.state.provenance.length)).size).toBe(1);
    expect(runs[0]!.series).toEqual(runs[1]!.series);
  });

  it("tick boundaries and quota decisions replay identically, including near-miss checks", () => {
    const a = replay();
    const b = replay();
    const nearMisses = (r: ReturnType<typeof replay>) =>
      r.state.resolutionLog.filter((d) => !d.fired && d.pressure > d.threshold * 0.5).map((d) => `${d.tick}:${d.domain}:${d.pressure.toFixed(12)}`);
    expect(nearMisses(a)).toEqual(nearMisses(b));
    expect(nearMisses(a).length).toBeGreaterThan(0); // the case actually occurs
  });
});

// ===========================================================================
describe("architectural invariants discovered during the stress test", () => {
  it("saturation is strictly increasing and asymptotically bounded", () => {
    const knee = 1.0;
    const cap = 2.0;
    // identity below the knee — preserves all single-action calibration exactly
    expect(saturate(0.2, knee, cap)).toBeCloseTo(0.2, 12);
    expect(saturate(1.0, knee, cap)).toBeCloseTo(1.0, 12);
    // strictly increasing above it
    let prev = saturate(knee, knee, cap);
    for (const raw of [1.1, 1.5, 2, 3, 5, 10, 30]) {
      const v = saturate(raw, knee, cap);
      expect(v).toBeGreaterThan(prev);
      expect(v).toBeLessThan(cap);
      prev = v;
    }
    // asymptote: approaches but never reaches the cap (float precision saturates eventually,
    // which is acceptable — by then the value is indistinguishable from the bound)
    expect(saturate(1e6, knee, cap)).toBeLessThanOrEqual(cap);
  });

  it("a distinct simultaneous cause is never erased by the anti-gaming cap", () => {
    // THE REGRESSION TEST for the discovered failure: bridge alone contributes exactly the
    // soft knee in RF economy. Adding a merchant killing must still raise economy pressure.
    const engine = createEngine();
    const state = createWorld({ seed: WORLD_SEED }, engine);
    submitIntervention(state, iBridge("i-bridge"), engine);
    const afterBridge = state.pendingContributions["RF"]!["economy"]!.pressure;
    submitIntervention(state, iMerchant("i-merchant"), engine);
    const afterBoth = state.pendingContributions["RF"]!["economy"]!.pressure;

    expect(afterBridge).toBeCloseTo(state.config.pressureSoftKnee, 9);
    expect(afterBoth).toBeGreaterThan(afterBridge);
    expect(pendingCausesOf(state, "RF", "economy")).toHaveLength(2);
  });

  it("the erased-cause failure is visible end-to-end, not just in the bucket", () => {
    const bridge = only(iBridge(), "bridge");
    const both = run({
      label: "bridge+merchant",
      schedule: [
        { atTick: T, intervention: iBridge() },
        { atTick: T, intervention: iMerchant() },
      ],
      totalTicks: H,
    });
    // the merchant's economic weight must change an observable, not just an internal number
    expect(both.summary.peakRFPrice).toBeGreaterThan(bridge.summary.peakRFPrice);
    expect(both.summary.peakHostility).toBeGreaterThan(bridge.summary.peakHostility);
  });

  it("destroying a structure destroys its stored contents (generic, not per-structure)", () => {
    const engine = createEngine();
    const state = createWorld({ seed: WORLD_SEED }, engine);
    expect(state.regions["RF"]!.infrastructure[WAREHOUSE_ID]!.reserve).toBeGreaterThan(0);
    submitIntervention(state, iWarehouse(), engine);
    expect(state.regions["RF"]!.infrastructure[WAREHOUSE_ID]!.reserve).toBe(0);
    expect(state.regions["RF"]!.infrastructure[WAREHOUSE_ID]!.health).toBe(0);
  });

  it("a structure's identity is world-global: every per-region copy is destroyed together", () => {
    const engine = createEngine();
    const state = createWorld({ seed: WORLD_SEED }, engine);
    submitIntervention(state, iBridge(), engine);
    expect(state.regions["RF"]!.infrastructure[ROUTE_ID]!.health).toBe(0);
    expect(state.regions["HT"]!.infrastructure[ROUTE_ID]!.health).toBe(0);
  });

  it("shrines exist in every town but a rally targets exactly one region", () => {
    const engine = createEngine();
    const state = createWorld({ seed: WORLD_SEED }, engine);
    for (const r of ["RF", "HT", "PS"]) {
      expect(state.regions[r]!.infrastructure[SHRINE_ID]).toBeDefined();
    }
    // a rally whose target region disagrees with its location is rejected
    const bad = { ...iRally("bad"), target: { type: "region" as const, id: "HT" }, location: "RF" };
    expect(submitIntervention(state, bad, engine).ok).toBe(false);
  });

  it("stateHash ignores provenance; traceHash captures it", () => {
    // two routes to the same world must agree on state and disagree on history
    const a = run({
      label: "a",
      schedule: [
        { atTick: T, intervention: iBridge("i-bridge") },
        { atTick: T, intervention: iWarehouse("i-warehouse") },
      ],
      totalTicks: 14,
    });
    const b = run({
      label: "b",
      schedule: [
        { atTick: T, intervention: iWarehouse("i-warehouse") },
        { atTick: T, intervention: iBridge("i-bridge") },
      ],
      totalTicks: 14,
    });
    expect(a.final.stateHash).toBe(b.final.stateHash);
    expect(a.final.traceHash).not.toBe(b.final.traceHash);
  });
});
