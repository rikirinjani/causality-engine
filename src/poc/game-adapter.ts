/**
 * P-006: Game-Shaped Adapter — a minimal medieval town simulation using ONLY the public API.
 *
 * This module demonstrates that CE can serve as the causal world layer underneath a game,
 * with the adapter remaining a thin translation/projection layer rather than becoming a
 * second simulation engine.
 *
 * Imports: ONLY from `src/api/public.ts`. No internal CE symbols.
 *
 * Architecture:
 *   PLAYER ACTION
 *       ↓
 *   ADAPTER (translateIntent)
 *       ↓
 *   CE INTERVENTION
 *       ↓
 *   CE SIMULATION (submitIntervention + advance)
 *       ↓
 *   CE EVENTS / STATE
 *       ↓
 *   ADAPTER (consumeAndProject)
 *       ↓
 *   GAME-FACING WORLD STATE (GameView)
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

// ═══════════════════════════════════════════════════════════════════════════════
// §1 — GAME-SIDE STATE (what the game renders)
// ═══════════════════════════════════════════════════════════════════════════════

/** A town in the game world. This is a PRESENTATION projection of CE state, not a second truth. */
export interface GameTown {
  id: string;
  name: string;
  neighbors: string[];
  grainPrice: number;
  grainStock: number;
  patrolDemand: number;
  unrest: number;
  tradeInvestment: number;
  /** Whether the grain road is intact — derived from CE infrastructure health. */
  tradeRouteIntact: boolean;
  /** Whether the grain warehouse is intact — derived from CE infrastructure health. */
  warehouseIntact: boolean;
}

/** A faction in the game world. Derived from CE entity + relation state. */
export interface GameFaction {
  id: string;
  name: string;
  hostility: number;
}

/** The complete game-facing view. All fields are projections of CE state. */
export interface GameView {
  tick: number;
  stateHash: string;
  traceHash: string;
  towns: Record<string, GameTown>;
  factions: Record<string, GameFaction>;
  /** Recent game events (projected from CE facts). */
  recentEvents: GameEvent[];
}

/** A game-facing event — simplified from CE's WorldEvent. */
export interface GameEvent {
  id: string;
  type: string;
  region?: string;
  detail: string;
  tick: number;
}

/** Player action types the game exposes. */
export type PlayerAction =
  | { kind: "destroy_bridge"; location: string }
  | { kind: "kill_merchant"; entityId: string; location: string }
  | { kind: "destroy_grain_storage"; location: string }
  | { kind: "hold_civic_rally"; location: string };

// ═══════════════════════════════════════════════════════════════════════════════
// §2 — ADAPTER STATE (thin layer between game and CE)
// ═══════════════════════════════════════════════════════════════════════════════

/** The adapter's own state. Deliberately minimal. */
export interface AdapterState {
  world: WorldState;
  engine: Engine;
  delivery: DeliveryState;
  consumerId: string;
}

