import type { WorldEvent, WorldState } from "./types.js";

/**
 * Event retention and eviction (docs/RECONNAISSANCE.md §20).
 *
 * OWNERSHIP DECISION: **HYBRID (Model C), with CE owning a bounded authoritative window and
 * publishing an explicit eviction boundary; the adapter owns any longer-term retention.**
 *
 * Model A (CE-owned, retain until all consumers ack) was rejected on evidence, not taste. It
 * requires CE to know about consumers, which:
 *   - lets the SLOWEST consumer pin unbounded history — a disconnected client would grow the
 *     record without limit, and a crashed client that never returns would grow it forever;
 *   - makes the world's memory footprint a function of consumer liveness, which is the same
 *     class of coupling that would let a renderer stall the simulation;
 *   - breaks under branching: a fork inherits the record, so "all consumers" is ambiguous
 *     across timelines that no consumer has subscribed to;
 *   - breaks under rewind: the abandoned future's events have consumers whose cursors point
 *     into a timeline that is no longer live.
 *
 * Model B (purely adapter-owned) was rejected because it leaves CE unable to answer "have I
 * lost anything?". Without a boundary in CE, a stale cursor is indistinguishable from a
 * caught-up one — which is exactly the silent-skip defect this pass opened by finding.
 *
 * Model C keeps both properties: CE's window is bounded and independent of consumers (so no
 * consumer can pin memory or stall the world), and CE publishes `oldestRetainedSeq` /
 * `highestEmittedSeq` so a gap is always detectable and always attributable to a range. An
 * adapter that needs longer history copies facts out as they arrive — CE never becomes an
 * archive, and never pretends to be one.
 */

/** The window CE currently guarantees. */
export interface RetentionWindow {
  timelineId: string;
  /** Lowest `streamSeq` still retained. */
  oldestRetainedSeq: number;
  /** Highest `streamSeq` ever emitted in this timeline. */
  highestEmittedSeq: number;
  /** Facts currently in the record. */
  retainedCount: number;
  /** Facts evicted over this timeline's life. */
  evictedCount: number;
  /** Configured bound. */
  limit: number;
}

export function retentionWindow(state: WorldState, limit: number): RetentionWindow {
  return {
    timelineId: state.lineage.timelineId,
    oldestRetainedSeq: state.oldestRetainedSeq,
    highestEmittedSeq: state.highestEmittedSeq,
    retainedCount: state.events.length,
    evictedCount: state.evictedCount,
    limit,
  };
}

/**
 * THE RETENTION GUARANTEE, operationally (§20.2). Replaces the vague "at-least-once while
 * retained" with three exhaustive, decidable cases for a cursor at `afterSeq`:
 *
 *   CAUGHT_UP    afterSeq >= highestEmittedSeq
 *                -> nothing to deliver. An EMPTY result here means "you are current".
 *
 *   DELIVERABLE  afterSeq >= oldestRetainedSeq - 1
 *                -> every fact with streamSeq > afterSeq is present and WILL be delivered,
 *                   in canonical order, at least once, repeatedly until acknowledged.
 *
 *   GAP          afterSeq < oldestRetainedSeq - 1
 *                -> at least one fact the consumer has not seen has been evicted. CE reports
 *                   the missing range and the remedy. An empty result NEVER means this: the two
 *                   are separate outcomes, which is the whole point.
 *
 * The distinction between CAUGHT_UP and GAP is the contract's load-bearing property. Both
 * previously produced "no events", so a consumer could not tell "nothing happened" from
 * "you lost data".
 */
export type StreamStatus = "caught_up" | "deliverable" | "gap";

export function classifyCursor(state: WorldState, afterSeq: number): StreamStatus {
  if (afterSeq >= state.highestEmittedSeq) return "caught_up";
  if (afterSeq >= state.oldestRetainedSeq - 1) return "deliverable";
  return "gap";
}

/**
 * An explicit, deterministic gap. Transport-neutral: no HTTP codes, no socket errors, no
 * exception types — just the facts a consumer needs to decide what to do.
 */
