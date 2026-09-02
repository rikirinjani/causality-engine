/**
 * Causality Engine — v1.0 PRODUCT SURFACE
 *
 * This is the module a game imports. It is the complete, supported contract for
 * integrating CE into a game without reading CE source code.
 *
 *   import * as ce from "causality-engine/product";
 *
 * ── Authority boundary ─────────────────────────────────────────────────────
 *
 *   CE owns       world state, causal rules, causal propagation, temporal state,
 *                 deterministic RNG, event generation, provenance, attribution,
 *                 persistence, branching, rewind, timeline identity.
 *
 *   The game owns rendering, animation, camera, UI, player input, audio, and all
 *                 game-specific presentation.
 *
 *   The adapter   translates game intent into CE interventions, projects CE state
 *   owns          and events into game-facing structures, and handles transport,
 *                 reconnection, and recovery.
 *
 * NOTHING in this module introduces a causal rule, a simulation rule, or RNG.
 * Every function here delegates to the engine. This layer reshapes calls and
 * results for ergonomics; it never decides what happens in the world.
 *
 * Engine semantics are preserved, never hidden: canonical event ordering,
 * at-least-once delivery with visible attempt counts, stable streamSeq
 * coordinates, explicit acknowledgement, explicit gap reporting, DeliveryState
 * separated from WorldState, deterministic restore, and content-derived timeline
 * identity all remain observable through this surface.
 *
 * @module causality-engine/product
 */

// ════════════════════════════════════════════════════════════════════════════
// RUNTIME API — create a world, apply actions, advance time
// ════════════════════════════════════════════════════════════════════════════
export {
  createGame,
  apply,
  step,
  bundleRuntime,
  type CausalRuntime,
  type CreateGameOptions,
  type ApplyResult,
  type StepResult,
} from "../product/runtime.js";

// ════════════════════════════════════════════════════════════════════════════
// CONFIGURATION API — validate before you simulate
// ════════════════════════════════════════════════════════════════════════════
export {
  validateConfig,
  createConfig,
  ConfigError,
  type ConfigIssue,
  type ConfigValidation,
} from "../product/config.js";

// ════════════════════════════════════════════════════════════════════════════
// INTERVENTION API — the action vocabulary, and how to submit one
// ════════════════════════════════════════════════════════════════════════════
export {
  listActions,
  describeAction,
  isActionAvailable,
  type ActionInfo,
  type TargetKind,
} from "../product/catalog.js";

export {
  buildIntervention,
  validateInterventionSpec,
  intervene,
  type InterventionSpec,
  type BuildResult,
} from "../product/intervention.js";

// ════════════════════════════════════════════════════════════════════════════
// EVENT API — at-least-once delivery with explicit acknowledgement
// ════════════════════════════════════════════════════════════════════════════
export {
  openEventStream,
  type EventStream,
  type EventBatch,
  type BatchStatus,
  type DeliveredEvent,
  type DrainReport,
} from "../product/events.js";

// ════════════════════════════════════════════════════════════════════════════
// PERSISTENCE API — save, load, deterministic continuation
// ════════════════════════════════════════════════════════════════════════════
export {
  saveGame,
  loadGame,
  loadWorld,
  readSave,
  inspectSave,
  type SaveGameResult,
  type LoadResult,
  type LoadOptions,
} from "../product/save.js";

// ════════════════════════════════════════════════════════════════════════════
// TIMELINE API — branching and rewind as first-class world operations
// ════════════════════════════════════════════════════════════════════════════
export {
  timelineOf,
  forkGame,
  rewindGame,
  compareTimelines,
  type TimelineSummary,
  type TimelineComparison,
  type TimelineDifference,
  type RewindOutcome,
} from "../product/timeline.js";

// ════════════════════════════════════════════════════════════════════════════
// INSPECTION API — what is the world, what changed, what happened
// ════════════════════════════════════════════════════════════════════════════
export {
  inspect,
  whatChanged,
  recentEvents,
  type WorldView,
  type RegionView,
  type StructureView,
  type ViewDifference,
} from "../product/inspect.js";

// ════════════════════════════════════════════════════════════════════════════
// EXPLANATION API — why did this happen
// ════════════════════════════════════════════════════════════════════════════
export { why, quantity, type CauseView, type RootAction } from "../product/explain.js";

// ════════════════════════════════════════════════════════════════════════════
// PASS-THROUGHS — engine types and constants a developer legitimately needs
// ════════════════════════════════════════════════════════════════════════════
export type {
  WorldState,
  Intervention,
  InterventionTarget,
  WorldEvent,
  DomainId,
  RegionId,
  EntityId,
  ResourceId,
} from "../core/types.js";

export type { SimConfig } from "../core/config.js";
export { DEFAULT_CONFIG } from "../core/config.js";

export type { Engine } from "../core/world.js";
export type { Cursor, DeliveryState } from "../core/delivery.js";
export type { RetentionGap } from "../core/retention.js";
export type { Lineage } from "../core/genealogy.js";

export { stateHash, traceHash } from "../core/hash.js";
export { CURRENT_SCHEMA_VERSION, MIN_MIGRATABLE_SCHEMA_VERSION } from "../core/migration.js";
