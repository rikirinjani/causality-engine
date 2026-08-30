import type { ProvenanceNodeRef, WorldState } from "./types.js";

/**
 * History lifecycle: retention, compaction and checkpoint classes
 * (docs/RECONNAISSANCE.md §18).
 *
 * THE ONE RULE. History may be bounded, but a bounded history must never claim to be
 * complete, and bounding it must never change what the simulation does next. Everything here
 * follows from that.
 *
 * WHY COMPACTION IS SAFE AT ALL. The persistence pass established that `stateHash` covers the
 * world and `traceHash` covers its explanation. This pass proved the split is now airtight for
 * pending work too (provenance ids moved to `pendingCauses`). So discarding provenance changes
 * `traceHash` and leaves `stateHash` untouched — which is exactly the licence needed to bound
 * history without touching physics. A regression test asserts forward determinism after
 * compaction, because that claim is the whole justification.
 */

// ---------------------------------------------------------------------------
// Checkpoint classes
// ---------------------------------------------------------------------------

/**
 * Checkpoint classes are DESCRIPTIONS OF COMPLETENESS, not different formats.
 *
 * One representation is sufficient — the brief asked whether multiple were needed, and the
 * answer is no. `CheckpointEnvelope` already carries everything; what differs between a
 * "full" and a "resume" checkpoint is only how much history survived. Making them separate
 * types would duplicate the schema and force consumers to handle two shapes for no semantic
 * gain, and it would let a class label disagree with the payload.
 *
 * Instead the class is DERIVED from the payload (see `classifyCheckpoint`), so it cannot lie.
 *
 *   full     — complete causal history: no truncation, no compaction, every root retained.
 *   resume   — exact state and exact continuation; history bounded. Replay-from-checkpoint
 *              works; replay-from-seed and full explanation may not.
 *   archival — history retained, but state deliberately reduced. NOT IMPLEMENTED: CE has no
 *              use for a non-resumable artefact yet, and inventing one now would be
 *              speculative API surface. Named here so the gap is explicit.
 *
 * Rejected as classes: `recovery` and `fork` are USES of a checkpoint, not kinds of one —
 * a recovery point and a fork origin are both just checkpoints, and the persistence pass
 * already showed `forkTimeline` works from any of them.
 */
export type CheckpointClass = "full" | "resume";

export interface CheckpointClassification {
  class: CheckpointClass;
  /** Everything the artefact can still be used for. */
  capabilities: Capability[];
  /** Capabilities lost, each with the reason. */
  lost: Array<{ capability: Capability; reason: string }>;
}

export type Capability =
  | "exact_continuation" // advance from here, bit-identically
  | "exact_replay_from_checkpoint" // re-run from here with the same interventions
  | "replay_from_seed" // reconstruct the whole world from seed + full intervention history
  | "full_explanation" // explain() reaches originating interventions for all quantities
  | "branch_creation" // fork a new timeline
  | "rewind_within_retained" // rewind to a tick inside the retained window
  | "replay_abandoned_future"; // re-derive a future that was rewound away

// ---------------------------------------------------------------------------
// Retention policy
// ---------------------------------------------------------------------------

/**
 * A SEMANTIC retention policy. A size cap alone is not a policy: it cannot express "keep
 * whatever is needed to explain the present" or "never lose the actions a player took".
 *
 * Each flag exists because some capability depends on it, and `classifyCheckpoint` reports the
 * consequences of switching one off.
 */
export interface RetentionPolicy {
  /** Keep provenance nodes from the last N ticks. 0 = keep none, Infinity = keep all. */
  retainTicks: number;
  /**
   * Keep the intervention history in full. This is the single most load-bearing history
   * field: without it, replay-from-seed is impossible and a rewound future cannot be
   * re-derived. Discarding it is allowed but heavily consequential.
   */
  retainInterventionHistory: boolean;
  /**
   * Keep nodes that are ANCESTORS of anything the present state currently cites
   * (`provenanceRefs`), regardless of age. This is what makes "why is the world like this?"
   * survive compaction, and it is the difference between a semantic policy and a window.
   */
  retainRefAncestors: boolean;
  /** Keep root-cause (`intervention`-kind) nodes regardless of age. */
  retainCausalRoots: boolean;
  /** Keep resolution decisions from the last N ticks. */
  retainResolutionTicks: number;
  /** Keep diagnostics from the last N ticks. */
  retainDiagnosticTicks: number;
  /** Keep the genealogy record of abandoned timelines. Cheap and needed for audit. */
  retainAbandonedTimelines: boolean;
}

