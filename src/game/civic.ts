import type { RegionId, WorldState } from "../core/types.js";
import type { EventBus } from "../core/event-bus.js";
import { emit } from "../core/event-bus.js";
import { key, record, setRef } from "../core/provenance.js";

/**
 * Civic resolution pass (quota) — deliberately NON-economic.
 *
 * Civic pressure raises local unrest, which raises patrol demand. It has NO pathway to
 * stocks, prices, trade, or faction income. This is the control arm for Experiment F:
 * it proves CE does not become a system where every state change eventually influences
 * everything. If a civic->economy relationship is ever wanted, it must be modelled
 * explicitly here — not inherited by accident.
 */
export function resolveCivic(
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
    label: "civic_resolution",
    regionId,
    domain: "civic",
    value: p,
    parents: causes,
  });

  const delta = state.config.civicPressureToUnrest * p;
  region.unrest = Math.max(0, Math.min(1, region.unrest + delta));
  const node = record(state, {
    tick: state.tick,
    kind: "effect",
    label: "civic_unrest",
    regionId,
    value: region.unrest,
    detail: { delta },
    parents: [resolution],
  });
  setRef(state, key.unrest(regionId), node);

  emit(state, bus, "civic.unrest_increase", "civic", regionId, { regionId, amount: delta });
}
