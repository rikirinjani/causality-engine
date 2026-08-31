/**
 * Public Core API — the smallest stable surface for game developers (§21).
 *
 * This module re-exports only the symbols a game developer needs to create,
 * run, snapshot, restore, and query a causal world. All other engine internals
 * (provenance, convergence, delivery, branching, lifecycle, migration) are
 * adapter-facing or internal and live outside this surface.
 *
 * @module causality-engine/public
 */

// ── Core operations ────────────────────────────────────────────────────────
export {
  createEngine,
  createWorld,
  submitIntervention,
  tick,
  advance,
  snapshot,
  attachEngine,
  type Engine,
} from "../core/world.js";

// ── Types the developer directly works with ────────────────────────────────
export type {
  WorldState,
  Intervention,
  InterventionTarget,
  CausalContribution,
  DomainId,
  RegionId,
  EntityId,
  ResourceId,
  WorldEvent,
} from "../core/types.js";

// ── Configuration ──────────────────────────────────────────────────────────
export { SimConfig, DEFAULT_CONFIG, makeConfig } from "../core/config.js";

// ── Checkpoint (for persistence round-trip) ────────────────────────────────
export {
  type CheckpointEnvelope,
  createCheckpoint,
  serializeCheckpoint,
  deserializeCheckpoint,
  validateCheckpoint,
  restoreCheckpoint,
  type RestoreOptions,
  type RestoredWorld,
} from "../core/persistence.js";

// ── Events (for querying historical facts) ─────────────────────────────────
export { factStream, fullRecord, isConsumerFact } from "../core/events.js";

// ── Hash (for determinism verification) ────────────────────────────────────
export { stateHash, traceHash } from "../core/hash.js";

// ── Lineage (embedded in WorldState) ───────────────────────────────────────
export type { Lineage } from "../core/genealogy.js";
