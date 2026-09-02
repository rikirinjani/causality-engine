/**
 * CE v1.0 — Timeline operations (product boundary).
 *
 * Branching and rewind are FIRST-CLASS world operations, not save-file tricks.
 * This module reduces them to one call each while preserving every semantic the
 * engine guarantees:
 *
 *   - a fork is an INDEPENDENT timeline with its own identity and lineage
 *   - a rewind ABANDONS a future, and the abandoned timeline stays referenceable
 *   - the parent runtime is never mutated by forking from its save data
 *   - timeline identity is content-derived, never a counter
 *
 * All timeline authority remains in the engine. This layer only reshapes calls.
 */
import { forkTimeline, rewindTo } from "../core/timeline.js";
import { stateHash, traceHash } from "../core/hash.js";
import { bundleRuntime, type CausalRuntime } from "./runtime.js";
import { readSave, type LoadOptions, type LoadResult } from "./save.js";
import { inspect, type WorldView } from "./inspect.js";

export interface TimelineSummary {
  timelineId: string;
  worldId: string;
  /** "genesis" | "fork" | "rewind" | "migration" — how this timeline came to exist. */
  origin: string;
  parentTimelineId: string | null;
  parentCheckpointId: string | null;
  forkTick: number | null;
  /** Depth from genesis. 0 for the first timeline. */
  generation: number;
  tick: number;
  stateHash: string;
  traceHash: string;
}

/** Identity and lineage of the timeline a runtime is currently on. */
export function timelineOf(rt: CausalRuntime): TimelineSummary {
  const lineage = rt.world.lineage;
  return {
    timelineId: lineage.timelineId,
    worldId: lineage.worldId,
    origin: lineage.origin,
    parentTimelineId: lineage.parentTimelineId,
    parentCheckpointId: lineage.parentCheckpointId,
    forkTick: lineage.forkTick,
    generation: lineage.generation,
    tick: rt.world.tick,
    stateHash: stateHash(rt.world),
    traceHash: traceHash(rt.world),
  };
}

/**
 * Fork an independent timeline from save data.
 *
 * The runtime that produced the save is completely untouched — a fork reads the
 * checkpoint, it does not borrow the live world. Both timelines can then be
 * advanced with different interventions and compared.
 */
export function forkGame(data: string, discriminator: string, opts: LoadOptions = {}): LoadResult {
  const read = readSave(data);
  if (!read.ok) return { ok: false, errors: read.errors };

  const forked = forkTimeline(read.envelope, discriminator);
  if (!forked.ok) return { ok: false, errors: forked.errors };

  // forkTimeline already attached an engine — pass it through rather than
  // attaching a second one, which would detach the first.
  const runtime = bundleRuntime(forked.value.world, opts.consumerId ?? "game", forked.value.engine);
  return { ok: true, runtime, migrated: false, warnings: [] };
}

export type RewindOutcome =
  | { ok: true; runtime: CausalRuntime; abandonedTimelineId: string }
  | { ok: false; errors: string[] };

/**
 * Rewind a runtime to an earlier checkpoint of its own timeline.
 *
 * Returns a NEW runtime rather than mutating in place, so a failed rewind cannot
 * leave a half-rewound world. The abandoned timeline id is reported because the
 * discarded future remains verifiable and replayable.
 */
export function rewindGame(rt: CausalRuntime, data: string, opts: LoadOptions = {}): RewindOutcome {
  const read = readSave(data);
  if (!read.ok) return { ok: false, errors: read.errors };

  const rewound = rewindTo(read.envelope, rt.world);
  if (!rewound.ok) return { ok: false, errors: rewound.errors };

  const runtime = bundleRuntime(rewound.value.world, opts.consumerId ?? "game", rewound.value.engine);
  return { ok: true, runtime, abandonedTimelineId: rewound.value.abandonedTimelineId };
}

export interface TimelineDifference {
  path: string;
  a: unknown;
  b: unknown;
}

export interface TimelineComparison {
  a: TimelineSummary;
  b: TimelineSummary;
  /** Different timeline identities. Two forks are always distinct. */
  distinct: boolean;
  /** Same physical world. Can be true while histories differ. */
  stateHashEqual: boolean;
  /** Same causal history. */
  traceHashEqual: boolean;
  /** Observable divergence in projected quantities. */
  differences: TimelineDifference[];
}

function compareNumericRecord(
  out: TimelineDifference[],
  prefix: string,
  a: Record<string, number>,
  b: Record<string, number>,
): void {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) {
    if (a[key] !== b[key]) out.push({ path: `${prefix}.${key}`, a: a[key], b: b[key] });
  }
}

function projectDifferences(viewA: WorldView, viewB: WorldView): TimelineDifference[] {
  const out: TimelineDifference[] = [];
  const regionIds = [...new Set([...Object.keys(viewA.regions), ...Object.keys(viewB.regions)])].sort();

  for (const regionId of regionIds) {
    const ra = viewA.regions[regionId];
    const rb = viewB.regions[regionId];
    if (ra === undefined || rb === undefined) {
      out.push({ path: `regions.${regionId}`, a: ra, b: rb });
      continue;
    }

    compareNumericRecord(out, `regions.${regionId}.prices`, ra.prices, rb.prices);
    compareNumericRecord(out, `regions.${regionId}.stocks`, ra.stocks, rb.stocks);
    if (ra.unrest !== rb.unrest) out.push({ path: `regions.${regionId}.unrest`, a: ra.unrest, b: rb.unrest });
    if (ra.patrolDemand !== rb.patrolDemand) {
      out.push({ path: `regions.${regionId}.patrolDemand`, a: ra.patrolDemand, b: rb.patrolDemand });
    }
    if (ra.tradeInvestment !== rb.tradeInvestment) {
      out.push({ path: `regions.${regionId}.tradeInvestment`, a: ra.tradeInvestment, b: rb.tradeInvestment });
    }

    const structureIds = [
      ...new Set([...Object.keys(ra.infrastructure), ...Object.keys(rb.infrastructure)]),
    ].sort();
    for (const structureId of structureIds) {
      const sa = ra.infrastructure[structureId];
      const sb = rb.infrastructure[structureId];
      if (sa === undefined || sb === undefined) {
        out.push({ path: `regions.${regionId}.infrastructure.${structureId}`, a: sa, b: sb });
        continue;
      }
      if (sa.health !== sb.health) {
        out.push({
          path: `regions.${regionId}.infrastructure.${structureId}.health`,
          a: sa.health,
          b: sb.health,
        });
      }
    }
  }

  const relationKeys = [...new Set([...Object.keys(viewA.relations), ...Object.keys(viewB.relations)])].sort();
  for (const key of relationKeys) {
    if (viewA.relations[key] !== viewB.relations[key]) {
      out.push({ path: `relations.${key}`, a: viewA.relations[key], b: viewB.relations[key] });
    }
  }

  return out;
}

/**
 * Compare two timelines side by side.
 *
 * `stateHashEqual` and `traceHashEqual` are reported separately on purpose: two
 * branches can converge to identical physics while retaining different causal
 * histories. The engine never collapses them, and neither does this comparison.
 */
export function compareTimelines(a: CausalRuntime, b: CausalRuntime): TimelineComparison {
  const summaryA = timelineOf(a);
  const summaryB = timelineOf(b);

  return {
    a: summaryA,
    b: summaryB,
    distinct: summaryA.timelineId !== summaryB.timelineId,
    stateHashEqual: summaryA.stateHash === summaryB.stateHash,
    traceHashEqual: summaryA.traceHash === summaryB.traceHash,
    differences: projectDifferences(inspect(a), inspect(b)),
  };
}
