import { factStream, isConsumerFact } from "./events.js";
import { stateHash } from "./hash.js";
import { classifyCursor, describeGap, factsAfter, type RetentionGap, type StreamStatus } from "./retention.js";
import type { WorldEvent, WorldState } from "./types.js";

/**
 * Delivery bookkeeping (docs/RECONNAISSANCE.md §19.4–19.9, §20).
 *
 * THE LOAD-BEARING SEPARATION. `DeliveryState` lives OUTSIDE `WorldState` and is never hashed
 * into `stateHash`. A consumer that is slow, disconnected, duplicated or restarted must not
 * change the simulated world — otherwise two servers running the same seed would diverge
 * because one had a laggy renderer.
 *
 * CURSORS REFERENCE `streamSeq`, NOT ARRAY POSITIONS. Positions into the derived stream shift
 * when the bounded record evicts, which silently repositioned consumers onto different facts.
 * See self-harness/failures/2026-08-31-architecture-cursor-positions-shift-on-eviction.json
 */

/** Where a consumer has read up to, in stable stream coordinates. */
export interface Cursor {
  /** Last `streamSeq` acknowledged; 0 means nothing consumed (seqs start at 1). */
  afterSeq: number;
  /** Highest tick fully delivered, for diagnostics. */
  throughTick: number;
}

export const CURSOR_START: Cursor = { afterSeq: 0, throughTick: -1 };

export interface DeliveryAttempt {
  eventId: string;
  /** 1 on first delivery, 2+ on redelivery. Lets a consumer tell redelivery from a new fact. */
  attempt: number;
  /** Stable stream coordinate. Survives eviction, restart and checkpoint/restore. */
  streamSeq: number;
  event: WorldEvent;
}

/** Per-consumer delivery bookkeeping. Deliberately NOT part of the world. */
export interface ConsumerChannel {
  consumerId: string;
  acked: Cursor;
  inFlight: DeliveryAttempt[];
  attempts: Record<string, number>;
  connected: boolean;
  /** Timeline this cursor belongs to. A cursor is meaningless against another timeline. */
  timelineId: string | null;
}

export interface DeliveryState {
  channels: Record<string, ConsumerChannel>;
}

export function createDeliveryState(): DeliveryState {
  return { channels: {} };
}

export function registerConsumer(delivery: DeliveryState, consumerId: string): ConsumerChannel {
  const existing = delivery.channels[consumerId];
  if (existing) return existing;
  const channel: ConsumerChannel = {
    consumerId,
    acked: { ...CURSOR_START },
    inFlight: [],
    attempts: {},
    connected: true,
    timelineId: null,
  };
  delivery.channels[consumerId] = channel;
  return channel;
}

// ---------------------------------------------------------------------------
// Delivery semantics
// ---------------------------------------------------------------------------

/**
 * DECISION (§19.4): **at-least-once delivery of retained facts, in canonical order, with
 * deterministic identity**. Consumers must be idempotent.
 *
 * Exactly-once is NOT claimed. CE hands over an event, the consumer applies it, the
 * acknowledgement is lost — CE cannot distinguish "applied but unacknowledged" from "never
 * applied", so it must redeliver. Exactly-once *effects* are achievable jointly: CE supplies
 * stable ids, the consumer deduplicates. That is a shared property, not a CE guarantee.
 */
export type DeliveryGuarantee = "at-least-once";
export const DELIVERY_GUARANTEE: DeliveryGuarantee = "at-least-once";

/** Facts available to consumers, in canonical order. Derived, never stored. */
export function streamOf(state: WorldState): WorldEvent[] {
  return factStream(state);
}

/**
 * The result of a poll. Three outcomes, exhaustive and mutually exclusive — an empty batch can
 * never be confused with a gap, which was the defect this pass opened by finding.
 */
export type PollResult =
  | { status: "caught_up"; attempts: [] }
  | { status: "deliverable"; attempts: DeliveryAttempt[] }
  | { status: "gap"; attempts: []; gap: RetentionGap }
  | { status: "disconnected"; attempts: [] }
  | { status: "wrong_timeline"; attempts: []; expected: string; actual: string };

