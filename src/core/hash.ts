import { createHash } from "node:crypto";
import type { WorldState } from "./types.js";

/** Recursively sort object keys so hashing is independent of insertion order. */
export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return v;
}

/**
 * SHA-256 over the deterministic projection of the WORLD — the physical situation plus the
 * identity that situation belongs to.
 *
 * Includes:
 *   - config: two runs with the same seed but different tuning must be distinguishable.
 *     (Kronos omitted tuning from its universe hash, so differently-tuned runs shared
 *     provenance. §14.3 closed that.)
 *   - lineage: a world's ancestry is part of what it IS. A save file must not be able to
 *     claim a different lineage while hashing identically.
 *   - pendingContributions: unresolved causal work is genuine simulation state. Omitting it
 *     would let a mid-tick snapshot hash equal to a settled one (§17.3). Note the bucket
 *     holds PHYSICS ONLY — provenance ids live in `pendingCauses` on the trace side, because
 *     compaction and migration renumber ids and a physically identical world must not change
 *     identity when they do (§18.2).
 *   - dynamics: convergence traces are READ by the tick, so they are continuation state
 *     despite looking like history (§18.4).
 *
 * EXCLUDES `events`. This was corrected during the event-stream pass (§19.11). §17 had put the
 * event buffer in world identity on the grounds that it is an undrained outbound queue, i.e.
 * delivery state. That conflated two things: a RECORD OF FACTS THAT OCCURRED (history) with a
 * DELIVERY OBLIGATION (bookkeeping about a consumer). Now that delivery lives in
 * `DeliveryState` outside the world, the buffer is purely a record — and the engine never reads
 * it, so it cannot affect the future. Verified: forward evolution is bit-identical with the
 * buffer present or emptied. Keeping it in `stateHash` also made timeline-scoped event ids leak
 * timeline identity into physical state, so two physically identical worlds in different
 * branches stopped comparing equal.
 *
 * Excludes provenance, resolution log, diagnostics and intervention history for the same
 * reason: they explain HOW the world was reached, not WHAT it is. Two different histories can
 * legitimately reach the same world, and stateHash must report that as identical. Use
 * `traceHash` to compare histories.
 */
export function stateHash(state: WorldState): string {
  const payload = sortKeys({
    tick: state.tick,
    schemaVersion: state.schemaVersion,
    lineage: state.lineage,
    config: state.config,
    regions: state.regions,
    entities: state.entities,
    relations: state.relations,
    pendingContributions: state.pendingContributions,
    dynamics: state.dynamics,
    rngState: state.rngState,
    tradeVolume: state.tradeVolume,
  });
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * SHA-256 over the CAUSAL HISTORY: provenance graph, every quota resolution decision,
 * diagnostics, the emitted fact record, and the intervention history.
 *
 * Replay must reproduce not only the final world but the reasoning that led there, including
 * which thresholds fired, which did not, which anomalies were surfaced, and which facts were
 * emitted to consumers.
 */
export function traceHash(state: WorldState): string {
  const payload = sortKeys({
    provenance: state.provenance,
    provenanceRefs: state.provenanceRefs,
    resolutionLog: state.resolutionLog,
    ledgerCauses: state.ledgerCauses,
    pendingCauses: state.pendingCauses,
    diagnostics: state.diagnostics,
    events: state.events,
    interventionHistory: state.interventionHistory,
    historyTruncated: state.historyTruncated,
    // Retention boundary is part of the retained-evidence description:
    // evicting changes what history CE can still serve, so it changes traceHash
    // (but never stateHash). The limit itself is not hashed — it is a policy, not
    // evidence. See §20.16.
    highestEmittedSeq: state.highestEmittedSeq,
    oldestRetainedSeq: state.oldestRetainedSeq,
    evictedCount: state.evictedCount,
  });
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * SHA-256 over the simulation configuration alone.
 *
 * Separate from stateHash so a loader can answer "is this save compatible with my current
 * causal parameters?" WITHOUT having to reconstruct the world first (§17.9).
 */
export function configHash(state: WorldState): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(state.config))).digest("hex");
}
