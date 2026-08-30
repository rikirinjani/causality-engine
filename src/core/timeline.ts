import { advance, attachEngine, createEngine, type Engine } from "./world.js";
import { stateHash, traceHash } from "./hash.js";
import { createCheckpoint, restoreCheckpoint, type CheckpointEnvelope } from "./persistence.js";
import { deriveTimelineId, type Lineage, type TimelineId } from "./genealogy.js";
import type { Intervention, WorldState } from "./types.js";

/**
 * Timeline operations: fork and rewind (docs/RECONNAISSANCE.md §17.4, §17.5).
 *
 * REWIND SEMANTICS — decided before implementing, per the brief:
 *
 *   1. The future does NOT disappear. Rewinding to tick 100 from tick 200 records the
 *      abandoned stretch in `lineage.abandonedTimelines`, with the tick it reached, the
 *      interventions it contained, and the state hash it had arrived at.
 *   2. Provenance of the abandoned future is NOT retained in the live world. The rewound
 *      world's causal history is the history of the world it actually is — carrying forward
 *      explanations for events that no longer happened would make `explain()` lie. What IS
 *      retained is the *reference*: enough identity to find, verify, and replay the
 *      abandoned future from its own checkpoint.
 *   3. The rewound world receives a NEW timeline identity (origin `rewind`). It is not the
 *      same history as before, so it must not claim to be. The old timeline id remains
 *      addressable in `abandonedTimelines`.
 *   4. The abandoned future can still be referenced, and re-derived exactly: replaying the
 *      same interventions from the same checkpoint reproduces the same state hash. That is
 *      asserted by test, and is the reason the abandoned record stores `abandonedStateHash`.
 *   5. Rewind is therefore NOT destructive to knowledge, only to the live present.
 *
 * FORK SEMANTICS: a fork creates two sibling timelines from one checkpoint. Neither is
 * privileged, both record the same parent checkpoint, and post-fork mutations are isolated by
 * construction because each branch is restored from an independently deep-cloned envelope.
 */

export interface BranchHandle {
  world: WorldState;
  engine: Engine;
  timelineId: TimelineId;
}

/** Fork a checkpoint into an independent timeline, labelled by a caller-supplied discriminator. */
export function forkTimeline(
  checkpoint: CheckpointEnvelope,
  discriminator: string,
): { ok: true; value: BranchHandle } | { ok: false; errors: string[] } {
  const restored = restoreCheckpoint(checkpoint);
  if (!restored.ok) return { ok: false, errors: restored.errors.map((e) => `${e.code}: ${e.message}`) };

  const world = restored.value.world;
  const parent = world.lineage;
  world.lineage = {
    ...parent,
    timelineId: deriveTimelineId(parent.timelineId, "fork", world.tick, discriminator),
    origin: "fork",
    parentTimelineId: parent.timelineId,
    parentCheckpointId: checkpoint.identity.checkpointId,
    forkTick: world.tick,
    divergenceInterventionIds: [],
    generation: parent.generation + 1,
  };

  const engine = attachEngine(world, createEngine());
  return { ok: true, value: { world, engine, timelineId: world.lineage.timelineId } };
}

/** Record which interventions produced a fork's divergence. Keeps genealogy answerable. */
export function noteDivergence(world: WorldState, interventions: Intervention[]): void {
  const ids = interventions.map((i) => i.id);
  const merged = [...world.lineage.divergenceInterventionIds];
  for (const id of ids) if (!merged.includes(id)) merged.push(id);
  world.lineage = { ...world.lineage, divergenceInterventionIds: merged };
}

export interface RewindResult {
  world: WorldState;
  engine: Engine;
  /** Identity of the timeline that was abandoned. */
  abandonedTimelineId: TimelineId;
  /** New timeline identity of the live world. */
  timelineId: TimelineId;
}

/**
 * Rewind a live world to an earlier checkpoint of its own timeline.
 *
 * `abandoned` is the world as it stood before rewinding — its tick, interventions and state
 * hash are recorded so the discarded future stays verifiable and replayable.
 */
