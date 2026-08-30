import type { RegionId, WorldState } from "../core/types.js";
import type { EventBus } from "../core/event-bus.js";
import { emit } from "../core/event-bus.js";
import { key, record, setRef } from "../core/provenance.js";

/**
 * Ecology resolution pass (quota): reduced grain production for the next tick
 * + a food-availability signal. No RNG.
 */
export function resolveEcology(
  state: WorldState,
  regionId: RegionId,
  p: number,
  bus: EventBus,
  causes: string[],
): void {
  const region = state.regions[regionId];
  if (!region) return;

  const resolution = record(state, {
    tick: state.tick,
    kind: "resolution",
    label: "ecology_resolution",
    regionId,
    domain: "ecology",
    value: p,
    parents: causes,
  });

  const factor = 1 - state.config.ecologyPressureToProdLoss * p;
  region.grainProdMod = factor;
  const node = record(state, {
    tick: state.tick,
    kind: "effect",
    label: "grain_supply_reduced",
    regionId,
    value: factor,
    parents: [resolution],
  });
  setRef(state, key.prodMod(regionId), node);

  emit(state, bus, "ecology.food_availability", "ecology", regionId, { regionId, factor });
}
