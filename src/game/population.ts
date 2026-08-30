import type { RNG } from "../core/rng.js";
import type { WorldState } from "../core/types.js";

/**
 * Heartbeat (phase 3): NPC behavior.
 * THE ONLY RNG CONSUMER in the engine. Agents iterate in sorted id order; exactly one
 * draw each — any ordering bug breaks deterministic replay, which the test suite guards.
 */
export function heartbeatPopulation(state: WorldState, rng: RNG): void {
  const threshold = state.config.patrolActiveThreshold;
  for (const id of Object.keys(state.entities).sort()) {
    const e = state.entities[id];
    if (!e || e.type === "faction") continue;
    e.attrs.workJitter = 0.5 + rng.next() * 0.5;
    if (e.role === "guard") {
      const region = state.regions[e.location];
      e.attrs.patrolling = region ? region.patrolDemand > threshold : false;
    }
  }
}