/**
 * Poll for facts after the consumer's acknowledged cursor.
 *
 * Retention is consulted FIRST: a cursor below the eviction boundary yields a gap, and no
 * facts, rather than quietly resuming from whatever is left.
 */
export function poll(state: WorldState, delivery: DeliveryState, consumerId: string): PollResult {
  const channel = registerConsumer(delivery, consumerId);
  if (!channel.connected) return { status: "disconnected", attempts: [] };

  // A cursor is only meaningful against the timeline that issued it (§20.11).
  if (channel.timelineId !== null && channel.timelineId !== state.lineage.timelineId) {
    return {
      status: "wrong_timeline",
      attempts: [],
      expected: channel.timelineId,
      actual: state.lineage.timelineId,
    };
  }
  channel.timelineId = state.lineage.timelineId;

  const status: StreamStatus = classifyCursor(state, channel.acked.afterSeq);
  if (status === "gap") {
    const gap = describeGap(state, channel.acked.afterSeq)!;
    return { status: "gap", attempts: [], gap };
  }
  if (status === "caught_up") return { status: "caught_up", attempts: [] };

  const due = factsAfter(streamOf(state), channel.acked.afterSeq);
  const attempts: DeliveryAttempt[] = due.map((event) => {
    const attempt = (channel.attempts[event.id] ?? 0) + 1;
    channel.attempts[event.id] = attempt;
    return { eventId: event.id, attempt, streamSeq: event.streamSeq, event };
  });

  channel.inFlight = attempts;
  if (attempts.length === 0) return { status: "caught_up", attempts: [] };
  return { status: "deliverable", attempts };
}

/**
 * Acknowledge up to and including a `streamSeq`.
 * Cursors never move backwards, so a duplicated or out-of-order ack cannot resurrect
 * already-consumed facts.
 */
export function ack(
  state: WorldState,
  delivery: DeliveryState,
  consumerId: string,
  streamSeq: number,
): { ok: boolean; cursor: Cursor; reason?: string } {
  const channel = registerConsumer(delivery, consumerId);

  if (!Number.isInteger(streamSeq) || streamSeq < 0) {
    return { ok: false, cursor: channel.acked, reason: "streamSeq must be a non-negative integer" };
  }
  if (streamSeq > state.highestEmittedSeq) {
    return { ok: false, cursor: channel.acked, reason: "cannot acknowledge beyond the highest emitted sequence" };
  }
  if (streamSeq <= channel.acked.afterSeq) {
    return { ok: true, cursor: channel.acked, reason: "cursor never moves backwards; ignored" };
  }

  const event = state.events.find((e) => e.streamSeq === streamSeq);
  channel.acked = { afterSeq: streamSeq, throughTick: event?.tick ?? channel.acked.throughTick };
  channel.inFlight = channel.inFlight.filter((a) => a.streamSeq > streamSeq);
  return { ok: true, cursor: channel.acked };
}

export function disconnect(delivery: DeliveryState, consumerId: string): void {
  registerConsumer(delivery, consumerId).connected = false;
}

export function reconnect(delivery: DeliveryState, consumerId: string): void {
  registerConsumer(delivery, consumerId).connected = true;
}

/** Serialize delivery state, so an adapter can persist cursors across a process boundary. */
export function serializeDelivery(delivery: DeliveryState): string {
  return JSON.stringify(delivery);
}

export function deserializeDelivery(text: string): DeliveryState {
  const parsed = JSON.parse(text) as DeliveryState;
  return { channels: parsed.channels ?? {} };
}

// ---------------------------------------------------------------------------
// State synchronisation (the alternative to replay)
// ---------------------------------------------------------------------------

/**
 * A LEVEL snapshot: current truth, not transitions (§19.10, §20.5).
 *
 * WHAT IT GUARANTEES, precisely: "you now know the current world." It does NOT mean "you have
 * reconstructed every event that happened." Those are different claims, and conflating them
 * would let a consumer believe it had a complete history when it has a correct present.
 * `historyComplete` states which it is.
 */
