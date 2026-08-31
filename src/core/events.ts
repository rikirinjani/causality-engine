import { createHash } from "node:crypto";
import { sortKeys } from "./hash.js";
import type { DomainId, RegionId, WorldEvent, WorldState } from "./types.js";

/**
 * CE event ontology, identity and ordering (docs/RECONNAISSANCE.md §19).
 *
 * THE CENTRAL DECISION. A CE event is a **historical fact about the simulated world**. It is
 * not a delivery obligation, not a command, and not a presentation hint.
 *
 *   - Not a delivery obligation, because delivery is bookkeeping about a CONSUMER, and a
 *     consumer being slow or disconnected must not change the simulated world (§19.11).
 *     Delivery lives in `DeliveryState`, outside `WorldState` entirely.
 *   - Not a command, because CE describes what happened, never what a renderer should do.
 *     "grain price shocked by 1.64" is a fact; "play a price-alarm sound" would be a command,
 *     and encoding one would make CE responsible for presentation decisions it cannot see.
 *   - Not a presentation hint, for the same reason.
 *
 * Facts are ALREADY REFLECTED IN STATE by the time they are emitted. That is what makes the
 * stream optional: a consumer may read facts, or read state, or both, and it never has to
 * reconstruct state by folding events. CE is deliberately NOT event-sourced (§19.10).
 */

/**
 * What a given event type actually is. The audit that produced these classifications is in
 * `EVENT_CATALOG` below; the important discovery was that one type was not a world fact at all.
 */
export type EventKind =
  /** A world fact: something happened in the simulation that a consumer may care about. */
  | "fact"
  /**
   * ENGINE-INTERNAL scheduling detail. Not a world fact. Retained in the record for debugging
   * and determinism auditing, but NOT delivered to consumers by default, because publishing it
   * would leak the quota mechanism into the consumer contract and freeze it into the API.
   */
  | "internal";

export interface EventTypeSpec {
  type: string;
  kind: EventKind;
  /** Domain the fact belongs to, where meaningful. */
  domain?: DomainId | "world";
  /** One-line semantics, phrased as a fact rather than an instruction. */
  meaning: string;
  /** Whether the payload describes a DELTA (transition) or a LEVEL (resulting value). */
  shape: "delta" | "level" | "signal";
}

/**
 * Audit of every event type CE currently emits.
 *
 * The finding worth recording: `world.boundary_signal` was being emitted into the same stream
 * as world facts, and it is not a fact — it is the quota mechanism telling itself that pressure
 * crossed a region border, carrying `pressure`, `hops`, `origin` and `generation`. A game has
 * nothing to do with "0.397 pressure travelled 1 hop". At 9 of 21 events in a typical burst it
 * was also the single most numerous thing in the stream. Publishing it would have made
 * internal scheduling part of the public contract.
 */
export const EVENT_CATALOG: Record<string, EventTypeSpec> = {
  "economy.trade_disruption": {
    type: "economy.trade_disruption",
    kind: "fact",
    domain: "economy",
    meaning: "a trade route's economic pressure resolved; trade was disrupted",
    shape: "signal",
  },
  "economy.price_shock": {
    type: "economy.price_shock",
    kind: "fact",
    domain: "economy",
    meaning: "a multiplicative price shock was applied to a region's grain price",
    shape: "delta",
  },
  "ecology.food_availability": {
    type: "ecology.food_availability",
    kind: "fact",
    domain: "ecology",
    meaning: "a region's food production was scaled for the following tick",
    shape: "delta",
  },
  "faction.hostility_increase": {
    type: "faction.hostility_increase",
    kind: "fact",
    domain: "faction",
    meaning: "a faction's hostility toward the player rose, via the economy pathway",
    shape: "delta",
  },
  "faction.relations_change": {
    type: "faction.relations_change",
    kind: "fact",
    domain: "faction",
    meaning: "a faction's hostility toward the player rose, via the faction pathway",
    shape: "delta",
  },
  "civic.unrest_increase": {
    type: "civic.unrest_increase",
    kind: "fact",
    domain: "civic",
    meaning: "a region's civic unrest rose",
    shape: "delta",
  },
  "world.boundary_signal": {
    type: "world.boundary_signal",
    kind: "internal",
    domain: "world",
    meaning: "quota pressure crossed a region boundary (engine scheduling detail)",
    shape: "signal",
  },
};

export function specFor(type: string): EventTypeSpec | undefined {
  return EVENT_CATALOG[type];
}

