/**
 * Browser adapter over the real CE product API.
 *
 * Everything this module returns comes from the actual engine — the same code
 * that ships in the npm tarball and passes CI. Nothing here is scripted, mocked,
 * or replayed from a recording. When the demo shows grain at 13.13 and a state
 * hash starting 5404d32e, CE computed both in the visitor's browser.
 *
 * This is a thin translation layer: it reshapes CE's product API into a form a
 * UI can drive, and adds nothing causal. No rule, no RNG, no derived world
 * value. Same boundary the Godot adapter respects.
 */
import {
  createGame,
  intervene,
  step,
  inspect,
  why,
  quantity,
  saveGame,
  loadGame,
  forkGame,
  compareTimelines,
  timelineOf,
  listActions,
  openEventStream,
  type CausalRuntime,
  type EventStream,
  type WorldEvent,
} from "causality-engine/product";

// ── Public shapes the UI consumes ─────────────────────────────────────────

export interface StructureView {
  type: string;
  health: number;
  intact: boolean;
}

export interface RegionView {
  id: string;
  name: string;
  prices: Record<string, number>;
  stocks: Record<string, number>;
  infrastructure: Record<string, StructureView>;
  unrest: number;
  patrolDemand: number;
  tradeInvestment: number;
}

export interface WorldView {
  tick: number;
  timelineId: string;
  stateHash: string;
  traceHash: string;
  regions: Record<string, RegionView>;
  relations: Record<string, number>;
  eventCount: number;
}

export interface DeliveredEventView {
  type: string;
  tick: number;
  streamSeq: number;
  regionId?: string;
}

export interface RootActionView {
  interventionId: string;
  action: string;
  location: string;
  targetId: string;
  tick: number;
}

export interface CauseView {
  quantity: string;
  explained: boolean;
  incomplete: boolean;
  rootActions: RootActionView[];
  chains: string[][];
}

export interface SaveView {
  data: string;
  tick: number;
  stateHash: string;
  checkpointId: string;
}

export interface ComparisonView {
  distinct: boolean;
  stateHashEqual: boolean;
  traceHashEqual: boolean;
  differences: Array<{ path: string; a: unknown; b: unknown }>;
}

export interface ActionView {
  action: string;
  allowedTargets: readonly string[];
  summary: string;
  locationMustEqualTarget: boolean;
}

export type TargetKind = "infrastructure" | "entity" | "region";

/** Quantity-key builders, mirroring CE's own helpers. */
export interface QuantityBuilders {
  price(region: string, resource: string): string;
  stock(region: string, resource: string): string;
  hostility(faction: string): string;
  unrest(region: string): string;
  infra(region: string, structureId: string): string;
}

export interface CeDemo {
  /** Discard the world and start a fresh one. */
  reset(seed?: number): WorldView;
  /** Submit a player action. CE decides whether to accept it. */
  act(
    action: string,
    targetId: string,
    targetType: TargetKind,
    location: string,
  ): { ok: boolean; errors: string[] };
  /** Advance causal time. CE never ticks on its own. */
  advance(ticks: number): WorldView;
  /** Current projection of the world. */
  view(): WorldView;
  /** Events since the last drain, in CE's canonical order, acknowledged. */
  drainEvents(): DeliveredEventView[];
  /** Ask CE why a quantity holds its current value. */
  why(quantityKey: string): CauseView;
  /** Quantity-key builders. */
  quantity: QuantityBuilders;
  /** Capture a save point. The payload is opaque. */
  save(): SaveView;
  /** Restore this demo from a save payload. */
  load(data: string): { ok: boolean; errors: string[] };
  /** Fork an independent timeline. Returns a separate demo; this one is untouched. */
  fork(data: string, label: string): { ok: boolean; demo?: CeDemo; errors: string[] };
  /** Compare this world against another. */
  compare(other: CeDemo): ComparisonView;
  /** Actions CE accepts, for building a UI. */
  actions(): ActionView[];
  /** Lineage of the timeline this demo is on. */
  timeline(): { timelineId: string; origin: string; generation: number };
  /**
   * Live runtime handle. Present so `compare()` can reach a second instance's
   * runtime; not part of the surface a UI should use.
   * @internal
   */
  __runtime(): CausalRuntime;
}

// ── Implementation ────────────────────────────────────────────────────────

const CONSUMER_ID = "web-demo";

function toWorldView(runtime: CausalRuntime): WorldView {
  const view = inspect(runtime);
  const regions: Record<string, RegionView> = {};

  for (const id of Object.keys(view.regions)) {
    const region = view.regions[id];
    if (region === undefined) continue;

    const infrastructure: Record<string, StructureView> = {};
    for (const structureId of Object.keys(region.infrastructure)) {
      const structure = region.infrastructure[structureId];
      if (structure === undefined) continue;
      infrastructure[structureId] = {
        type: structure.type,
        health: structure.health,
        intact: structure.intact,
      };
    }

    regions[id] = {
      id: region.id,
      name: region.name,
      prices: { ...region.prices },
      stocks: { ...region.stocks },
      infrastructure,
      unrest: region.unrest,
      patrolDemand: region.patrolDemand,
      tradeInvestment: region.tradeInvestment,
    };
  }

  return {
    tick: view.tick,
    timelineId: view.timelineId,
    stateHash: view.stateHash,
    traceHash: view.traceHash,
    regions,
    relations: { ...view.relations },
    eventCount: view.eventCount,
  };
}

function toEventView(event: WorldEvent, streamSeq: number): DeliveredEventView {
  const out: DeliveredEventView = {
    type: event.type,
    tick: event.tick,
    streamSeq,
  };
  if (event.regionId !== undefined) out.regionId = event.regionId;
  return out;
}