/** Keep everything. The default; compaction is always opt-in. */
export const RETAIN_ALL: RetentionPolicy = {
  retainTicks: Number.POSITIVE_INFINITY,
  retainInterventionHistory: true,
  retainRefAncestors: true,
  retainCausalRoots: true,
  retainResolutionTicks: Number.POSITIVE_INFINITY,
  retainDiagnosticTicks: Number.POSITIVE_INFINITY,
  retainAbandonedTimelines: true,
};

/**
 * A policy suitable for a long-running server: recent detail plus whatever explains the
 * present, plus the full record of what players did.
 */
export function recentWindowPolicy(ticks: number): RetentionPolicy {
  return {
    retainTicks: ticks,
    retainInterventionHistory: true,
    retainRefAncestors: true,
    retainCausalRoots: true,
    retainResolutionTicks: ticks,
    retainDiagnosticTicks: ticks,
    retainAbandonedTimelines: true,
  };
}

/** The most aggressive honest policy: exact continuation, no historical claims. */
export const RESUME_ONLY: RetentionPolicy = {
  retainTicks: 0,
  retainInterventionHistory: false,
  retainRefAncestors: false,
  retainCausalRoots: false,
  retainResolutionTicks: 0,
  retainDiagnosticTicks: 0,
  retainAbandonedTimelines: true,
};

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

export interface CompactionReport {
  /** Nodes/entries before and after, per log. */
  provenance: { before: number; after: number };
  resolutions: { before: number; after: number };
  diagnostics: { before: number; after: number };
  interventions: { before: number; after: number };
  /** Tick before which provenance is no longer complete. null = nothing was dropped. */
  retentionBoundaryTick: number | null;
  /** True if anything at all was discarded. */
  truncated: boolean;
  /** Capabilities that the compaction removed. */
  lost: Array<{ capability: Capability; reason: string }>;
}

/**
 * Compact a world's causal history in place, honestly.
 *
 * LOSSLESS-vs-LOSSY. Two kinds of reduction were considered (§18.4):
 *
 *   1. Lossless node merging — collapsing redundant provenance nodes that carry no
 *      distinguishing information. REJECTED for now: CE's nodes are already minimal (each
 *      records one typed transition with its parents), so any merge would either lose a
 *      distinguishable step or lose multi-parent structure, which §15 established must never
 *      be collapsed. There is no free lossless win available, so claiming one would be a lie.
 *
 *   2. State-equivalent truncation — drop history, keep exact state and continuation.
 *      ADOPTED. This is what `compactHistory` does, and the resulting artefact claims exactly
 *      "state at T is exact, future simulation is exact, history before the boundary is
 *      unavailable" — never "complete history exists".
 *
 *   3. Semantic summaries ("grain shortage was caused by trade disruption"). NOT IMPLEMENTED.
 *      If added they would be DERIVED EXPLANATION, never authoritative provenance, and would
 *      need a separate field so they can never be mistaken for original nodes. Writing them
 *      into `provenance` would be forging history. Recorded as a deliberate non-decision.
 *
 * Dangling parent references are left in place ON PURPOSE. A retained node whose parent was
 * dropped still says "I had a parent, and it is gone" — which is how `explain()` reports
 * `incomplete` with `danglingParents`. Rewriting those nodes to look parentless would erase
 * the evidence that anything was lost.
 *
 * NOT COMPACTABLE, and it matters that these are excluded deliberately rather than forgotten:
 *
 *   `dynamics` — convergence traces are READ by the tick (phase 7 continues each trajectory),
 *                so they are continuation state, not history. §19.11 moved them INTO
 *                `stateHash` for exactly that reason, so dropping them now changes world
 *                identity outright — which is the honest signal. Before that they left
 *                `stateHash` untouched while silently changing which diagnostics the world
 *                later reported (5 became 3; `RF:stock:grain` classified `converged` instead
 *                of `converged_at_bound` because `movedEver` was lost).
 *
 *   `events`   — the fact record IS history and is excluded from `stateHash` (§19.11), so it
 *                *could* be dropped state-safely. It is nonetheless left alone by
 *                `compactHistory` because it is the consumer's replay source: discarding it
 *                behind a consumer's back would create an undetectable delivery gap. Event
 *                retention is a DELIVERY decision, driven by acknowledged cursors, and it lives
 *                in the delivery layer (`detectGap` / `resync`) rather than here.
 */
