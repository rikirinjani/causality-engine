import { CONS_RATES, PROD_RATES, RESOURCES, ROUTE_ID, WAREHOUSE_ID } from "./content.js";
import type { Region, RegionId, WorldState } from "../core/types.js";
import type { SimConfig } from "../core/config.js";
import type { EventBus } from "../core/event-bus.js";
import { emit } from "../core/event-bus.js";
import { key, record, refsOf, setRef } from "../core/provenance.js";

function derivePrices(state: WorldState, region: Region, cfg: SimConfig, stockCauses: Record<string, string>): void {
  for (const res of RESOURCES) {
    const stock = region.stocks[res.id] ?? 0;
    const raw = (cfg.targetStock / Math.max(stock, 1e-9)) ** cfg.priceExponent;
    const mult = Math.max(cfg.priceClampMin, Math.min(cfg.priceClampMax, raw));
    const shock = region.priceShock[res.id] ?? 1;
    const next = res.basePrice * mult * shock;
    const prev = region.prices[res.id] ?? res.basePrice;
    region.prices[res.id] = next;

    // Price is DERIVED. Its parents are whatever explains its inputs: the stock level and
    // any active price shock. This is why "why did price rise?" resolves to real causes
    // instead of a single authored edge.
    if (Math.abs(next - prev) > 1e-9) {
      const parents = refsOf(
        state,
        key.stock(region.id, res.id),
        key.priceShock(region.id, res.id),
      );
      const stockCause = stockCauses[`${region.id}:${res.id}`];
      if (stockCause && !parents.includes(stockCause)) parents.push(stockCause);
      if (parents.length > 0) {
        const node = record(state, {
          tick: state.tick,
          kind: "derived",
          label: `${res.id}_price`,
          regionId: region.id,
          value: next,
          detail: { resource: res.id, stock, shock },
          parents,
        });
        setRef(state, key.price(region.id, res.id), node);
      }
    }

    // relax shock toward 1.0 (NOT toward 0)
    const s = region.priceShock[res.id];
    if (s !== undefined) {
      const relaxed = 1 + (s - 1) * cfg.priceShockRelax;
      if (Math.abs(relaxed - 1) < 0.0001) {
        delete region.priceShock[res.id];
      } else {
        region.priceShock[res.id] = relaxed;
      }
    }
  }
}

/**
 * Heartbeat (phase 1): production -> consumption -> warehouse release -> trade -> prices.
 * Pure, no RNG, fixed iteration order (regions sorted by id; each route processed once,
 * at its exporter endpoint).
 */
