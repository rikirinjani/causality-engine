import { createEngine, createWorld, submitIntervention, tick } from "../core/world.js";
import { stateHash } from "../core/hash.js";
import { ROUTE_ID, WORLD_SEED } from "../game/content.js";
import type { Intervention, WorldState } from "../core/types.js";

export interface MetricPoint {
  tick: number;
  RF: { grainStock: number; grainPrice: number };
  HT: { grainStock: number; grainPrice: number };
  PS: { grainStock: number; grainPrice: number };
  tradeVolume: number;
  mgIncomeRate: number;
  mgTreasury: number;
  mgHostility: number;
  rfPatrolDemand: number;
  rfGuardPatrolling: boolean;
}

export function metrics(state: WorldState): MetricPoint {
  const rf = state.regions["RF"]!;
  const ht = state.regions["HT"]!;
  const ps = state.regions["PS"]!;
  const mg = state.entities["MG"]!;
  const a13 = state.entities["a13"]!;
  return {
    tick: state.tick,
    RF: { grainStock: rf.stocks["grain"] ?? 0, grainPrice: rf.prices["grain"] ?? 0 },
    HT: { grainStock: ht.stocks["grain"] ?? 0, grainPrice: ht.prices["grain"] ?? 0 },
    PS: { grainStock: ps.stocks["grain"] ?? 0, grainPrice: ps.prices["grain"] ?? 0 },
    tradeVolume: state.tradeVolume,
    mgIncomeRate: mg.attrs.incomeRate as number,
    mgTreasury: mg.attrs.treasury as number,
    mgHostility: state.relations["MG>player"] ?? 0.1,
    rfPatrolDemand: rf.patrolDemand,
    rfGuardPatrolling: a13.attrs.patrolling === true,
  };
}

function makeIntervention(): Intervention {
  return {
    id: "i1",
    tick: 0,
    actor: "player",
    action: "destroy_infrastructure",
    target: { type: "infrastructure", id: ROUTE_ID },
    location: "RF",
    intent: "experiment: destroy the grain road",
    magnitude: 1,
    causalDomains: [],
    provenance: { submittedAtTick: 0, sequence: 0 },
  };
}

export function runScenario(
  seed: number,
  withIntervention: boolean,
  totalTicks: number,
): { state: WorldState; trace: MetricPoint[]; hash: string } {
  const engine = createEngine();
  const state = createWorld({ seed }, engine);
  const trace: MetricPoint[] = [];
  for (let t = 1; t <= totalTicks; t++) {
    if (withIntervention && t === 10) {
      const res = submitIntervention(state, makeIntervention(), engine);
      if (!res.ok) throw new Error(`intervention rejected: ${res.errors.join("; ")}`);
    }
    tick(state, engine);
    trace.push(metrics(state));
  }
  return { state, trace, hash: stateHash(state) };
}

function fmt(n: number): string {
  return n.toFixed(2);
}

export function main(): void {
  const control = runScenario(WORLD_SEED, false, 30);
  const intervention = runScenario(WORLD_SEED, true, 30);

  console.log("=== Causality Engine PoC — causal propagation ===");
  console.log("seed =", WORLD_SEED, "| scenario = destroy grain_road at tick 10 | horizon = 30 ticks\n");

  console.log("--- intervention run trace (selected metrics per tick) ---");
  for (const m of intervention.trace) {
    if (m.tick === 1 || m.tick === 10 || m.tick === 11 || m.tick === 12 || m.tick === 20 || m.tick === 30) {
      console.log(
        `t${String(m.tick).padStart(2)} | RF grain ${fmt(m.RF.grainStock)}@${fmt(m.RF.grainPrice)} | HT ${fmt(m.HT.grainStock)}@${fmt(m.HT.grainPrice)} | PS ${fmt(m.PS.grainStock)}@${fmt(m.PS.grainPrice)} | trade ${fmt(m.tradeVolume)} | MG income ${fmt(m.mgIncomeRate)} | hostility ${fmt(m.mgHostility)} | RF patrol ${fmt(m.rfPatrolDemand)} | guard patrolling ${m.rfGuardPatrolling}`,
      );
    }
  }

  console.log("\n--- diff table (tick 30: control vs intervention) ---");
  const c = control.trace[control.trace.length - 1]!;
  const i = intervention.trace[intervention.trace.length - 1]!;
  const rows: Array<[string, number, number]> = [
    ["RF grain price", c.RF.grainPrice, i.RF.grainPrice],
    ["HT grain price", c.HT.grainPrice, i.HT.grainPrice],
    ["PS grain price", c.PS.grainPrice, i.PS.grainPrice],
    ["trade volume", c.tradeVolume, i.tradeVolume],
    ["MG income rate", c.mgIncomeRate, i.mgIncomeRate],
    ["MG hostility", c.mgHostility, i.mgHostility],
    ["RF patrol demand", c.rfPatrolDemand, i.rfPatrolDemand],
    ["RF guard patrolling", c.rfGuardPatrolling ? 1 : 0, i.rfGuardPatrolling ? 1 : 0],
  ];
  console.log(`${"metric".padEnd(20)} | control | intervention | delta`);
  for (const [name, cv, iv] of rows) {
    console.log(`${name.padEnd(20)} | ${fmt(cv).padStart(8)} | ${fmt(iv).padStart(12)} | ${fmt(iv - cv).padStart(6)}`);
  }

  console.log("\n--- causal chain verdict ---");
  console.log("player destroys grain road");
  console.log("  -> trade volume:      " + (i.tradeVolume === 0 ? "DISRUPTED (0)" : "ok"));
  console.log("  -> RF grain stock:    " + (i.RF.grainStock < c.RF.grainStock ? "SHORTAGE" : "ok"));
  console.log("  -> RF grain price:    " + (i.RF.grainPrice > c.RF.grainPrice ? "UP" : "flat"));
  console.log("  -> MG income:         " + (i.mgIncomeRate < c.mgIncomeRate ? "DOWN" : "flat"));
  console.log("  -> MG hostility:      " + (i.mgHostility > c.mgHostility ? "UP" : "flat"));
  console.log("  -> RF patrols:        " + (i.rfPatrolDemand > c.rfPatrolDemand ? "UP" : "flat"));
  console.log("  -> RF guard patrols:  " + (i.rfGuardPatrolling ? "ACTIVE" : "inactive"));
  console.log("  -> PS locality:       " + (Math.abs(i.PS.grainPrice - 10) < 0.01 ? "UNAFFECTED" : "AFFECTED"));

  console.log("\n--- determinism evidence ---");
  const rerun = runScenario(WORLD_SEED, true, 30);
  console.log("stateHash (run 1):   ", intervention.hash);
  console.log("stateHash (rerun):   ", rerun.hash);
  console.log("identical:           ", intervention.hash === rerun.hash);

  console.log("\n--- event stream sample (intervention run) ---");
  const interesting = intervention.state.events.filter((e) => e.tick >= 10).slice(0, 8);
  for (const e of interesting) {
    console.log(`t${e.tick} ${e.type.padEnd(30)} ${JSON.stringify(e.data)}`);
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("poc/main.ts")) {
  main();
}
