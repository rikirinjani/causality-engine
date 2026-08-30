import { describe, expect, it } from "vitest";
import { advance, createEngine, createWorld, restore, snapshot, submitIntervention, tick } from "../core/world.js";
import { stateHash } from "../core/hash.js";
import { hopDistances, pendingCausesOf } from "../core/propagation.js";
import { uniformThresholds } from "../core/config.js";
import { ROUTE_ID, WORLD_SEED } from "../game/content.js";
import { metrics, runScenario, type MetricPoint } from "./main.js";
import type { Intervention } from "../core/types.js";

function makeIntervention(): Intervention {
  return {
    id: "i1",
    tick: 0,
    actor: "player",
    action: "destroy_infrastructure",
    target: { type: "infrastructure", id: ROUTE_ID },
    location: "RF",
    intent: "test",
    magnitude: 1,
    causalDomains: [],
    provenance: { submittedAtTick: 0, sequence: 0 },
  };
}

function killMerchant(id: string, location = "RF"): Intervention {
  return {
    id: `k-${id}`,
    tick: 0,
    actor: "player",
    action: "kill_entity",
    target: { type: "entity", id },
    location,
    intent: "test",
    magnitude: 1,
    causalDomains: [],
    provenance: { submittedAtTick: 0, sequence: 0 },
  };
}

const last = (trace: MetricPoint[]): MetricPoint => trace[trace.length - 1]!;