/** Serialized form for persistence across process boundaries. */
export interface AdapterSnapshot {
  checkpoint: string;
  delivery: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// §3 — ADAPTER CREATION
// ═══════════════════════════════════════════════════════════════════════════════

const CONSUMER_ID = "game-adapter";

/** Create a fresh adapter with a new CE world. */
export function createAdapter(seed = 42): AdapterState {
  const engine = createEngine();
  const world = createWorld(makeConfig({ seed }), engine);
  const delivery = createDeliveryState();
  registerConsumer(delivery, CONSUMER_ID);
  return { world, engine, delivery, consumerId: CONSUMER_ID };
}

// ═══════════════════════════════════════════════════════════════════════════════
// §4 — INTERVENTION TRANSLATION (player intent → CE intervention)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Translate a player action into a CE intervention.
 *
 * CRITICAL: This function does NOT compute consequences. It only maps
 * player intent → CE intervention schema. All causal consequences
 * originate from CE's simulation, not from the adapter.
 */
export function translateIntent(
  adapter: AdapterState,
  action: PlayerAction,
): Intervention {
  const seq = adapter.world.interventionSeq + 1;
  const base: Intervention = {
    id: `game-${seq}`,
    tick: adapter.world.tick,
    actor: "player",
    action: "",
    target: { type: "region", id: "" },
    location: "",
    magnitude: 1.0,
    causalDomains: [],
    provenance: { submittedAtTick: adapter.world.tick, sequence: 0 },
  };

  switch (action.kind) {
    case "destroy_bridge":
      return {
        ...base,
        action: "destroy_infrastructure",
        target: { type: "infrastructure", id: "grain_road" },
        location: action.location,
      };
    case "kill_merchant":
      return {
        ...base,
        action: "kill_entity",
        target: { type: "entity", id: action.entityId },
        location: action.location,
      };
    case "destroy_grain_storage":
      return {
        ...base,
        action: "destroy_infrastructure",
        target: { type: "infrastructure", id: "grain_warehouse" },
        location: action.location,
      };
    case "hold_civic_rally":
      return {
        ...base,
        action: "hold_public_rally",
        target: { type: "region", id: action.location },
        location: action.location,
      };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §5 — SIMULATION LOOP (the game tick)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Execute a single game turn: receive player action → translate → submit → advance → consume → project.
 *
 * Returns the projected game view after the turn.
 */
export function gameTurn(
  adapter: AdapterState,
  action: PlayerAction,
  ticksPerTurn = 5,
): { view: GameView; submitResult: { ok: boolean; errors: string[] } } {
  // 1. Translate player intent → CE intervention
  const intervention = translateIntent(adapter, action);

  // 2. Submit to CE
  const submitResult = submitIntervention(adapter.world, intervention, adapter.engine);

  // 3. Advance CE simulation (even if intervention failed, advance to keep game loop moving)
  advance(adapter.world, adapter.engine, ticksPerTurn);
  enforceRetention(adapter.world, EVENT_RETENTION_LIMIT);

  // 4. Consume events and project to game state
  const view = consumeAndProject(adapter);

  return { view, submitResult };
}

/**
 * Advance the simulation without a player action (idle tick).
 */
export function idleTurn(adapter: AdapterState, ticks = 1): GameView {
  advance(adapter.world, adapter.engine, ticks);
  enforceRetention(adapter.world, EVENT_RETENTION_LIMIT);
  return consumeAndProject(adapter);
}

// ═══════════════════════════════════════════════════════════════════════════════
// §6 — EVENT CONSUMPTION (proper cursor management)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Poll, deduplicate, acknowledge, and project CE events into game events.
 * Uses the proper delivery contract (poll/ack), not factStream.
 */
export function consumeAndProject(adapter: AdapterState): GameView {
  const events: GameEvent[] = [];

  // Poll in a loop until caught up (handles multiple batches)
  for (let i = 0; i < 100; i++) {
    const result = poll(adapter.world, adapter.delivery, adapter.consumerId);

    if (result.status === "caught_up") break;
    if (result.status === "disconnected") break;
    if (result.status === "wrong_timeline") break;

    if (result.status === "gap") {
      // Handle retention gap: resync to current state
      const sync = stateSync(adapter.world);
      resync(adapter.delivery, adapter.consumerId, sync);
      break;
    }

    if (result.status === "deliverable") {
      // Process each delivery attempt
      for (const attempt of result.attempts) {
        // Deduplicate by event identity (at-least-once delivery)
        if (attempt.attempt > 1) continue; // Skip redeliveries

        const gameEvent = projectEvent(attempt.event);
        if (gameEvent) events.push(gameEvent);
      }

      // Acknowledge up to the highest streamSeq delivered
      const maxSeq = Math.max(...result.attempts.map((a) => a.streamSeq));
      ack(adapter.world, adapter.delivery, adapter.consumerId, maxSeq);
    }
  }

  // Project current CE state → game view
  return projectState(adapter, events);
}

/**
 * Project a single CE WorldEvent into a GameEvent.
 * Returns null for events the game doesn't care about.
 */
function projectEvent(event: WorldEvent): GameEvent | null {
  // Only project consumer-facing facts
  if (!isConsumerFact(event)) return null;

  // Map CE event types to game-facing descriptions
  const detail = formatEventDetail(event);

  return {
    id: event.id,
    type: event.type,
    region: event.regionId ?? undefined,
    detail,
    tick: event.tick,
  };
}

/**
 * Format event detail for game display.
 * This is pure presentation — no causal logic.
 */
function formatEventDetail(event: WorldEvent): string {
  const d = event.data as Record<string, unknown>;
  switch (event.type) {
    case "economy.price_change":
      return `Price ${d.resource ?? "unknown"}: ${d.oldValue ?? "?"} → ${d.newValue ?? "?"}`;
    case "ecology.stock_change":
      return `Stock ${d.resource ?? "unknown"}: ${d.delta ?? "?"}`;
    case "faction.hostility_shift":
      return `Faction hostility: ${d.delta ?? "?"}`;
    case "civic.unrest_shift":
      return `Unrest: ${d.delta ?? "?"}`;
    case "world.boundary_signal":
      return `Boundary signal from ${event.regionId ?? "?"}`;
    case "trade.route_blocked":
      return `Trade route blocked at ${event.regionId ?? "?"}`;
    case "trade.flow_disrupted":
      return `Trade flow disrupted at ${event.regionId ?? "?"}`;
    case "infrastructure.destroyed":
      return `Infrastructure destroyed: ${d.structureId ?? "?"}`;
    case "entity.removed":
      return `Entity removed: ${d.entityId ?? "?"} (${d.role ?? "?"})`;
    default:
      return `${event.type}`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §7 — STATE PROJECTION (CE state → game view)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Project CE state into a game-facing view.
 *
 * IMPORTANT: This is a PRESENTATION layer, not a simulation.
 * Every value here is derived from CE state, not computed independently.
 * The adapter does NOT maintain its own causal model.
 */
function projectState(adapter: AdapterState, recentEvents: GameEvent[]): GameView {
  const world = adapter.world;
  const towns: Record<string, GameTown> = {};
  const factions: Record<string, GameFaction> = {};

  // Project regions → towns
  for (const [id, region] of Object.entries(world.regions)) {
    const route = region.infrastructure["grain_road"];
    const warehouse = region.infrastructure["grain_warehouse"];

    towns[id] = {
      id,
      name: region.name,
      neighbors: region.neighbors,
      grainPrice: region.prices["grain"] ?? 0,
      grainStock: region.stocks["grain"] ?? 0,
      patrolDemand: region.patrolDemand,
      unrest: region.unrest,
      tradeInvestment: region.tradeInvestment,
      tradeRouteIntact: route ? route.health > 0 : false,
      warehouseIntact: warehouse ? warehouse.health > 0 : false,
    };
  }

  // Project entities → factions
  // Relations are stored in world.relations as "FACTION>target" keys
  // Initialize known factions from entity list
  const knownFactions = ["MG", "WA"];
  for (const factionId of knownFactions) {
    factions[factionId] = {
      id: factionId,
      name: factionId === "MG" ? "Merchant Guild" : factionId === "WA" ? "Wardens" : factionId,
      hostility: 0,
    };
  }
  for (const [key, value] of Object.entries(world.relations)) {
    const match = key.match(/^(\w+)>/);
    if (match) {
      const factionId = match[1];
      if (!factions[factionId]) {
        factions[factionId] = {
          id: factionId,
          name: factionId === "MG" ? "Merchant Guild" : factionId === "WA" ? "Wardens" : factionId,
          hostility: 0,
        };
      }
      factions[factionId].hostility = value;
    }
  }

  return {
    tick: world.tick,
    stateHash: stateHash(world),
    traceHash: traceHash(world),
    towns,
    factions,
    recentEvents,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// §8 — CHECKPOINT / RESTART (adapter persistence)
// ═══════════════════════════════════════════════════════════════════════════════

/** Save adapter state to a serializable snapshot. */
export function saveAdapter(adapter: AdapterState): AdapterSnapshot {
  const env = createCheckpoint(adapter.world, "save");
  return {
    checkpoint: serializeCheckpoint(env),
    delivery: serializeDelivery(adapter.delivery),
  };
}

/** Restore adapter state from a snapshot (simulates fresh process). */
export function restoreAdapter(snapshot: AdapterSnapshot): AdapterState {
  const env = deserializeCheckpoint(snapshot.checkpoint);
  if (!env.ok) throw new Error("Checkpoint deserialization failed");

  const validated = validateCheckpoint(env.value);
  if (!validated.ok) throw new Error("Checkpoint validation failed");

  const restored = restoreCheckpoint(validated.value);
  if (!restored.ok) throw new Error("Restore failed");

  const engine = createEngine();
  attachEngine(restored.value.world, engine);

  const delivery = deserializeDelivery(snapshot.delivery);
  registerConsumer(delivery, CONSUMER_ID);

  return {
    world: restored.value.world,
    engine,
    delivery,
    consumerId: CONSUMER_ID,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// §9 — DETERMINISTIC REPLAY (for verification)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run a complete game scenario from a seed and return all intermediate states.
 * Used for determinism verification.
 */
export function replayScenario(
  seed: number,
  actions: Array<{ action: PlayerAction; idleTicks?: number }>,
): {
  finalView: GameView;
  finalHash: string;
  finalTrace: string;
  views: GameView[];
} {
  const adapter = createAdapter(seed);
  const views: GameView[] = [];

  for (const { action, idleTicks } of actions) {
    const { view } = gameTurn(adapter, action, 5);
    views.push(view);

    if (idleTicks && idleTicks > 0) {
      const idleView = idleTurn(adapter, idleTicks);
      views.push(idleView);
    }
  }

  const finalView = consumeAndProject(adapter);
  return {
    finalView,
    finalHash: stateHash(adapter.world),
    finalTrace: traceHash(adapter.world),
    views,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// §10 — CAUSAL ATTRIBUTION (what the adapter can determine)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Attempt to answer "why did X change?" using only public API.
 *
 * Current capability: the adapter can observe that a change happened (via stateSync)
 * and can see the events that occurred (via factStream), but cannot trace the causal
 * chain back to a specific intervention without internal provenance access.
 *
 * This is a documented API friction finding — see §22.
 */
export function attributeChange(
  adapter: AdapterState,
  townId: string,
  field: "grainPrice" | "grainStock" | "patrolDemand" | "unrest",
): { changed: boolean; recentEvents: GameEvent[]; rootCauseKnown: boolean } {
  const sync = stateSync(adapter.world);
  const town = sync.regions[townId];
  if (!town) return { changed: false, recentEvents: [], rootCauseKnown: false };

  // Check if the field has changed from baseline
  const current = town[field];
  // Baseline is hard to determine without history — this is a friction finding
  // For now, we can only report what events occurred recently
  const recentFacts = factStream(adapter.world);
  const recent = recentFacts
    .filter((e) => e.regionId === townId || !e.regionId)
    .slice(-10)
    .map(projectEvent)
    .filter((e): e is GameEvent => e !== null);

  return {
    changed: true, // Cannot determine baseline without history
    recentEvents: recent,
    rootCauseKnown: false, // Cannot trace causal chain with public API alone
  };
}
