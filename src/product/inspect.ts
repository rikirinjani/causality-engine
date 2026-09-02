/**
 * CE v1.0 — World inspection (product boundary).
 *
 * Answers the four questions a game developer actually asks:
 *   What is the world right now?   -> inspect()
 *   What changed?                  -> whatChanged()
 *   What events occurred?          -> recentEvents()
 *   What timeline am I on?         -> inspect().timelineId (and timelineOf())
 *
 * `inspect()` returns a PROJECTION, not a clone of WorldState. Ledger internals,
 * pending contributions, provenance nodes, and RNG registers are deliberately
 * absent: a game does not need them, and exposing them would make engine
 * internals part of the public contract.
 */
import { stateHash, traceHash } from "../core/hash.js";
import type { WorldEvent, WorldState } from "../core/types.js";
import type { CausalRuntime } from "./runtime.js";

export interface StructureView {
  type: string;
  health: number;
  /** Convenience: `health > 0`. What a renderer usually wants. */
  intact: boolean;
}

export interface RegionView {
  id: string;
  name: string;
  prices: Record<string, number>;
  stocks: Record<string, number>;
  infrastructure: Record<string, StructureView>;
  unrest: number;
  patrolDemand: number;
  tradeInvestment: number;
}

export interface WorldView {
  tick: number;
  timelineId: string;
  schemaVersion: number;
  /** Physical world identity. Two worlds with identical physics share this. */
  stateHash: string;
  /** Causal history identity. Differs when the histories differ. */
  traceHash: string;
  regions: Record<string, RegionView>;
  relations: Record<string, number>;
  eventCount: number;
  /** Highest streamSeq the world has ever emitted. */
  highestSeq: number;
  /** True when the bounded record has evicted facts — explanations may be partial. */
  historyTruncated: boolean;
}

/** Accept either a runtime or a bare world, so callers never have to unwrap. */
function worldOf(source: CausalRuntime | WorldState): WorldState {
  return "world" in source ? source.world : source;
}

/** Deterministic key order — sorted, never object insertion order. */
function sortedRecord<T>(input: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(input).sort()) out[key] = input[key]!;
  return out;
}

/** Project the current world into a game-facing view. */
export function inspect(source: CausalRuntime | WorldState): WorldView {
  const world = worldOf(source);

  const regions: Record<string, RegionView> = {};
  for (const regionId of Object.keys(world.regions).sort()) {
    const region = world.regions[regionId];
    if (region === undefined) continue;

    const infrastructure: Record<string, StructureView> = {};
    for (const structureId of Object.keys(region.infrastructure).sort()) {
      const structure = region.infrastructure[structureId];
      if (structure === undefined) continue;
      infrastructure[structureId] = {
        type: structure.type,
        health: structure.health,
        intact: structure.health > 0,
      };
    }

    regions[regionId] = {
      id: region.id,
      name: region.name,
      prices: sortedRecord(region.prices),
      stocks: sortedRecord(region.stocks),
      infrastructure,
      unrest: region.unrest,
      patrolDemand: region.patrolDemand,
      tradeInvestment: region.tradeInvestment,
    };
  }

  return {
    tick: world.tick,
    timelineId: world.lineage.timelineId,
    schemaVersion: world.schemaVersion,
    stateHash: stateHash(world),
    traceHash: traceHash(world),
    regions,
    relations: sortedRecord(world.relations),
    eventCount: world.events.length,
    highestSeq: world.highestEmittedSeq,
    historyTruncated: world.historyTruncated,
  };
}

export interface ViewDifference {
  path: string;
  before: unknown;
  after: unknown;
}

function pushIfChanged(out: ViewDifference[], path: string, before: unknown, after: unknown): void {
  if (before !== after) out.push({ path, before, after });
}

function diffNumericRecord(
  out: ViewDifference[],
  prefix: string,
  before: Record<string, number>,
  after: Record<string, number>,
): void {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    pushIfChanged(out, `${prefix}.${key}`, before[key], after[key]);
  }
}

/**
 * Structural diff between two world views.
 *
 * Hashes are intentionally excluded — they change whenever anything changes and
 * would drown the signal. Compare `stateHash` directly when you want identity.
 */
export function whatChanged(before: WorldView, after: WorldView): ViewDifference[] {
  const out: ViewDifference[] = [];

  pushIfChanged(out, "tick", before.tick, after.tick);
  pushIfChanged(out, "timelineId", before.timelineId, after.timelineId);
  pushIfChanged(out, "historyTruncated", before.historyTruncated, after.historyTruncated);

  const regionIds = [...new Set([...Object.keys(before.regions), ...Object.keys(after.regions)])].sort();
  for (const regionId of regionIds) {
    const a = before.regions[regionId];
    const b = after.regions[regionId];

    if (a === undefined || b === undefined) {
      out.push({ path: `regions.${regionId}`, before: a, after: b });
      continue;
    }

    diffNumericRecord(out, `regions.${regionId}.prices`, a.prices, b.prices);
    diffNumericRecord(out, `regions.${regionId}.stocks`, a.stocks, b.stocks);
    pushIfChanged(out, `regions.${regionId}.unrest`, a.unrest, b.unrest);
    pushIfChanged(out, `regions.${regionId}.patrolDemand`, a.patrolDemand, b.patrolDemand);
    pushIfChanged(out, `regions.${regionId}.tradeInvestment`, a.tradeInvestment, b.tradeInvestment);

    const structureIds = [
      ...new Set([...Object.keys(a.infrastructure), ...Object.keys(b.infrastructure)]),
    ].sort();
    for (const structureId of structureIds) {
      const sa = a.infrastructure[structureId];
      const sb = b.infrastructure[structureId];
      if (sa === undefined || sb === undefined) {
        out.push({ path: `regions.${regionId}.infrastructure.${structureId}`, before: sa, after: sb });
        continue;
      }
      pushIfChanged(out, `regions.${regionId}.infrastructure.${structureId}.health`, sa.health, sb.health);
    }
  }

  const relationKeys = [...new Set([...Object.keys(before.relations), ...Object.keys(after.relations)])].sort();
  for (const key of relationKeys) {
    pushIfChanged(out, `relations.${key}`, before.relations[key], after.relations[key]);
  }

  return out;
}

/**
 * The most recent retained events, oldest-first.
 *
 * This reads the world's bounded record. It is NOT delivery: reading here never
 * moves a consumer cursor and carries no acknowledgement obligation. Use
 * `openEventStream()` when you need at-least-once delivery semantics.
 */
export function recentEvents(source: CausalRuntime | WorldState, limit = 20): WorldEvent[] {
  const world = worldOf(source);
  if (limit <= 0) return [];
  const events = world.events;
  return events.slice(Math.max(0, events.length - limit));
}