describe("Causality Engine PoC", () => {
  it("determinism: same seed + same interventions -> identical evolution (trace, stateHash, events)", () => {
    const a = runScenario(WORLD_SEED, true, 30);
    const b = runScenario(WORLD_SEED, true, 30);
    expect(a.trace).toEqual(b.trace);
    expect(a.hash).toBe(b.hash);
    expect(a.state.events).toEqual(b.state.events);
  });

  it("causal chain: destroy grain road -> trade down -> price up -> MG income down -> hostility up -> patrols up -> guards patrol", () => {
    const control = runScenario(WORLD_SEED, false, 30);
    const intervention = runScenario(WORLD_SEED, true, 30);
    const c = last(control.trace);
    const i = last(intervention.trace);

    expect(i.tradeVolume).toBe(0); // trade disrupted
    expect(i.RF.grainPrice).toBeGreaterThan(c.RF.grainPrice + 0.5); // shortage -> price up
    expect(i.mgIncomeRate).toBeLessThan(c.mgIncomeRate - 0.5); // merchant income down
    expect(i.mgHostility).toBeGreaterThan(c.mgHostility + 0.1); // faction hostility up
    expect(i.rfPatrolDemand).toBeGreaterThan(c.rfPatrolDemand + 0.05); // patrols up
    expect(i.rfGuardPatrolling).toBe(true); // NPC behavior change: guards actually patrol
    expect(c.rfGuardPatrolling).toBe(false);
    expect(intervention.state.events.some((e) => e.type === "economy.trade_disruption")).toBe(true);
  });

  it("locality: Portside (no route) stays economically unaffected while Riverford/Hilltown react", () => {
    const intervention = runScenario(WORLD_SEED, true, 30);
    const i = last(intervention.trace);
    expect(Math.abs(i.PS.grainPrice - 10)).toBeLessThan(0.01); // PS price unchanged
    expect(Math.abs(i.PS.grainStock - 50)).toBeLessThan(0.01); // PS stock unchanged
    expect(i.RF.grainPrice).toBeGreaterThan(15); // RF shortage
  });

  it("snapshot/restore continuity: restored world evolves identically to uninterrupted run", () => {
    const engineA = createEngine();
    const stateA = createWorld({ seed: WORLD_SEED }, engineA);
    advance(stateA, engineA, 20);
    const hashA = stateHash(stateA);

    const engineB = createEngine();
    const stateB = createWorld({ seed: WORLD_SEED }, engineB);
    advance(stateB, engineB, 10);
    const snap = snapshot(stateB);
    restore(stateB, snap, engineB);
    advance(stateB, engineB, 10);
    const hashB = stateHash(stateB);

    expect(hashB).toBe(hashA);
  });

  it("intervention validation: unknown action and bad target are rejected", () => {
    const engine = createEngine();
    const state = createWorld({ seed: WORLD_SEED }, engine);
    expect(submitIntervention(state, { ...makeIntervention(), action: "nonsense" }, engine).ok).toBe(false);
    expect(
      submitIntervention(state, { ...makeIntervention(), target: { type: "infrastructure", id: "nope" } }, engine).ok,
    ).toBe(false);
    expect(submitIntervention(state, makeIntervention(), engine).ok).toBe(true);
  });

  it("quota saturation: repeated spam of one action is bounded, but never erases a distinct cause", () => {
    const engine = createEngine();
    const state = createWorld({ seed: WORLD_SEED }, engine);

    // A genuinely REPEATABLE action. (The original version of this test submitted the same
    // destroy_infrastructure five times; four were rejected as already-destroyed, so it was
    // passing without ever exercising the cap. See
    // self-harness/failures/2026-08-30-architecture-causal-saturation-under-cap.json)
    const rally = (id: string): Intervention => ({
      id,
      tick: 0,
      actor: "player",
      action: "hold_public_rally",
      target: { type: "region", id: "RF" },
      location: "RF",
      magnitude: 1,
      causalDomains: [],
      provenance: { submittedAtTick: 0, sequence: 0 },
    });

    const observed: number[] = [];
    for (let n = 0; n < 8; n++) {
      expect(submitIntervention(state, rally(`r${n}`), engine).ok).toBe(true);
      observed.push(state.pendingContributions["RF"]!["civic"]!.pressure);
    }

    const cap = state.config.capPerDomainRegionTick;
    // strictly increasing — no contribution is ever causally invisible
    for (let i = 1; i < observed.length; i++) {
      expect(observed[i]!).toBeGreaterThan(observed[i - 1]!);
    }
    // asymptotically bounded — spam cannot produce unlimited pressure
    expect(observed[observed.length - 1]!).toBeLessThan(cap);
    expect(state.pendingContributions["RF"]!["civic"]!.raw).toBeCloseTo(8, 6);
    // every contributor stays visible in provenance
    expect(pendingCausesOf(state, "RF", "civic")).toHaveLength(8);
    expect(state.pendingContributions["RF"]!["civic"]!.origin).toBe("primary");
  });

  it("config lives in state: different tuning produces a different state hash (closes the KE provenance gap)", () => {
    const e1 = createEngine();
    const s1 = createWorld({ seed: WORLD_SEED }, e1);
    advance(s1, e1, 5);

    const e2 = createEngine();
    const s2 = createWorld({ seed: WORLD_SEED, thresholds: uniformThresholds(0.9) }, e2);
    advance(s2, e2, 5);

    expect(stateHash(s2)).not.toBe(stateHash(s1));
  });

  describe("cross-region boundary signals (locality mechanism)", () => {
    it("hop distances are bounded by maxHops and exclude the origin", () => {
      const engine = createEngine();
      const state = createWorld({ seed: WORLD_SEED }, engine);
      const hops = hopDistances(state, "RF", 2);
      expect(hops).toEqual([
        { regionId: "HT", hops: 1 },
        { regionId: "PS", hops: 2 },
      ]);
      expect(hopDistances(state, "RF", 0)).toEqual([]);
    });

    it("neighbours receive decayed pressure, and farther regions receive strictly less", () => {
      const engine = createEngine();
      const state = createWorld({ seed: WORLD_SEED }, engine);
      advance(state, engine, 5);
      submitIntervention(state, makeIntervention(), engine);
      tick(state, engine); // merge + resolve RF/HT -> queue boundary signals

      const signals = state.events.filter((e) => e.type === "world.boundary_signal");
      expect(signals.length).toBeGreaterThan(0);

      // RF resolving economy sends hop-1 to HT and hop-2 to PS, hop-2 strictly weaker
      const fromRF = signals.filter((e) => e.data.from === "RF" && e.data.domain === "economy");
      const hop1 = fromRF.find((e) => e.data.hops === 1);
      const hop2 = fromRF.find((e) => e.data.hops === 2);
      expect(hop1).toBeDefined();
      expect(hop2).toBeDefined();
      expect(hop2!.data.pressure as number).toBeLessThan(hop1!.data.pressure as number);

      // and the signal actually lands as pressure in the neighbour's next-tick bucket
      expect(state.pendingContributions["PS"]?.["economy"]?.pressure).toBeGreaterThan(0);
      expect(state.pendingContributions["PS"]?.["economy"]?.origin).toBe("boundary");
    });

    it("no runaway feedback: pressure never re-propagates and every ledger eventually drains", () => {
      const engine = createEngine();
      const state = createWorld({ seed: WORLD_SEED }, engine);
      advance(state, engine, 5);
      submitIntervention(state, makeIntervention(), engine);

      const resolutionTypes = ["economy.trade_disruption", "ecology.food_availability", "faction.relations_change"];
      advance(state, engine, 1); // the single resolution burst
      const burstEnd = state.tick;
      const afterBurst = state.events.length;

      advance(state, engine, 80);

      // no further resolutions after the burst — boundary pressure did not cascade back
      const laterResolutions = state.events.slice(afterBurst).filter((e) => resolutionTypes.includes(e.type));
      expect(laterResolutions).toHaveLength(0);
      // ...and no further boundary signals either
      expect(state.events.slice(afterBurst).filter((e) => e.type === "world.boundary_signal")).toHaveLength(0);

      // every ledger has decayed to empty: pressure did not bounce between neighbours forever
      for (const region of Object.values(state.regions)) {
        expect(Object.keys(region.ledger)).toHaveLength(0);
        expect(Object.keys(region.ledgerOrigin)).toHaveLength(0);
      }

      // signals only ever originated from the two regions that held primary pressure
      const signals = state.events.filter((e) => e.type === "world.boundary_signal");
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.every((e) => e.tick === burstEnd)).toBe(true);
      expect(signals.every((e) => e.data.from === "RF" || e.data.from === "HT")).toBe(true);
    });

    it("boundaryMaxHops = 0 disables propagation entirely", () => {
      const engine = createEngine();
      const state = createWorld({ seed: WORLD_SEED, boundaryMaxHops: 0 }, engine);
      advance(state, engine, 5);
      submitIntervention(state, makeIntervention(), engine);
      advance(state, engine, 5);
      expect(state.events.filter((e) => e.type === "world.boundary_signal")).toHaveLength(0);
    });
  });

  describe("kill_entity: immediate effect vs deferred consequence", () => {
    it("removal is immediate, but a single kill stays below threshold and produces no faction consequence", () => {
      const engine = createEngine();
      const state = createWorld({ seed: WORLD_SEED }, engine);
      advance(state, engine, 5);

      expect(submitIntervention(state, killMerchant("a07"), engine).ok).toBe(true);
      // immediate: game feel never waits on the quota
      expect(state.entities["a07"]).toBeUndefined();
      expect(state.regions["RF"]!.population).not.toContain("a07");

      tick(state, engine);
      // pressure 0.3 accumulated then decayed; below the 0.6 threshold -> no resolution.
      // Decay is read from config, not hardcoded: calibration must not break this test.
      expect(state.regions["RF"]!.ledger.faction).toBeCloseTo(0.3 * state.config.ledgerDecayPerTick, 6);
      expect(state.events.some((e) => e.type === "faction.relations_change")).toBe(false);
    });

    it("two kills in one tick cross the threshold and the world reacts", () => {
      const engine = createEngine();
      const state = createWorld({ seed: WORLD_SEED }, engine);
      advance(state, engine, 5);
      const before = state.relations["MG>player"]!;

      submitIntervention(state, killMerchant("a07"), engine);
      submitIntervention(state, killMerchant("a08"), engine);
      // faction 0.3 + 0.3 = 0.6 (at threshold); economy 0.2 + 0.2 = 0.4 (below)
      expect(state.pendingContributions["RF"]?.["faction"]?.pressure).toBeCloseTo(0.6, 6);
      expect(state.pendingContributions["RF"]?.["economy"]?.pressure).toBeCloseTo(0.4, 6);

      tick(state, engine);
      expect(state.events.some((e) => e.type === "faction.relations_change")).toBe(true);
      expect(state.relations["MG>player"]!).toBeGreaterThan(before + 0.15);
      // per-domain thresholds are independent: economy did NOT resolve
      expect(state.events.some((e) => e.type === "economy.trade_disruption")).toBe(false);
      expect(state.regions["RF"]!.ledger.economy).toBeCloseTo(0.4 * state.config.ledgerDecayPerTick, 6);
    });

    it("kill_entity rejects a target in the wrong region", () => {
      const engine = createEngine();
      const state = createWorld({ seed: WORLD_SEED }, engine);
      // a09 lives in HT, not RF
      expect(submitIntervention(state, killMerchant("a09", "RF"), engine).ok).toBe(false);
      expect(state.entities["a09"]).toBeDefined();
    });
  });
});
