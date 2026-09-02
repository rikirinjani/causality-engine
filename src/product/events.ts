/**
 * CE v1.0 — Event consumption (product boundary).
 *
 * Wraps poll/ack WITHOUT weakening the delivery contract. Every guarantee the
 * engine makes is preserved and remains visible to the developer:
 *
 *   - canonical ordering      — events arrive in the order `poll()` returned them
 *   - at-least-once           — `attempt` counts are surfaced, not hidden
 *   - streamSeq               — the stable stream coordinate, never an array index
 *   - explicit acknowledgement — nothing is acked implicitly by reading
 *   - gap detection           — a gap is reported as a gap, never as "no events"
 *   - DeliveryState separation — cursors live outside WorldState
 *
 * A simpler-looking API that silently auto-acked, swallowed gaps, or reordered
 * events would be a lie about the semantics. This module refuses to tell it.
 */
import { ack, poll, resync, stateSync, type Cursor, type PollResult } from "../core/delivery.js";
import type { RetentionGap } from "../core/retention.js";
import type { WorldEvent } from "../core/types.js";
import type { CausalRuntime } from "./runtime.js";

export interface DeliveredEvent {
  event: WorldEvent;
  /** Stable stream coordinate. Ack references this, never a position. */
  streamSeq: number;
  /** Delivery attempt number. >1 means this fact was redelivered (at-least-once). */
  attempt: number;
}

export type BatchStatus = "events" | "caught_up" | "gap" | "disconnected" | "wrong_timeline";

export interface EventBatch {
  status: BatchStatus;
  events: DeliveredEvent[];
  /** Highest streamSeq in this batch, or -1 when the batch is empty. */
  highestSeq: number;
  /** Present when `status === "gap"`. Describes exactly what was lost. */
  gap?: RetentionGap;
  /** Present when `status === "wrong_timeline"`. */
  expectedTimeline?: string;
  actualTimeline?: string;
}

export interface DrainReport {
  status: BatchStatus;
  delivered: number;
  /** False when the batch was not acked (gap, disconnect, wrong timeline, or empty). */
  acked: boolean;
  highestSeq: number;
  gap?: RetentionGap;
}

export interface EventStream {
  /**
   * Poll once. Never acks — reading is not consuming.
   * Preserves canonical order and at-least-once attempt counts.
   */
  next(): EventBatch;
  /** Acknowledge through an explicit streamSeq. Thin pass-through of the engine's `ack`. */
  ack(throughSeq: number): { ok: boolean; reason?: string };
  /** Acknowledge a batch through its highestSeq. No-op success for empty batches. */
  ackBatch(batch: EventBatch): { ok: boolean; reason?: string };
  /** poll -> handle in canonical order -> ack. The common game-loop shape. */
  drain(handler: (event: WorldEvent, meta: { streamSeq: number; attempt: number }) => void): DrainReport;
  /**
   * Recover from a gap by adopting the world's present via stateSync/resync.
   * This does NOT pretend the gap did not happen — the caller already saw it.
   */
  recover(): { ok: boolean; reason?: string };
  /** Current acknowledged cursor position. */
  cursor(): Cursor;
}

function toBatch(result: PollResult): EventBatch {
  switch (result.status) {
    case "deliverable": {
      const events: DeliveredEvent[] = result.attempts.map((a) => ({
        event: a.event,
        streamSeq: a.streamSeq,
        attempt: a.attempt,
      }));
      const highestSeq = events.reduce((max, e) => (e.streamSeq > max ? e.streamSeq : max), -1);
      return { status: "events", events, highestSeq };
    }
    case "gap":
      return { status: "gap", events: [], highestSeq: -1, gap: result.gap };
    case "disconnected":
      return { status: "disconnected", events: [], highestSeq: -1 };
    case "wrong_timeline":
      return {
        status: "wrong_timeline",
        events: [],
        highestSeq: -1,
        expectedTimeline: result.expected,
        actualTimeline: result.actual,
      };
    case "caught_up":
    default:
      return { status: "caught_up", events: [], highestSeq: -1 };
  }
}

/**
 * Open an event stream over a runtime's delivery channel.
 *
 * The stream is a view, not a copy: it reads the runtime's live delivery state, so
 * cursor position survives across calls and across reconnects.
 */
export function openEventStream(rt: CausalRuntime): EventStream {
  return {
    next(): EventBatch {
      return toBatch(poll(rt.world, rt.delivery, rt.consumerId));
    },

    ack(throughSeq: number): { ok: boolean; reason?: string } {
      const result = ack(rt.world, rt.delivery, rt.consumerId, throughSeq);
      return result.reason === undefined
        ? { ok: result.ok }
        : { ok: result.ok, reason: result.reason };
    },

    ackBatch(batch: EventBatch): { ok: boolean; reason?: string } {
      if (batch.events.length === 0) return { ok: true };
      return this.ack(batch.highestSeq);
    },

    drain(handler): DrainReport {
      const batch = this.next();

      // Deliver in exactly the order poll returned. Canonical order is a guarantee.
      for (const delivered of batch.events) {
        handler(delivered.event, { streamSeq: delivered.streamSeq, attempt: delivered.attempt });
      }

      // Only an "events" batch may advance the cursor. A gap, disconnect, or
      // timeline mismatch must NOT be acked — doing so would skip facts silently.
      let acked = false;
      if (batch.status === "events" && batch.events.length > 0) {
        acked = this.ack(batch.highestSeq).ok;
      }

      const report: DrainReport = {
        status: batch.status,
        delivered: batch.events.length,
        acked,
        highestSeq: batch.highestSeq,
      };
      if (batch.gap !== undefined) report.gap = batch.gap;
      return report;
    },

    recover(): { ok: boolean; reason?: string } {
      const sync = stateSync(rt.world);
      const result = resync(rt.delivery, rt.consumerId, sync);
      return result.reason === undefined
        ? { ok: result.ok }
        : { ok: result.ok, reason: result.reason };
    },

    cursor(): Cursor {
      const channel = rt.delivery.channels[rt.consumerId];
      return channel?.acked ?? { afterSeq: -1, throughTick: -1 };
    },
  };
}

export type { Cursor, RetentionGap };
