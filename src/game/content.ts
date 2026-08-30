import type { Entity, Region, RegionId, ResourceId, Structure } from "../core/types.js";
import type { SimConfig } from "../core/config.js";

export interface ResourceDef {
  id: ResourceId;
  basePrice: number;
}

/** Content: what exists in the world. Tuning lives in core/config.ts. */
export const RESOURCES: ResourceDef[] = [
  { id: "grain", basePrice: 10 },
  { id: "iron", basePrice: 20 },
  { id: "cloth", basePrice: 15 },
  { id: "timber", basePrice: 8 },
  { id: "herbs", basePrice: 25 },
];

/** Production per tick per town. Only grain is imbalanced — the reason the trade route exists. */
export const PROD_RATES: Record<RegionId, Record<ResourceId, number>> = {
  RF: { grain: 8, iron: 4, cloth: 3, timber: 5, herbs: 2 },
  HT: { grain: 16, iron: 4, cloth: 3, timber: 5, herbs: 2 },
  PS: { grain: 10, iron: 4, cloth: 3, timber: 5, herbs: 2 },
};

export const CONS_RATES: Record<RegionId, Record<ResourceId, number>> = {
  RF: { grain: 16, iron: 4, cloth: 3, timber: 5, herbs: 2 },
  HT: { grain: 8, iron: 4, cloth: 3, timber: 5, herbs: 2 },
  PS: { grain: 10, iron: 4, cloth: 3, timber: 5, herbs: 2 },
};

export const WORLD_SEED = 42;

export const ROUTE_ID = "grain_road";
export const WAREHOUSE_ID = "grain_warehouse";
export const SHRINE_ID = "town_shrine";

type AgentSpec = [id: string, role: string, region: RegionId, faction?: string];

const AGENTS: AgentSpec[] = [
  ["a01", "farmer", "RF"],
  ["a02", "farmer", "RF"],
  ["a03", "farmer", "HT"],
  ["a04", "farmer", "HT"],
  ["a05", "farmer", "PS"],
  ["a06", "farmer", "PS"],
  ["a07", "merchant", "RF", "MG"],
  ["a08", "merchant", "RF", "MG"],
  ["a09", "merchant", "HT", "MG"],
  ["a10", "merchant", "HT", "MG"],
  ["a11", "merchant", "PS", "MG"],
  ["a12", "merchant", "PS", "MG"],
  ["a13", "guard", "RF", "WA"],
  ["a14", "guard", "RF", "WA"],
  ["a15", "guard", "HT", "WA"],
  ["a16", "guard", "HT", "WA"],
  ["a17", "guard", "PS", "WA"],
  ["a18", "artisan", "RF"],
  ["a19", "artisan", "HT"],
  ["a20", "artisan", "PS"],
];

export function buildContent(config: SimConfig): {
  regions: Record<RegionId, Region>;
  entities: Record<string, Entity>;
  relations: Record<string, number>;
} {
  const townDefs: Array<[RegionId, string, RegionId[]]> = [
    ["RF", "Riverford", ["HT"]],
    ["HT", "Hilltown", ["RF", "PS"]],
    ["PS", "Portside", ["HT"]],
  ];

  const regions: Record<RegionId, Region> = {};
  for (const [id, name, neighbors] of townDefs) {
    const stocks: Record<ResourceId, number> = {};
    const prices: Record<ResourceId, number> = {};
    for (const res of RESOURCES) {
      stocks[res.id] = config.targetStock;
      prices[res.id] = res.basePrice;
    }
    regions[id] = {
      id,
      name,
      neighbors,
      stocks,
      prices,
      priceShock: {},
      infrastructure: {},
      population: [],
      ledger: {},
      ledgerOrigin: {},
      ledgerValence: {},
      ledgerNegative: {},
      ledgerPositive: {},
      ledgerGeneration: {},
      patrolDemand: 0,
      unrest: 0,
      // Feedback-loop state: full investment, so the baseline world is in equilibrium and
      // any drift is attributable to an intervention rather than to a cold start.
      tradeInvestment: config.investmentMax,
      merchantProfitability: 0,
      tradeCapacityFactor: 1,
    };
  }

  // The single trade route: Grain Road RF <-> HT (grain flows HT -> RF when healthy).
  // Stored as a per-region copy on both endpoints; identity is world-global.
  const route: Structure = { type: "trade_route", health: 1.0, endpoints: ["RF", "HT"] };
  for (const townId of ["RF", "HT"] as RegionId[]) {
    const region = regions[townId];
    if (region) region.infrastructure[ROUTE_ID] = { ...route };
  }

  // Grain warehouse in the importing town: a buffer that releases grain when stock runs low.
  // Its causal weight is CONDITIONAL — it only matters once supply is interrupted, which is
  // what makes bridge+warehouse compose rather than simply add.
  const rf = regions["RF"];
  if (rf) {
    rf.infrastructure[WAREHOUSE_ID] = {
      type: "storage",
      health: 1.0,
      endpoints: ["RF"],
      reserve: config.warehouseInitialReserve,
      resource: "grain",
    };
  }

  // A shrine in every town: a purely civic structure with no economic role.
  // Exists so Experiment F can prove a non-economic intervention stays non-economic.
  for (const townId of ["RF", "HT", "PS"] as RegionId[]) {
    const region = regions[townId];
    if (region) {
      region.infrastructure[SHRINE_ID] = { type: "shrine", health: 1.0, endpoints: [townId] };
    }
  }

  const entities: Record<string, Entity> = {
    MG: { id: "MG", type: "faction", role: "faction", attrs: { treasury: 0, incomeRate: 0 }, location: "RF", factionId: "MG" },
    WA: { id: "WA", type: "faction", role: "faction", attrs: { treasury: 0, incomeRate: 0 }, location: "RF", factionId: "WA" },
  };

  for (const [id, role, regionId, faction] of AGENTS) {
    entities[id] = {
      id,
      type: "agent",
      role,
      attrs: { role, workJitter: 0, ...(role === "guard" ? { patrolling: false } : {}) },
      location: regionId,
      ...(faction ? { factionId: faction } : {}),
    };
    const region = regions[regionId];
    if (region) region.population.push(id);
  }

  const relations: Record<string, number> = { "MG>player": config.hostilityFloor };

  return { regions, entities, relations };
}