export function compactHistory(state: WorldState, policy: RetentionPolicy): CompactionReport {
  const before = {
    provenance: state.provenance.length,
    resolutions: state.resolutionLog.length,
    diagnostics: state.diagnostics.length,
    interventions: state.interventionHistory.length,
  };

  const cutoff = Number.isFinite(policy.retainTicks) ? state.tick - policy.retainTicks : Number.NEGATIVE_INFINITY;

  // Which nodes must survive regardless of age?
  const keep = new Set<string>();
  if (policy.retainRefAncestors) {
    for (const id of ancestorClosure(state, Object.values(state.provenanceRefs))) keep.add(id);
  }
  if (policy.retainCausalRoots) {
    for (const n of state.provenance) if (n.kind === "intervention") keep.add(n.id);
  }
  // Cause ids still referenced by live ledgers/pending buckets are load-bearing for
  // explanation of work that has not resolved yet.
  const liveCauseIds = [
    ...Object.values(state.ledgerCauses).flat(),
    ...Object.values(state.pendingCauses).flat(),
  ];
  for (const id of ancestorClosure(state, liveCauseIds)) keep.add(id);

  state.provenance = state.provenance.filter((n) => n.tick >= cutoff || keep.has(n.id));

  const resCutoff = Number.isFinite(policy.retainResolutionTicks)
    ? state.tick - policy.retainResolutionTicks
    : Number.NEGATIVE_INFINITY;
  state.resolutionLog = state.resolutionLog.filter((d) => d.tick >= resCutoff);

  const diagCutoff = Number.isFinite(policy.retainDiagnosticTicks)
    ? state.tick - policy.retainDiagnosticTicks
    : Number.NEGATIVE_INFINITY;
  state.diagnostics = state.diagnostics.filter((d) => d.tick >= diagCutoff);

  if (!policy.retainInterventionHistory) state.interventionHistory = [];
  if (!policy.retainAbandonedTimelines) {
    state.lineage = { ...state.lineage, abandonedTimelines: [] };
  }

  const after = {
    provenance: state.provenance.length,
    resolutions: state.resolutionLog.length,
    diagnostics: state.diagnostics.length,
    interventions: state.interventionHistory.length,
  };

  const truncated =
    after.provenance < before.provenance ||
    after.resolutions < before.resolutions ||
    after.diagnostics < before.diagnostics ||
    after.interventions < before.interventions;

  if (truncated) state.historyTruncated = true;

  const boundary =
    after.provenance < before.provenance && Number.isFinite(cutoff) ? Math.max(0, Math.floor(cutoff)) : null;

  return {
    provenance: { before: before.provenance, after: after.provenance },
    resolutions: { before: before.resolutions, after: after.resolutions },
    diagnostics: { before: before.diagnostics, after: after.diagnostics },
    interventions: { before: before.interventions, after: after.interventions },
    retentionBoundaryTick: boundary,
    truncated,
    lost: lostCapabilities(state, policy),
  };
}

/** Transitive ancestor closure of a set of node ids, over retained nodes only. */
export function ancestorClosure(state: WorldState, seeds: ProvenanceNodeRef[]): Set<string> {
  const byId = new Map(state.provenance.map((n) => [n.id, n]));
  const out = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (out.has(id)) continue;
    out.add(id);
    const node = byId.get(id);
    if (!node) continue; // already gone; the gap is reported, not repaired
    for (const p of node.parents) if (!out.has(p)) queue.push(p);
  }
  return out;
}

