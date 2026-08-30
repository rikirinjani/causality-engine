/**
 * CE genealogy ontology (docs/RECONNAISSANCE.md §17.6).
 *
 * TERMINOLOGY IS CHOSEN, NOT INHERITED. Kronos Engine used `UniverseID` / `RewindPoint` /
 * `Branch` with counters like `U-2026-0001`. Those names carry a cosmological framing that
 * suits a historical counterfactual engine and actively misleads in a game: a player saving
 * their game is not creating a universe.
 *
 * The smallest ontology that answers every genealogy question the brief asks:
 *
 *   World      — one persistent game world. Stable across every save, rewind and fork.
 *                Identified by `worldId`; carries the seed that generated it.
 *   Timeline   — one causal history within a world. A fork or a rewind creates a NEW
 *                timeline; ordinary play does not. This is what "branch" means here, and
 *                `timeline` says it without implying version control.
 *   Checkpoint — a captured, resumable point in a timeline. This is the persistence unit.
 *                Deliberately NOT called a Rewind Point: rewinding is one of several things
 *                you can do with a checkpoint (also: save/load, crash recovery, forking),
 *                and naming the artefact after one use narrows it wrongly.
 *
 * Rejected as unnecessary:
 *   - `universe`      — cosmological framing, no game meaning.
 *   - `snapshot` as a distinct concept from checkpoint — one persistence unit is enough;
 *     `snapshot` is kept only as the verb/in-memory projection already in world.ts.
 *   - `recovery point` — a checkpoint used for crash recovery; a USE, not a kind.
 *   - `fork` as a noun — the relationship is already expressed by parent links.
 *
 * Lineage lives INSIDE WorldState so it is covered by stateHash: two worlds with identical
 * physics but different ancestry are not the same world, and a save file must not be able to
 * masquerade as a different lineage.
 */

export type WorldId = string;
export type TimelineId = string;
export type CheckpointId = string;

/** Why a timeline came into existence. */
export type TimelineOrigin =
  | "genesis" // the world's first timeline
  | "fork" // deliberate divergence from a checkpoint (branching)
  | "rewind" // the world was rewound; the abandoned future is preserved as a sibling
  | "migration"; // resumed under changed configuration, so given a fresh identity

/**
 * The genealogy record carried by a live world.
 *
 * `abandonedTimelines` is what makes a rewind honest: the future you rewound away from is
 * not deleted, it is left addressable. A rewind that silently erased its own history would
 * make "does replay reproduce the old future?" unanswerable.
 */
export interface Lineage {
  worldId: WorldId;
  timelineId: TimelineId;
  origin: TimelineOrigin;
  /** Timeline this one diverged from (null for genesis). */
  parentTimelineId: TimelineId | null;
  /** Checkpoint the divergence happened at (null for genesis). */
  parentCheckpointId: CheckpointId | null;
  /** Tick at which this timeline diverged from its parent (null for genesis). */
  forkTick: number | null;
  /**
   * Intervention ids that created the divergence, if any. A rewind has none (divergence is
   * the removal of a future, not an action); a fork usually names the interventions applied
   * after the split.
   */
  divergenceInterventionIds: string[];
  /** Timelines this world walked away from, newest last. Never pruned by a rewind. */
  abandonedTimelines: AbandonedTimeline[];
  /** Depth from genesis; 0 for the first timeline. */
  generation: number;
}

/** A timeline the world left behind, retained so the abandoned future stays referenceable. */
export interface AbandonedTimeline {
  timelineId: TimelineId;
  /** Tick the abandoned timeline had reached when it was left. */
  abandonedAtTick: number;
  /** Tick the world returned to. */
  rewoundToTick: number;
  /** Checkpoint the world resumed from. */
  resumedFromCheckpointId: CheckpointId;
  /** Interventions that had been applied in the abandoned future, for reference/replay. */
  interventionIds: string[];
  /** State hash the abandoned timeline had reached — proof it existed and what it became. */
  abandonedStateHash: string;
}

/**
 * Deterministic id derivation.
 *
 * Ids are derived from content, never from a global counter or a clock. Module-level counters
 * were a documented Kronos weakness (they break under concurrent worlds and force test-only
 * reset hooks), and a timestamp would make ids unreplayable. Derivation means the same fork
 * performed twice produces the same id, which is what replay requires.
 */
export function deriveTimelineId(
  parent: TimelineId | null,
  origin: TimelineOrigin,
  atTick: number,
  discriminator: string,
): TimelineId {
  const base = `${parent ?? "genesis"}|${origin}|${atTick}|${discriminator}`;
  return `T-${fnv1a(base)}`;
}

export function deriveCheckpointId(
  worldId: WorldId,
  timelineId: TimelineId,
  tick: number,
  stateHash: string,
  traceHash: string,
): CheckpointId {
  return `C-${fnv1a(`${worldId}|${timelineId}|${tick}|${stateHash}|${traceHash}`)}`;
}

export function deriveWorldId(seed: number, label: string): WorldId {
  return `W-${fnv1a(`${seed}|${label}`)}`;
}

/** 32-bit FNV-1a as 8 lowercase hex chars. Used for readable ids only, never for integrity. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function genesisLineage(seed: number, label: string): Lineage {
  const worldId = deriveWorldId(seed, label);
  return {
    worldId,
    timelineId: deriveTimelineId(null, "genesis", 0, worldId),
    origin: "genesis",
    parentTimelineId: null,
    parentCheckpointId: null,
    forkTick: null,
    divergenceInterventionIds: [],
    abandonedTimelines: [],
    generation: 0,
  };
}

/** Walk a world's ancestry as ids, oldest first. Answers "which world did this come from?". */
export function ancestryOf(lineage: Lineage): string[] {
  const chain: string[] = [];
  if (lineage.parentTimelineId) chain.push(lineage.parentTimelineId);
  chain.push(lineage.timelineId);
  return chain;
}
