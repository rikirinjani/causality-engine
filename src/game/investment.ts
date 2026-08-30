import { RESOURCES, ROUTE_ID } from "./content.js";
import type { WorldState } from "../core/types.js";
import { generatePressure } from "../core/propagation.js";
import { key, record, refsOf, setRef } from "../core/provenance.js";

/**
 * The feedback loop (docs/RECONNAISSANCE.md §16.1).
 *
 *   destination grain price ↑
 *     → merchant profitability ↓   (working capital tied up in expensive grain)
 *       → trade investment ↓
 *         → effective trade capacity ↓
 *           → destination grain supply ↓
 *             → destination grain price ↑ ...
 *
 * This is deliberately a POSITIVE (self-reinforcing) feedback loop with no restoring term.
 * The brief asks whether CE survives a genuinely cyclic world; a self-correcting loop would
 * not test that. The equilibrium is an exact fixed point (see below), so the baseline world
 * is quiet and any drift is attributable to an intervention.
 *
 * EQUILIBRIUM IS A FIXED POINT BY CONSTRUCTION.
 *   profitability = mgMargin × tradeRate − investmentCarryCost × destinationPrice
 * At rest, destinationPrice == basePrice and stock == targetStock, so profitability equals
 * `investmentProfitReference`, target investment is exactly 1.0, and the clamp at
 * `investmentMax` holds it there. `investmentEquilibriumInvariant` in feedback.test.ts fails
 * loudly if anyone retunes margin/rate/carry and breaks that identity.
 *
 * Revenue uses the POTENTIAL rate (`tradeRate`), not realised `tradeVolume`. Using realised
 * volume made the loop self-throttling: throughput fell, which cut revenue, which cut
 * investment, which cut throughput — a collapse independent of price that ran away even with
 * no intervention at all. That was a real modelling error found while building this, not a
 * tuning problem; recorded in §16.1.
 *
 * Only a route's EXPORTER carries investment dynamics: it is the party that ships, and its
 * capacity gates the flow. Importers keep investment inert at max.
 *
 * Why relaxation rather than an inner fixed-point solve: the loop's gain is the thing under
 * test. Solving to a fixed point inside a tick would hide oscillation and divergence behind
 * a solver, which §3 of the brief forbids. One traversal per tick, trajectory observed,
 * convergence classified from that trajectory (core/dynamics.ts).
 */
export function heartbeatInvestment(state: WorldState): void {
  const cfg = state.config;
  const basePrice = RESOURCES.find((r) => r.id === "grain")?.basePrice ?? 10;

  for (const regionId of Object.keys(state.regions).sort()) {
    const region = state.regions[regionId];
    if (!region) continue;

    const route = region.infrastructure[ROUTE_ID];
    if (!route) continue;
    const [importerId, exporterId] = route.endpoints;
    if (importerId === undefined || exporterId === undefined) continue;
    // Only the shipping party has investment dynamics.
    if (regionId !== exporterId) continue;

    const destination = state.regions[importerId];
    if (!destination) continue;
    const destinationPrice = destination.prices["grain"] ?? basePrice;

    // Revenue from the potential shipment, minus capital tied up in expensive destination
    // grain. Rising destination price erodes profit — the link that closes the cycle.
    const revenue = cfg.mgMargin * cfg.tradeRate;
    const carry = cfg.investmentCarryCost * destinationPrice;
    const profitability = revenue - carry;
    region.merchantProfitability = profitability;

    const target = Math.max(
      cfg.investmentMin,
      Math.min(cfg.investmentMax, profitability / cfg.investmentProfitReference),
    );

    const prev = region.tradeInvestment;
    // Bounded relaxation: move a fraction of the way to target. The rate IS the loop gain.
    const next = prev + cfg.investmentAdjustRate * (target - prev);
    region.tradeInvestment = Math.max(cfg.investmentMin, Math.min(cfg.investmentMax, next));

    region.tradeCapacityFactor = Math.max(
      0,
      Math.min(1, region.tradeInvestment / Math.max(cfg.investmentTradeFloor, 1e-9)),
    );

    const delta = region.tradeInvestment - prev;
    if (Math.abs(delta) > 1e-12) {
      const node = record(state, {
        tick: state.tick,
        kind: "derived",
        label: "trade_investment",
        regionId,
        value: region.tradeInvestment,
        detail: {
          profitability,
          target,
          delta,
          destinationPrice,
          destination: importerId,
        },
        parents: refsOf(
          state,
          key.price(importerId, "grain"),
          key.investment(regionId),
        ),
      });
      setRef(state, key.investment(regionId), node);

      // A MATERIAL collapse in investment is a genuine new state transition, not inherited
      // pressure. It therefore generates NEW causality (origin "generated", generation+1),
      // which is what allows a consequence to become a cause. Bounded by
      // cfg.maxCausalGeneration; refusal emits an explicit diagnostic. See §16.6.
      const materialDrop = -delta / Math.max(cfg.investmentMax, 1e-9);
      if (materialDrop >= cfg.generationMateriality) {
        const parentGen = region.ledgerGeneration.economy ?? 0;
        const accepted = generatePressure(
          state,
          regionId,
          "economy",
          materialDrop,
          +1, // a collapse is DISRUPTIVE
          parentGen,
          [node],
          { transition: "trade_investment_collapse", drop: materialDrop, investment: region.tradeInvestment },
        );
        if (accepted) {
          record(state, {
            tick: state.tick,
            kind: "pressure",
            label: "economy_pressure_generated",
            regionId,
            domain: "economy",
            value: materialDrop,
            detail: {
              origin: "generated",
              generation: parentGen + 1,
              transition: "trade_investment_collapse",
              note: "newly generated causality, NOT inherited boundary pressure",
            },
            parents: [node],
          });
        }
      }
    }
  }
}

/**
 * The equilibrium identity the fixed point depends on.
 * Exported so a regression test can assert it rather than trusting a comment.
 */
export function equilibriumProfitability(state: WorldState): number {
  const cfg = state.config;
  const basePrice = RESOURCES.find((r) => r.id === "grain")?.basePrice ?? 10;
  return cfg.mgMargin * cfg.tradeRate - cfg.investmentCarryCost * basePrice;
}