export function isConsumerFact(ev: WorldEvent): boolean {
  return (EVENT_CATALOG[ev.type]?.kind ?? "fact") === "fact";
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Deterministic, timeline-scoped event identity.
 *
 * DERIVED FROM: timelineId + tick + within-tick ordinal + type + region + canonical payload.
 * NEVER from: wall-clock, process id, memory address, random UUID, or a global counter.
 *
 * Why the timeline is in the hash: the previous scheme was a bare global counter (`ev-22`), so
 * two unrelated branches forked from the same checkpoint both minted `ev-22` for completely
 * different facts. Measured collision: 3 of 3 post-fork events collided. A consumer watching
 * two timelines would have deduplicated distinct facts. §19.13 requires this to be impossible.
 *
 * Why the ordinal is in the hash: two genuinely distinct events can share (tick, type, region,
 * payload) — e.g. the same boundary signal reaching one region from two different neighbours.
 * Content alone would merge them. The ordinal is the within-tick emission position, which is
 * already deterministic because every engine traversal is explicitly sorted.
 */
export function deriveEventId(
  timelineId: string,
  tick: number,
  ordinal: number,
  type: string,
  regionId: RegionId | undefined,
  data: Record<string, unknown>,
): string {
  const payload = JSON.stringify(sortKeys({ timelineId, tick, ordinal, type, regionId: regionId ?? null, data }));
  return `E-${createHash("sha256").update(payload).digest("hex").slice(0, 16)}`;
}

/** Content fingerprint ignoring identity and position — used for coalescing and ordering ties. */
export function eventContentHash(ev: WorldEvent): string {
  const payload = JSON.stringify(sortKeys({ type: ev.type, regionId: ev.regionId ?? null, data: ev.data }));
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * ORDERING GUARANTEE (§19.3): **per-tick canonical total order**, and ticks are ordered.
 *
 * Chosen over the alternatives for concrete reasons:
 *
 *   - A GLOBAL TOTAL ORDER over emission sequence is what the old counter gave, and it is
 *     fragile: it encodes the engine's internal traversal into the public contract, so
 *     reordering a phase would renumber history. Rejected.
 *   - CAUSAL (partial) ORDER is genuinely available — every fact can reference its provenance
 *     node — but it is not needed *in the stream*: a consumer that wants ancestry can ask
 *     `explain()`. Putting a partial order in a stream also forces consumers to implement
 *     topological buffering, which is a large cost for a capability few need. Rejected as the
 *     baseline, retained as a queryable property (§19.16).
 *   - PER-REGION / PER-DOMAIN order alone is too weak: a single tick's economy resolution and
 *     the faction reaction it triggers would be unordered relative to each other.
 *
 * The canonical key is (tick, kind, regionId, source, type, contentHash). It is a total order
 * that does NOT depend on JavaScript iteration order, and it is stable under refactoring of the
 * engine's internal traversal — emission position is used only for identity, never for order.
 *
 * REGION BEFORE SOURCE, deliberately: regions are CE's simulation partitions (§6), so grouping
 * a tick's facts by region gives a region-scoped consumer a contiguous slice to read, and it
 * matches how a game would shard interest. Sorting by emitting domain first would scatter one
 * town's facts across domain groups for no consumer benefit.
 */
export interface OrderedEvent extends WorldEvent {
  /** Position in the canonical per-tick order, 0-based. */
  ordinal: number;
}

export function canonicalCompare(a: WorldEvent, b: WorldEvent): number {
  if (a.tick !== b.tick) return a.tick - b.tick;
  const ka = EVENT_CATALOG[a.type]?.kind ?? "fact";
  const kb = EVENT_CATALOG[b.type]?.kind ?? "fact";
  if (ka !== kb) return ka < kb ? -1 : 1; // "fact" before "internal"
  const ra = a.regionId ?? "";
  const rb = b.regionId ?? "";
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  const ca = eventContentHash(a);
  const cb = eventContentHash(b);
  if (ca !== cb) return ca < cb ? -1 : 1;
  // Genuinely indistinguishable except for emission position (e.g. the same boundary signal
  // arriving from two neighbours): fall back to the ordinal so the order stays total.
  return a.ordinal - b.ordinal;
}

/** Canonical ordering of a tick's events. Stable, iteration-order independent. */
export function canonicalOrder(events: WorldEvent[]): WorldEvent[] {
  return [...events].sort(canonicalCompare);
}

/** The consumer-facing view: facts only, canonically ordered. */
export function factStream(state: WorldState): WorldEvent[] {
  return canonicalOrder(state.events.filter(isConsumerFact));
}

/**
 * Windowed access to the fact stream. Returns at most `limit` consumer facts
 * whose `streamSeq` is strictly greater than `afterSeq`.
 *
 * Returns facts in canonical order with stable streamSeq values. An empty result
 * means either (a) no new facts exist yet or (b) the requested window is beyond
 * the newest fact — the caller can distinguish by comparing afterSeq to
 * state.highestEmittedSeq.
 *
 * If `afterSeq < state.oldestRetainedSeq - 1`, the caller's cursor has been
 * evicted. The caller should use `classifyCursor()` / `describeGap()` to detect
 * this before calling stream().
 */
export function stream(state: WorldState, afterSeq: number, limit = 100): WorldEvent[] {
  const all = factStream(state);
  const filtered = all.filter((e) => e.streamSeq > afterSeq);
  return filtered.slice(0, limit);
}

/** The full record including engine internals — for debugging and determinism audits. */
export function fullRecord(state: WorldState): WorldEvent[] {
  return canonicalOrder(state.events);
}

// ---------------------------------------------------------------------------
// Causal attribution
// ---------------------------------------------------------------------------

export interface EventAttribution {
  eventId: string;
  /** Provenance node this fact points at, if any. */
  causeNodeId: string | null;
  /** True when the referenced node is still retained. */
  causeAvailable: boolean;
  tick: number;
  regionId?: RegionId;
  domain?: DomainId | "world";
}

/**
 * Answer "why did this event occur?" by REFERENCE, never by copying the provenance graph into
 * the event. A reference stays small and cannot drift from the graph; an embedded copy would
 * duplicate the whole DAG per event and could contradict it after compaction.
 *
 * When the referenced node has been evicted (§18 compaction), this reports
 * `causeAvailable: false` rather than pretending the event is uncaused — the same honesty rule
 * `explain()` follows.
 */
export function attributeEvent(state: WorldState, ev: WorldEvent): EventAttribution {
  const causeNodeId = typeof ev.data["causeNode"] === "string" ? (ev.data["causeNode"] as string) : null;
  const available = causeNodeId !== null && state.provenance.some((n) => n.id === causeNodeId);
  return {
    eventId: ev.id,
    causeNodeId,
    causeAvailable: available,
    tick: ev.tick,
    ...(ev.regionId !== undefined ? { regionId: ev.regionId } : {}),
    ...(EVENT_CATALOG[ev.type]?.domain !== undefined ? { domain: EVENT_CATALOG[ev.type]!.domain } : {}),
  };
}

// ---------------------------------------------------------------------------
// Coalescing (§19.15)
// ---------------------------------------------------------------------------

/**
 * Coalesce a run of same-type, same-region DELTA facts into the smallest set a
 * state-synchronising consumer needs.
 *
 * SEMANTIC BOUNDARY, stated precisely: coalescing is a **transport-side optimisation for a
 * consumer that only wants current truth**. It is:
 *   - NEVER written back into `state.events` (the record stays authoritative and complete),
 *   - NEVER written into provenance (that would be forging derived summaries into authority,
 *     the same line §18.4 refused to cross),
 *   - only valid for `delta`/`level` shapes, because a `signal` fact ("trade was disrupted")
 *     is not a quantity that can be summed or superseded.
 *
 * A coalesced batch is explicitly marked, so a consumer can tell it is reading a summary rather
 * than the original run.
 */
export interface CoalescedFact {
  type: string;
  regionId?: RegionId;
  /** Number of original facts represented. */
  count: number;
  /** Ids of every original fact, so the summary stays traceable to the record. */
  sourceEventIds: string[];
  firstTick: number;
  lastTick: number;
  /** For delta shapes: product of factors / sum of amounts, whichever the payload uses. */
  aggregate: Record<string, number>;
  coalesced: true;
}

export function coalesceFacts(events: WorldEvent[]): CoalescedFact[] {
  const groups = new Map<string, WorldEvent[]>();
  for (const ev of canonicalOrder(events)) {
    const spec = EVENT_CATALOG[ev.type];
    if (!spec || spec.kind !== "fact" || spec.shape === "signal") continue;
    const gk = `${ev.type}|${ev.regionId ?? ""}`;
    const list = groups.get(gk) ?? [];
    list.push(ev);
    groups.set(gk, list);
  }

  const out: CoalescedFact[] = [];
  for (const gk of [...groups.keys()].sort()) {
    const list = groups.get(gk)!;
    const first = list[0]!;
    const aggregate: Record<string, number> = {};
    for (const ev of list) {
      for (const [k, v] of Object.entries(ev.data)) {
        if (typeof v !== "number") continue;
        // `factor` composes multiplicatively; `amount`/`pressure` accumulate additively.
        if (k === "factor") aggregate[k] = (aggregate[k] ?? 1) * v;
        else aggregate[k] = (aggregate[k] ?? 0) + v;
      }
    }
    out.push({
      type: first.type,
      ...(first.regionId !== undefined ? { regionId: first.regionId } : {}),
      count: list.length,
      sourceEventIds: list.map((e) => e.id),
      firstTick: list[0]!.tick,
      lastTick: list[list.length - 1]!.tick,
      aggregate,
      coalesced: true,
    });
  }
  return out;
}
