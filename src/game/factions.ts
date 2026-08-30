import { PROD_RATES, RESOURCES } from "./content.js";
import type { RegionId, WorldState } from "../core/types.js";
import type { EventBus } from "../core/event-bus.js";
import { emit } from "../core/event-bus.js";
import { key, record, refsOf, setRef } from "../core/provenance.js";

/**
 * Heartbeat (phase 2): faction incomes, hostility decay, per-region patrol demand.
 * Pure, no RNG, fixed order.
 */
export function heartbeatFactions(state: WorldState): void {
  const cfg = state.config;

  // MG hostility toward the player decays each tick toward the floor.
  const prevHostility = state.relations["MG>player"] ?? cfg.hostilityFloor;
  state.relations["MG>player"] = Math.max(cfg.hostilityFloor, prevHostility - cfg.hostilityDecayPerTick);

  // Merchant Guild: income = margin x trade volume (set by the economy heartbeat).
  const mg = state.entities["MG"];
  if (mg) {
    const prevIncome = mg.attrs.incomeRate as number;
    const income = cfg.mgMargin * state.tradeVolume;
    mg.attrs.incomeRate = income;
    mg.attrs.treasury = (mg.attrs.treasury as number) + income;

    // Income is derived from trade volume; when it changes, cite whatever explains trade.
    if (Math.abs(income - prevIncome) > 1e-9) {
      const parents = refsOf(
        state,
        ...Object.keys(state.regions).sort().map((r) => key.tradeBlocked(r)),
        ...Object.keys(state.regions).sort().map((r) => key.stock(r, "grain")),
      );
      const node = record(state, {
        tick: state.tick,
        kind: "derived",
        label: "faction_income",
        value: income,
        detail: { factionId: "MG", tradeVolume: state.tradeVolume },
        parents,
      });
      setRef(state, key.income("MG"), node);
    }
  }

  // City Watch: constant tax income = rate x sum(production value) over all towns.
  const wa = state.entities["WA"];
  if (wa) {
    let gdp = 0;
    for (const regionId of Object.keys(state.regions).sort()) {
      for (const res of RESOURCES) {
        gdp += (PROD_RATES[regionId]?.[res.id] ?? 0) * res.basePrice;
      }
    }
    wa.attrs.incomeRate = cfg.waTaxRate * gdp;
    wa.attrs.treasury = (wa.attrs.treasury as number) + (wa.attrs.incomeRate as number);
  }

  // Per-region patrol demand: base + hostility + food shortage + civic unrest.
  // Note unrest is a SEPARATE additive pathway: civic pressure can raise patrols without
  // ever touching prices (Experiment F), while economic shortage can raise patrols without
  // any civic event. Two independent causes, one shared consequence.
  const hostility = state.relations["MG>player"] ?? cfg.hostilityFloor;
  for (const regionId of Object.keys(state.regions).sort()) {
    const region = state.regions[regionId];
    if (!region) continue;

    // civic unrest decays on its own schedule
    if (region.unrest > 0) {
      region.unrest = Math.max(0, region.unrest - cfg.unrestDecayPerTick);
    }

    const shortage = (region.prices["grain"] ?? 0) > cfg.shortagePriceThreshold ? 1 : 0;
    const prev = region.patrolDemand;
    const next = Math.max(
      0,
      Math.min(1, cfg.patrolBase + cfg.patrolGain * (hostility + shortage) + cfg.patrolUnrestGain * region.unrest),
    );
    region.patrolDemand = next;

    if (Math.abs(next - prev) > 1e-9) {
      // Parents: whichever inputs are actually explained right now. A patrol rise caused
      // only by unrest will NOT list price as a parent, and vice versa.
      const parents = refsOf(
        state,
        key.hostility("MG"),
        ...(shortage === 1 ? [key.price(regionId, "grain")] : []),
        ...(region.unrest > 0 ? [key.unrest(regionId)] : []),
      );
      if (parents.length > 0) {
        const node = record(state, {
          tick: state.tick,
          kind: "derived",
          label: "patrol_activity",
          regionId,
          value: next,
          detail: { hostility, shortage, unrest: region.unrest },
          parents,
        });
        setRef(state, key.patrolDemand(regionId), node);
      }
    }
  }
}

/** Faction resolution pass (quota). No RNG. */
export function resolveFaction(
  state: WorldState,
  regionId: RegionId,
  p: number,
  bus: EventBus,
  causes: string[],
): void {
  const cfg = state.config;
  const resolution = record(state, {
    tick: state.tick,
    kind: "resolution",
    label: "faction_resolution",
    regionId,
    domain: "faction",
    value: p,
    parents: causes,
  });

  const delta = cfg.factionPressureToHostility * p;
  state.relations["MG>player"] = (state.relations["MG>player"] ?? cfg.hostilityFloor) + delta;
  const node = record(state, {
    tick: state.tick,
    kind: "effect",
    label: "faction_hostility",
    regionId,
    value: state.relations["MG>player"],
    detail: { factionId: "MG", delta, via: "faction" },
    parents: [resolution, ...refsOf(state, key.hostility("MG"))],
  });
  setRef(state, key.hostility("MG"), node);

  emit(state, bus, "faction.relations_change", "faction", regionId, { factionId: "MG", amount: delta });
}