export function heartbeatEconomy(state: WorldState): void {
  const cfg = state.config;
  state.tradeVolume = 0;
  /** Per-tick provenance for stock changes, so price derivation can cite the real reason. */
  const stockCauses: Record<string, string> = {};

  for (const regionId of Object.keys(state.regions).sort()) {
    const region = state.regions[regionId];
    if (!region) continue;

    // production (ecology resolution may have set a one-tick grain modifier)
    for (const res of RESOURCES) {
      let prod = PROD_RATES[regionId]?.[res.id] ?? 0;
      if (res.id === "grain") {
        const gpm = region.grainProdMod;
        if (gpm !== undefined) {
          prod *= gpm;
          region.grainProdMod = undefined;
          const node = record(state, {
            tick: state.tick,
            kind: "derived",
            label: "grain_production_reduced",
            regionId,
            value: prod,
            detail: { modifier: gpm },
            parents: refsOf(state, key.prodMod(regionId)),
          });
          stockCauses[`${regionId}:grain`] = node;
        }
      }
      region.stocks[res.id] = Math.min(cfg.storageCap, (region.stocks[res.id] ?? 0) + prod);
    }

    // consumption (clamped by available stock — stocks never negative)
    for (const res of RESOURCES) {
      const rate = CONS_RATES[regionId]?.[res.id] ?? 0;
      const cur = region.stocks[res.id] ?? 0;
      region.stocks[res.id] = Math.max(0, cur - Math.min(rate, cur));
    }

    // Warehouse release: a healthy storage structure feeds its town while stock is low.
    // This is the mechanism that makes bridge+warehouse COMPOSE: with the route intact the
    // warehouse never triggers (stock stays at target), so destroying it alone is nearly
    // inert; once the route is gone the warehouse becomes the only buffer, and destroying
    // both removes a cushion that only mattered because of the first action.
    const warehouse = region.infrastructure[WAREHOUSE_ID];
    if (warehouse && warehouse.health > 0 && (warehouse.reserve ?? 0) > 0) {
      const resource = warehouse.resource ?? "grain";
      const stock = region.stocks[resource] ?? 0;
      if (stock < cfg.targetStock * cfg.warehouseLowStockFraction) {
        const released = Math.min(cfg.warehouseReleaseRate, warehouse.reserve ?? 0, cfg.storageCap - stock);
        if (released > 0) {
          warehouse.reserve = (warehouse.reserve ?? 0) - released;
          region.stocks[resource] = stock + released;
          const node = record(state, {
            tick: state.tick,
            kind: "effect",
            label: "warehouse_released_grain",
            regionId,
            value: released,
            detail: { resource, remainingReserve: warehouse.reserve },
            parents: refsOf(state, key.infra(regionId, WAREHOUSE_ID)),
          });
          stockCauses[`${regionId}:${resource}`] = node;
          setRef(state, key.stock(regionId, resource), node);
        }
      }
    }

    // trade: process each route once, at its exporter endpoint (endpoints[1])
    for (const infraId of Object.keys(region.infrastructure).sort()) {
      const infra = region.infrastructure[infraId];
      if (!infra || infra.type !== "trade_route") continue;
      const [importerId, exporterId] = infra.endpoints;
      if (importerId === undefined || exporterId === undefined) continue;
      if (regionId !== exporterId) continue;

      if (infra.health <= 0) {
        // Blocked route: record WHY trade is zero, so price provenance can reach the bridge.
        const cause = refsOf(state, key.tradeBlocked(regionId), key.infra(regionId, infraId));
        if (cause.length > 0) {
          const node = record(state, {
            tick: state.tick,
            kind: "derived",
            label: "trade_capacity_zero",
            regionId,
            value: 0,
            detail: { routeId: infraId },
            parents: cause,
          });
          const importer = state.regions[importerId];
          if (importer) {
            stockCauses[`${importerId}:grain`] = node;
            setRef(state, key.stock(importerId, "grain"), node);
          }
        }
        continue;
      }

      const exporter = region;
      const importer = state.regions[importerId];
      if (!importer) continue;
      // Effective capacity is scaled by merchant trade investment. This is the LAST link of
      // the feedback loop: investment (set from profitability, which depends on price, which
      // depends on stock) determines how much grain actually moves, which sets next tick's
      // stock. Nothing here knows it is part of a loop.
      const capacityFactor = Math.max(0, Math.min(1, exporter.tradeCapacityFactor));
      const effectiveRate = cfg.tradeRate * capacityFactor;
      const flow = Math.min(
        effectiveRate,
        exporter.stocks["grain"] ?? 0,
        cfg.storageCap - (importer.stocks["grain"] ?? 0),
      );
      exporter.stocks["grain"] = (exporter.stocks["grain"] ?? 0) - flow;
      importer.stocks["grain"] = (importer.stocks["grain"] ?? 0) + flow;
      state.tradeVolume = flow;
    }
  }

  // prices derived after all stock movement for the tick has settled
  for (const regionId of Object.keys(state.regions).sort()) {
    const region = state.regions[regionId];
    if (region) derivePrices(state, region, cfg, stockCauses);
  }
}

/**
 * Economy resolution pass (quota): a one-time price shock + hostility increase,
 * driven by accumulated causal pressure p. No RNG.
 */
export function resolveEconomy(
  state: WorldState,
  regionId: RegionId,
  p: number,
  bus: EventBus,
  causes: string[],
): void {
  const region = state.regions[regionId];
  if (!region) return;
  const cfg = state.config;

  const resolution = record(state, {
    tick: state.tick,
    kind: "resolution",
    label: "economy_resolution",
    regionId,
    domain: "economy",
    value: p,
    parents: causes,
  });

  emit(state, bus, "economy.trade_disruption", "economy", regionId, { routeId: ROUTE_ID, pressure: p });

  const factor = 1 + cfg.economyPressureToPriceShock * p;
  region.priceShock["grain"] = (region.priceShock["grain"] ?? 1) * factor;
  const shockNode = record(state, {
    tick: state.tick,
    kind: "effect",
    label: "price_shock_applied",
    regionId,
    value: factor,
    detail: { resource: "grain" },
    parents: [resolution],
  });
  setRef(state, key.priceShock(regionId, "grain"), shockNode);

  const delta = cfg.economyPressureToHostility * p;
  state.relations["MG>player"] = (state.relations["MG>player"] ?? cfg.hostilityFloor) + delta;
  const hostilityParents = refsOf(state, key.hostility("MG"));
  const hostilityNode = record(state, {
    tick: state.tick,
    kind: "effect",
    label: "faction_hostility",
    regionId,
    value: state.relations["MG>player"],
    detail: { factionId: "MG", delta, via: "economy" },
    parents: [resolution, ...hostilityParents],
  });
  setRef(state, key.hostility("MG"), hostilityNode);

  emit(state, bus, "economy.price_shock", "economy", regionId, { regionId, factor });
  emit(state, bus, "faction.hostility_increase", "economy", regionId, { factionId: "MG", amount: delta });
}
