/**
 * Public Core API — the smallest stable surface for game developers (§21).
 *
 * This module re-exports only the symbols a game developer needs to create,
 * run, snapshot, restore, and query a causal world. All other engine internals
 * (provenance, convergence, domain resolvers, harness) are internal and live
 * outside this surface.
 *
 * @module causality-engine/public
 */

// ── Core operations (GAME DEVELOPER) ───────────────────────────────────────
export {
  createEngine,
  createWorld,
  submitIntervention,
  submitBatch,
  tick,
  advance,
  snapshot,
  attachEngine,
  type Engine,
} from "../core/world.js";

// ── Types the developer directly works with (GAME DEVELOPER) ───────────────
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

// ── Configuration (GAME DEVELOPER) ─────────────────────────────────────────
export { DEFAULT_CONFIG, makeConfig } from "../core/config.js";
export type { SimConfig } from "../core/config.js";

// ── Checkpoint (ADAPTER-FACING) ────────────────────────────────────────────
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

// ── Events (ADAPTER-FACING) ────────────────────────────────────────────────
export { factStream, fullRecord, isConsumerFact, stream } from "../core/events.js";
export { type EventAttribution, attributeEvent } from "../core/events.js";

// ── Hash (ADAPTER-FACING) ──────────────────────────────────────────────────
export { stateHash, traceHash, configHash } from "../core/hash.js";

// ── Lineage (embedded in WorldState) ───────────────────────────────────────
export type { Lineage } from "../core/genealogy.js";

// ── Provenance / Attribution (ADAPTER-FACING) ─────────────────────────────
export { explain, key, type Explanation, type RootCause, type ProvenanceNode } from "../core/provenance.js";

// ════════════════════════════════════════════════════════════════════════════
// ADAPTER-FACING: Delivery (§19, §20)
// ════════════════════════════════════════════════════════════════════════════
export {
  type Cursor,
  type ConsumerChannel,
  type DeliveryState,
  type PollResult,
  type StateSync,
  createDeliveryState,
  registerConsumer,
  poll,
  ack,
  serializeDelivery,
  deserializeDelivery,
  stateSync,
  resync,
} from "../core/delivery.js";

// ════════════════════════════════════════════════════════════════════════════
// ADAPTER-FACING: Branching (§17)
// ════════════════════════════════════════════════════════════════════════════
export {
  type BranchHandle,
  type RewindResult,
  forkTimeline,
  rewindTo,
  interventionsAfter,
  replayAbandoned,
  checkpoint,
} from "../core/timeline.js";

// ════════════════════════════════════════════════════════════════════════════
// ADAPTER-FACING: Lifecycle (§18)
// ════════════════════════════════════════════════════════════════════════════
export {
  type CheckpointClass,
  type CheckpointClassification,
  type RetentionPolicy,
  type CompactionReport,
  type RewindVerdict,
  RETAIN_ALL,
  RESUME_ONLY,
  recentWindowPolicy,
  compactHistory,
  classifyCheckpoint,
  canRewindTo,
} from "../core/lifecycle.js";

// ════════════════════════════════════════════════════════════════════════════
// ADAPTER-FACING: Retention (§20)
// ════════════════════════════════════════════════════════════════════════════
export {
  type RetentionWindow,
  type RetentionGap,
  enforceRetention,
  classifyCursor,
  describeGap,
  retentionWindow,
  EVENT_RETENTION_LIMIT,
} from "../core/retention.js";

// ════════════════════════════════════════════════════════════════════════════
// ADAPTER-FACING: Migration (§18)
// ════════════════════════════════════════════════════════════════════════════
export {
  type MigrationResult,
  CURRENT_SCHEMA_VERSION,
  MIN_MIGRATABLE_SCHEMA_VERSION,
  migrateWorld,
} from "../core/migration.js";