function lostCapabilities(state: WorldState, policy: RetentionPolicy): Array<{ capability: Capability; reason: string }> {
  const lost: Array<{ capability: Capability; reason: string }> = [];
  if (!policy.retainInterventionHistory) {
    lost.push({
      capability: "replay_from_seed",
      reason: "intervention history discarded: the actions needed to re-derive this world from its seed are gone",
    });
    lost.push({
      capability: "replay_abandoned_future",
      reason: "intervention history discarded: an abandoned future cannot be re-derived without its interventions",
    });
  }
  if (state.historyTruncated || policy.retainTicks !== Number.POSITIVE_INFINITY) {
    lost.push({
      capability: "full_explanation",
      reason: "provenance bounded: explanations crossing the retention boundary report incomplete",
    });
  }
  return lost;
}

/**
 * Derive a checkpoint's class and capabilities FROM ITS PAYLOAD, so a label can never
 * contradict the artefact it describes.
 */
export function classifyCheckpoint(state: WorldState): CheckpointClassification {
  const capabilities: Capability[] = [
    // These two depend only on state + pending continuation, which are always present.
    "exact_continuation",
    "exact_replay_from_checkpoint",
    "branch_creation",
  ];
  const lost: Array<{ capability: Capability; reason: string }> = [];

  const hasInterventions = state.interventionHistory.length > 0;
  const complete = !state.historyTruncated;

  if (complete) {
    capabilities.push("full_explanation");
  } else {
    lost.push({
      capability: "full_explanation",
      reason: "history truncated: some explanations cross the retention boundary",
    });
  }

  if (hasInterventions) {
    capabilities.push("replay_from_seed", "replay_abandoned_future");
  } else {
    lost.push({
      capability: "replay_from_seed",
      reason: "no intervention history retained",
    });
    lost.push({
      capability: "replay_abandoned_future",
      reason: "no intervention history retained",
    });
  }

  // Rewind is only honest within the retained window (see §18.8).
  capabilities.push("rewind_within_retained");

  return { class: complete && hasInterventions ? "full" : "resume", capabilities, lost };
}

// ---------------------------------------------------------------------------
// Rewind eligibility after compaction
// ---------------------------------------------------------------------------

export type RewindVerdict =
  | { allowed: true; historyComplete: boolean; note: string }
  | { allowed: false; reason: string };

/**
 * RULE, chosen explicitly rather than for convenience (§18.8):
 *
 *   Rewind is permitted to any tick for which a VALID CHECKPOINT EXISTS, because a checkpoint
 *   carries exact state and exact continuation — compaction never touches those. Whether the
 *   world's HISTORY is complete at that point is a separate question, reported separately.
 *
 * Rejected alternatives:
 *   - "reject rewind past the retention boundary" — wrong, because it confuses explanation
 *     with resumability. A resume-class checkpoint from tick 20 still restores tick 20 exactly.
 *   - "retain special recovery material" — that is just a full checkpoint under another name,
 *     and would add a second artefact class for no new capability.
 *   - "require a full-history checkpoint" — would make compaction and rewind mutually
 *     exclusive, which is a real product restriction adopted to dodge a semantic question.
 *
 * What is NOT permitted is rewinding to a tick with no checkpoint by reconstructing it from
 * truncated history: that would require history CE no longer has.
 */
export function canRewindTo(
  checkpointExists: boolean,
  checkpointTick: number,
  worldTick: number,
  checkpointHistoryComplete: boolean,
): RewindVerdict {
  if (!checkpointExists) {
    return {
      allowed: false,
      reason: "no checkpoint at the requested tick; CE will not reconstruct one from truncated history",
    };
  }
  if (checkpointTick > worldTick) {
    return { allowed: false, reason: "requested tick is in the future of the given world" };
  }
  return {
    allowed: true,
    historyComplete: checkpointHistoryComplete,
    note: checkpointHistoryComplete
      ? "state and history both exact at the rewind target"
      : "state exact; causal history before the retention boundary is unavailable",
  };
}