/**
 * Deterministic intervention id.
 *
 * Derived from tick, action and CE's own intervention sequence — no counter, no
 * wall clock — so the same interaction always produces the same id and therefore
 * the same trace hash. CE's own builder applies this scheme; recorded here
 * because the demo surfaces ids in the causal chain.
 */
function buildDemo(initial: CausalRuntime): CeDemo {
  let runtime = initial;
  let stream: EventStream = openEventStream(runtime);

  const rebind = (next: CausalRuntime): void => {
    runtime = next;
    stream = openEventStream(runtime);
  };

  const demo: CeDemo = {
    reset(seed = 42): WorldView {
      rebind(createGame({ seed, consumerId: CONSUMER_ID }));
      return toWorldView(runtime);
    },

    act(action, targetId, targetType, location) {
      // No causalDomains passed — CE's action schemas author all causal
      // pressure. The adapter never invents any.
      const result = intervene(runtime, {
        action,
        target: { type: targetType, id: targetId },
        location,
        actor: "player",
      });
      return { ok: result.ok, errors: [...result.errors] };
    },

    advance(ticks) {
      step(runtime, ticks);
      return toWorldView(runtime);
    },

    view() {
      return toWorldView(runtime);
    },

    drainEvents() {
      const delivered: DeliveredEventView[] = [];
      // drain() hands events over in CE's canonical order, then acknowledges.
      // At-least-once redelivery stays visible through streamSeq.
      stream.drain((event, meta) => {
        delivered.push(toEventView(event, meta.streamSeq));
      });
      return delivered;
    },

    why(quantityKey) {
      const cause = why(runtime, quantityKey);
      return {
        quantity: cause.quantity,
        explained: cause.explained,
        incomplete: cause.incomplete,
        rootActions: cause.rootActions.map((root) => ({
          interventionId: root.interventionId,
          action: root.action,
          location: root.location,
          targetId: root.targetId,
          tick: root.tick,
        })),
        chains: cause.chains.map((chain) => [...chain]),
      };
    },

    quantity: {
      price: (region, resource) => quantity.price(region, resource),
      stock: (region, resource) => quantity.stock(region, resource),
      hostility: (faction) => quantity.hostility(faction),
      unrest: (region) => quantity.unrest(region),
      infra: (region, structureId) => quantity.infra(region, structureId),
    },

    save() {
      const result = saveGame(runtime, "web-demo");
      return {
        data: result.data,
        tick: result.tick,
        stateHash: result.stateHash,
        checkpointId: result.checkpointId,
      };
    },

    load(data) {
      const result = loadGame(data, { consumerId: CONSUMER_ID });
      if (!result.ok) return { ok: false, errors: [...result.errors] };
      rebind(result.runtime);
      return { ok: true, errors: [] };
    },

    fork(data, label) {
      const result = forkGame(data, label, { consumerId: CONSUMER_ID });
      if (!result.ok) return { ok: false, errors: [...result.errors] };
      // A fork is an independent timeline. This demo instance is unaffected.
      return { ok: true, demo: buildDemo(result.runtime), errors: [] };
    },

    compare(other) {
      const comparison = compareTimelines(runtime, other.__runtime());
      return {
        distinct: comparison.distinct,
        stateHashEqual: comparison.stateHashEqual,
        traceHashEqual: comparison.traceHashEqual,
        differences: comparison.differences.map((d) => ({ path: d.path, a: d.a, b: d.b })),
      };
    },

    actions() {
      return listActions().map((action) => ({
        action: action.action,
        allowedTargets: [...action.allowedTargets],
        summary: action.summary,
        locationMustEqualTarget: action.locationMustEqualTarget,
      }));
    },

    timeline() {
      const summary = timelineOf(runtime);
      return {
        timelineId: summary.timelineId,
        origin: summary.origin,
        generation: summary.generation,
      };
    },

    __runtime(): CausalRuntime {
      return runtime;
    },
  };

  return demo;
}

/**
 * Create a demo instance.
 *
 * Async by contract so the loader can show a pending state and so a future
 * WASM-backed build needs no call-site change. The current implementation is
 * synchronous under the hood.
 */
export async function createDemo(seed = 42): Promise<CeDemo> {
  return buildDemo(createGame({ seed, consumerId: CONSUMER_ID }));
}

/** Region id used throughout the demo scenario. */
export const DEMO_REGION = "RF";

/** Structures the demo scenario exposes as targets. */
export const DEMO_STRUCTURES = {
  road: "grain_road",
  warehouse: "grain_warehouse",
} as const;

/**
 * The faction whose hostility CE actually tracks in this scenario.
 *
 * CE's relation key is `MG>player` — hostility of the Merchant Guild toward the
 * player, not toward a region. An earlier version of this adapter looked for a
 * key ending in `>RF`, matched nothing, and displayed a permanent 0.00. Reading
 * the relation by its real key is the fix.
 */
export const DEMO_HOSTILITY_KEY = "MG>player";

/** Faction that CE tracks hostility for. */
export const DEMO_FACTION = "MG";

/**
 * Scenario constants CE derives its economy from, restated here so the UI can
 * label a value as clamped without recomputing anything causal.
 *
 * From the engine: grain `basePrice` is 10 (game/content.ts) and
 * `priceClampMax` is 4.0 (core/config.ts), so the price ceiling is 40.00. The
 * demo uses this only to annotate the display.
 */
export const DEMO_GRAIN_BASE_PRICE = 10;
export const DEMO_PRICE_CLAMP_MAX = 4.0;
export const DEMO_GRAIN_PRICE_CEILING = DEMO_GRAIN_BASE_PRICE * DEMO_PRICE_CLAMP_MAX;