export interface StateSync {
  kind: "state_sync";
  timelineId: string;
  tick: number;
  stateHash: string;
  /** Cursor position this sync is consistent with: resume the stream after this seq. */
  streamSeq: number;
  /**
   * False whenever the world's record has ever evicted. A consumer adopting this sync knows the
   * present exactly and does NOT possess the intervening history.
   */
  historyComplete: boolean;
  regions: Record<
    string,
    { grainPrice: number; grainStock: number; patrolDemand: number; unrest: number; tradeInvestment: number }
  >;
  relations: Record<string, number>;
}

export function stateSync(state: WorldState): StateSync {
  const regions: StateSync["regions"] = {};
  for (const id of Object.keys(state.regions).sort()) {
    const r = state.regions[id]!;
    regions[id] = {
      grainPrice: r.prices["grain"] ?? 0,
      grainStock: r.stocks["grain"] ?? 0,
      patrolDemand: r.patrolDemand,
      unrest: r.unrest,
      tradeInvestment: r.tradeInvestment,
    };
  }
  return {
    kind: "state_sync",
    timelineId: state.lineage.timelineId,
    tick: state.tick,
    stateHash: stateHash(state),
    streamSeq: state.highestEmittedSeq,
    historyComplete: state.evictedCount === 0,
    regions,
    relations: { ...state.relations },
  };
}

/**
 * Adopt a state sync and reposition the cursor past the unreachable backlog.
 * Refuses a sync from a different timeline — adopting one would silently graft another world's
 * present onto this consumer's history.
 */
export function resync(
  delivery: DeliveryState,
  consumerId: string,
  sync: StateSync,
): { ok: boolean; cursor: Cursor; reason?: string } {
  const channel = registerConsumer(delivery, consumerId);
  if (channel.timelineId !== null && channel.timelineId !== sync.timelineId) {
    return { ok: false, cursor: channel.acked, reason: "state sync belongs to a different timeline" };
  }
  channel.timelineId = sync.timelineId;
  channel.acked = { afterSeq: sync.streamSeq, throughTick: sync.tick };
  channel.inFlight = [];
  return { ok: true, cursor: channel.acked };
}

// ---------------------------------------------------------------------------
// A minimal deterministic consumer, for proving the semantics only
// ---------------------------------------------------------------------------

/**
 * Test-harness consumer. Deliberately NOT a transport: no sockets, no brokers, no timers.
 * The semantics under test are ordering, identity, acknowledgement and eviction — none of
 * which need a network.
 */
export interface HarnessConsumer {
  id: string;
  applied: string[];
  duplicatesSeen: string[];
  gapsSeen: RetentionGap[];
  view: Record<string, number>;
  apply(attempt: DeliveryAttempt): "applied" | "duplicate";
}

export function createConsumer(id: string): HarnessConsumer {
  const seen = new Set<string>();
  const consumer: HarnessConsumer = {
    id,
    applied: [],
    duplicatesSeen: [],
    gapsSeen: [],
    view: {},
    apply(attempt: DeliveryAttempt): "applied" | "duplicate" {
      if (seen.has(attempt.eventId)) {
        consumer.duplicatesSeen.push(attempt.eventId);
        return "duplicate";
      }
      seen.add(attempt.eventId);
      consumer.applied.push(attempt.eventId);
      const key = `${attempt.event.regionId ?? "-"}:${attempt.event.type}`;
      consumer.view[key] = (consumer.view[key] ?? 0) + 1;
      return "applied";
    },
  };
  return consumer;
}

/** Drive one poll cycle: apply everything, record gaps, acknowledge. Diagnostics helper. */
export function pump(
  state: WorldState,
  delivery: DeliveryState,
  consumer: HarnessConsumer,
): PollResult {
  const result = poll(state, delivery, consumer.id);
  if (result.status === "gap") {
    consumer.gapsSeen.push(result.gap);
    return result;
  }
  if (result.status === "deliverable") {
    for (const a of result.attempts) consumer.apply(a);
    const last = result.attempts[result.attempts.length - 1]!;
    ack(state, delivery, consumer.id, last.streamSeq);
  }
  return result;
}

/** Everything a consumer would see for a tick, canonically ordered. Diagnostics helper. */
export function factsForTick(state: WorldState, tick: number): WorldEvent[] {
  return streamOf(state).filter((e) => e.tick === tick && isConsumerFact(e));
}