export function rewindTo(
  checkpoint: CheckpointEnvelope,
  abandoned: WorldState,
): { ok: true; value: RewindResult } | { ok: false; errors: string[] } {
  if (checkpoint.identity.worldId !== abandoned.lineage.worldId) {
    return { ok: false, errors: ["cannot rewind: checkpoint belongs to a different world"] };
  }
  if (checkpoint.identity.tick > abandoned.tick) {
    return { ok: false, errors: ["cannot rewind: checkpoint is in the future of the given world"] };
  }

  const restored = restoreCheckpoint(checkpoint);
  if (!restored.ok) return { ok: false, errors: restored.errors.map((e) => `${e.code}: ${e.message}`) };

  const world = restored.value.world;
  const parent = world.lineage;
  const abandonedTimelineId = abandoned.lineage.timelineId;

  const abandonedRecord = {
    timelineId: abandonedTimelineId,
    abandonedAtTick: abandoned.tick,
    rewoundToTick: world.tick,
    resumedFromCheckpointId: checkpoint.identity.checkpointId,
    // The abandoned future is what happened AFTER the capture, and the boundary is the
    // intervention SEQUENCE, not the tick. Filtering by `submittedAtTick >= world.tick` was
    // wrong: interventions submitted in the same tick as the checkpoint but before the
    // capture are already inside it, so they were double-counted and a replay re-applied
    // them. The sequence counter is monotonic and is captured in the checkpoint, so it is
    // the exact boundary. See
    // self-harness/failures/2026-08-31-architecture-abandoned-future-tick-boundary.json
    interventionIds: abandoned.interventionHistory
      .filter((i) => i.provenance.sequence > checkpoint.world.interventionSeq)
      .map((i) => i.id),
    abandonedStateHash: stateHash(abandoned),
  };

  world.lineage = {
    ...parent,
    timelineId: deriveTimelineId(abandonedTimelineId, "rewind", world.tick, String(abandoned.tick)),
    origin: "rewind",
    parentTimelineId: abandonedTimelineId,
    parentCheckpointId: checkpoint.identity.checkpointId,
    forkTick: world.tick,
    divergenceInterventionIds: [],
    abandonedTimelines: [...(parent.abandonedTimelines ?? []), abandonedRecord],
    generation: parent.generation + 1,
  } satisfies Lineage;

  const engine = attachEngine(world, createEngine());
  return {
    ok: true,
    value: { world, engine, abandonedTimelineId, timelineId: world.lineage.timelineId },
  };
}

/**
 * Interventions belonging to the future that follows a checkpoint.
 *
 * The boundary is the monotonic intervention SEQUENCE captured in the checkpoint, not the
 * tick: several interventions can share a tick, and the ones submitted before the capture are
 * already inside it.
 */
export function interventionsAfter(checkpoint: CheckpointEnvelope, world: WorldState): Intervention[] {
  return structuredClone(
    world.interventionHistory.filter((i) => i.provenance.sequence > checkpoint.world.interventionSeq),
  );
}

/**
 * Re-derive an abandoned future from the checkpoint it was rewound from, by replaying the
 * recorded interventions. Proves the discarded history is recoverable, not merely referenced.
 */
export function replayAbandoned(
  checkpoint: CheckpointEnvelope,
  interventions: Intervention[],
  submit: (world: WorldState, engine: Engine, intervention: Intervention) => void,
  toTick: number,
): { ok: true; value: { world: WorldState; stateHash: string; traceHash: string } } | { ok: false; errors: string[] } {
  const restored = restoreCheckpoint(checkpoint);
  if (!restored.ok) return { ok: false, errors: restored.errors.map((e) => `${e.code}: ${e.message}`) };

  const world = restored.value.world;
  const engine = attachEngine(world, createEngine());

  const byTick = new Map<number, Intervention[]>();
  for (const i of interventions) {
    const t = i.provenance.submittedAtTick;
    const list = byTick.get(t) ?? [];
    list.push(i);
    byTick.set(t, list);
  }

  while (world.tick < toTick) {
    const due = byTick.get(world.tick);
    if (due) for (const i of due) submit(world, engine, i);
    advance(world, engine, 1);
  }

  return { ok: true, value: { world, stateHash: stateHash(world), traceHash: traceHash(world) } };
}

/** Convenience: create a checkpoint of a live world. */
export function checkpoint(world: WorldState, label = ""): CheckpointEnvelope {
  return createCheckpoint(world, label);
}
