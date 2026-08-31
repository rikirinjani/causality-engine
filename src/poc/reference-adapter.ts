/**
 * Reference Adapter — a fake game-engine integration using ONLY the public API.
 *
 * This module imports exclusively from `src/api/public.ts`. It simulates what an
 * external game developer would build: a game loop that creates a world, submits
 * player actions, advances ticks, consumes events, checkpoints, restores, forks,
 * and rewinds — all without touching CE internals.
 *
 * §21.1 external-consumer boundary test.
 */
import {
  // Core
  createEngine, createWorld, submitIntervention, tick, advance,
  snapshot, attachEngine,
  // Types
  type Engine, type WorldState, type Intervention, type WorldEvent,
  // Config
  DEFAULT_CONFIG, makeConfig,
  // Checkpoint
  createCheckpoint, serializeCheckpoint, deserializeCheckpoint,
  validateCheckpoint, restoreCheckpoint,
  // Events
  factStream, fullRecord, isConsumerFact,
  // Hash
  stateHash, traceHash, configHash,
  // Delivery
  createDeliveryState, registerConsumer, poll, ack,
  serializeDelivery, deserializeDelivery, stateSync, resync,
  type DeliveryState, type PollResult, type Cursor,
  // Branching
  forkTimeline, rewindTo, interventionsAfter, replayAbandoned, checkpoint,
  type BranchHandle, type RewindResult,
  // Lifecycle
  compactHistory, classifyCheckpoint, canRewindTo,
  recentWindowPolicy, RETAIN_ALL, RESUME_ONLY,
  type RetentionPolicy, type CompactionReport, type RewindVerdict,
  // Retention
  enforceRetention, classifyCursor, describeGap, retentionWindow,
  EVENT_RETENTION_LIMIT,
  // Migration
  migrateWorld, CURRENT_SCHEMA_VERSION,
  type MigrationResult,
} from "../api/public.js";

// ─── Fake Game State ───────────────────────────────────────────────────────

export interface GameState {
  world: WorldState;
  engine: Engine;
  delivery: DeliveryState;
  score: number;
  eventsConsumed: string[];
}

// ─── Adapter Operations ────────────────────────────────────────────────────

/** Create a new game world with default config. */
export function createGame(seed = 42): GameState {
  const engine = createEngine();
  const world = createWorld(makeConfig({ seed }), engine);
  const delivery = createDeliveryState();
  registerConsumer(delivery, "game-loop");
  return { world, engine, delivery, score: 0, eventsConsumed: [] };
}

/** Translate a player action into a CE intervention. */
export function playerAction(
  state: GameState,
  action: string,
  targetId: string,
  targetType: string,
  location: string,
  magnitude: number,
): Intervention {
  return {
    id: `player-${state.world.interventionSeq + 1}`,
    tick: state.world.tick,
    actor: "player",
    action,
    target: { type: targetType as "infrastructure" | "entity" | "region", id: targetId },
    location,
    magnitude,
    causalDomains: [
      { domain: "economy", pressure: magnitude * 0.8, valence: 1, scope: "regional" },
      { domain: "faction", pressure: magnitude * 0.4, valence: 1, scope: "regional" },
    ],
    provenance: { submittedAtTick: state.world.tick, sequence: 0 },
  };
}

/** Submit and advance one tick. */
export function submitAndAdvance(state: GameState, intervention: Intervention): void {
  const result = submitIntervention(state.world, intervention, state.engine);
  if (!result.ok) throw new Error(`Intervention rejected: ${result.errors.join(", ")}`);
  advance(state.world, state.engine, 1);
  enforceRetention(state.world, EVENT_RETENTION_LIMIT);
}

/** Poll events and consume them. */
export function consumeEvents(state: GameState): WorldEvent[] {
  const result = poll(state.world, state.delivery, "game-loop");
  if (result.status === "deliverable") {
    const events = result.attempts.map((a) => a.event);
    const maxSeq = Math.max(...result.attempts.map((a) => a.streamSeq));
    ack(state.world, state.delivery, "game-loop", maxSeq);
    state.eventsConsumed.push(...events.map((e) => e.id));
    return events;
  }
  return [];
}

/** Save game to a serializable string. */
export function saveGame(state: GameState): string {
  const env = createCheckpoint(state.world, "save");
  const serialized = serializeCheckpoint(env);
  const deliverySnapshot = serializeDelivery(state.delivery);
  return JSON.stringify({ checkpoint: serialized, delivery: deliverySnapshot, score: state.score });
}

/** Load game from a serialized string. */
export function loadGame(data: string, seed = 42): GameState {
  const { checkpoint: cpData, delivery: delData, score } = JSON.parse(data);
  const env = deserializeCheckpoint(cpData);
  if (!env.ok) throw new Error("Invalid checkpoint");
  const validated = validateCheckpoint(env.value);
  if (!validated.ok) throw new Error("Checkpoint validation failed");
  const restored = restoreCheckpoint(validated.value);
  if (!restored.ok) throw new Error("Restore failed");
  const engine = createEngine();
  attachEngine(restored.value.world, engine);
  const delivery = deserializeDelivery(delData);
  registerConsumer(delivery, "game-loop");
  return { world: restored.value.world, engine, delivery, score, eventsConsumed: [] };
}

/** Fork into a what-if branch. */
export function forkGame(state: GameState, label: string): GameState {
  const env = createCheckpoint(state.world, `fork-${label}`);
  const result = forkTimeline(env, label);
  if (!result.ok) throw new Error(`Fork failed: ${result.errors.join(", ")}`);
  const delivery = createDeliveryState();
  registerConsumer(delivery, "game-loop");
  return {
    world: result.value.world,
    engine: result.value.engine,
    delivery,
    score: state.score,
    eventsConsumed: [],
  };
}

/** Rewind to a checkpoint. */
export function rewindGame(
  state: GameState,
  env: ReturnType<typeof createCheckpoint>,
): GameState {
  const result = rewindTo(env, state.world);
  if (!result.ok) throw new Error(`Rewind failed: ${result.errors.join(", ")}`);
  const delivery = createDeliveryState();
  registerConsumer(delivery, "game-loop");
  return {
    world: result.value.world,
    engine: result.value.engine,
    delivery,
    score: state.score,
    eventsConsumed: [],
  };
}

/** Get current game snapshot for rendering. */
export function getGameView(state: GameState) {
  return {
    tick: state.world.tick,
    hash: stateHash(state.world),
    regions: Object.entries(state.world.regions).map(([id, r]) => ({
      id,
      grainPrice: r.prices["grain"] ?? 0,
      grainStock: r.stocks["grain"] ?? 0,
      unrest: r.unrest,
    })),
    score: state.score,
    eventsConsumed: state.eventsConsumed.length,
  };
}