export interface RetentionGap {
  kind: "gap";
  /** Timeline the gap belongs to. A consumer must never apply one timeline's gap to another. */
  timelineId: string;
  /** Cursor the consumer held. */
  cursorAfterSeq: number;
  /** First streamSeq the consumer never received. */
  missingFromSeq: number;
  /** Last streamSeq the consumer never received. */
  missingToSeq: number;
  /** How many facts are unrecoverable from CE. */
  missingCount: number;
  /** Lowest seq CE can still serve. */
  oldestRetainedSeq: number;
  /** Why the facts are gone. */
  reason: "evicted_by_retention_bound";
  /** Can CE replay them? No — the record is bounded, not an archive. */
  replayable: false;
  /**
   * Can they be RECONSTRUCTED? Also no, and this is deliberate: reconstructing facts from
   * current state would fabricate history that was never recorded. §18.4 refused to write
   * derived summaries into provenance for the same reason.
   */
  reconstructable: false;
  /** Whether an adapter might hold them (CE cannot know; it only reports its own window). */
  permanentlyUnavailableFromCE: true;
  /** The one recovery operation CE offers. */
  remedy: "resync_from_state";
}

export function describeGap(state: WorldState, afterSeq: number): RetentionGap | null {
  if (classifyCursor(state, afterSeq) !== "gap") return null;
  const missingFrom = afterSeq + 1;
  const missingTo = state.oldestRetainedSeq - 1;
  return {
    kind: "gap",
    timelineId: state.lineage.timelineId,
    cursorAfterSeq: afterSeq,
    missingFromSeq: missingFrom,
    missingToSeq: missingTo,
    missingCount: Math.max(0, missingTo - missingFrom + 1),
    oldestRetainedSeq: state.oldestRetainedSeq,
    reason: "evicted_by_retention_bound",
    replayable: false,
    reconstructable: false,
    permanentlyUnavailableFromCE: true,
    remedy: "resync_from_state",
  };
}

/**
 * Enforce the retention bound, in place.
 *
 * RETENTION IS UNIFORM (§20.9). Retention classes (`ephemeral` / `standard` / `persistent`)
 * were considered and REJECTED: they would tie an event's DELIVERY lifetime to its CAUSAL
 * significance, and those are different things. A `faction.hostility_increase` is causally
 * momentous and a renderer may not care; a price tick is causally trivial and a price board
 * needs every one. Encoding importance in CE would mean guessing which consumer matters, and a
 * wrong guess is unfixable from outside. Uniform retention plus an explicit boundary lets each
 * adapter make that judgement for itself, which is where the knowledge actually lives.
 *
 * Retention is also INDEPENDENT OF CONSUMERS by construction — this function does not take a
 * `DeliveryState` and could not consult one. That is what makes "a slow consumer cannot stall
 * or bloat the simulation" structural rather than a promise.
 */
export function enforceRetention(state: WorldState, limit: number): number {
  if (state.events.length <= limit) {
    syncBoundary(state);
    return 0;
  }
  const excess = state.events.length - limit;
  state.events.splice(0, excess);
  state.evictedCount += excess;
  state.historyTruncated = true;
  syncBoundary(state);
  return excess;
}

/**
 * Recompute the eviction boundary from the retained record.
 *
 * When the record is empty the boundary is `highestEmittedSeq + 1`, meaning "nothing retained,
 * everything up to here is gone" — which keeps `classifyCursor` correct rather than accidentally
 * reporting `deliverable` for a stream that can serve nothing.
 */
export function syncBoundary(state: WorldState): void {
  if (state.events.length === 0) {
    state.oldestRetainedSeq = state.highestEmittedSeq + 1;
    return;
  }
  let min = Number.POSITIVE_INFINITY;
  for (const e of state.events) if (e.streamSeq < min) min = e.streamSeq;
  state.oldestRetainedSeq = min;
}

/** Facts strictly after a cursor, in stream order. Empty means CAUGHT_UP, never a gap. */
export function factsAfter(events: WorldEvent[], afterSeq: number): WorldEvent[] {
  return events.filter((e) => e.streamSeq > afterSeq).sort((a, b) => a.streamSeq - b.streamSeq);
}

/**
 * CE's bounded authoritative window, in facts.
 *
 * A single number rather than a policy object, deliberately: CE's job is to be bounded and to
 * publish where the boundary is, not to implement a retention strategy. Strategy belongs to the
 * adapter, which knows its consumers.
 */
export const EVENT_RETENTION_LIMIT = 500;
