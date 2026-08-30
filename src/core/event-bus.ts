import { deriveEventId } from "./events.js";
import type { RegionId, WorldEvent, WorldState } from "./types.js";

/** Minimal phased event bus: publish queues; collect drains once at the delivery phase. */
export interface EventBus {
  publish(ev: WorldEvent): void;
  collect(): WorldEvent[];
}

export function createEventBus(): EventBus {
  const queue: WorldEvent[] = [];
  return {
    publish(ev: WorldEvent): void {
      queue.push(ev);
    },
    collect(): WorldEvent[] {
      const out = queue.splice(0, queue.length);
      return out;
    },
  };
}

/**
 * Emit a world fact with a DETERMINISTIC, TIMELINE-SCOPED identity.
 *
 * `eventSeq` is still a per-tick ordinal (it is reset each tick by the engine), used only as
 * the within-tick position so that two otherwise-identical facts stay distinguishable.
 *
 * The previous scheme used a bare global counter as the id itself, which collided across
 * unrelated branches: two timelines forked from one checkpoint both minted `ev-22` for
 * different facts. See
 * self-harness/failures/2026-08-31-architecture-event-id-collision-across-timelines.json
 */
export function emit(
  state: WorldState,
  bus: EventBus,
  type: string,
  source: string,
  regionId: RegionId | undefined,
  data: Record<string, unknown>,
): void {
  const ordinal = state.eventSeq++;
  const streamSeq = ++state.highestEmittedSeq;
  const id = deriveEventId(state.lineage.timelineId, state.tick, ordinal, type, regionId, data);
  bus.publish({ id, type, source, regionId, data, tick: state.tick, ordinal, streamSeq });
}
