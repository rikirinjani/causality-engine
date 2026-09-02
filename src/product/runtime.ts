/**
 * CE v1.0 — Runtime bundle (product boundary).
 *
 * A `CausalRuntime` is the one object a game holds. It bundles the four things
 * that must travel together: the world, its engine, the delivery state, and the
 * consumer identity.
 *
 * DeliveryState is deliberately a SIBLING of WorldState, never a member of it —
 * a consumer disconnecting must not be able to touch simulation state. That
 * separation is a frozen invariant; this bundle preserves it by holding both
 * rather than merging them.
 *
 * This module contains no causal logic. It calls the engine; it never simulates.
 */
import {
  advance,
  attachEngine,
  createEngine,
  createWorld,
  type Engine,
} from "../core/world.js";
import { createDeliveryState, registerConsumer, type DeliveryState } from "../core/delivery.js";
import { stateHash, traceHash } from "../core/hash.js";
import { submitIntervention } from "../core/world.js";
import type { Intervention, WorldState } from "../core/types.js";
import type { SimConfig } from "../core/config.js";
import { createConfig } from "./config.js";

/** Everything a game needs to run a causal world. Hold one of these per timeline. */
export interface CausalRuntime {
  world: WorldState;
  engine: Engine;
  delivery: DeliveryState;
  consumerId: string;
}

export interface CreateGameOptions {
  /** Deterministic seed. Same seed + same interventions => same world. Default 42. */
  seed?: number;
  /** Config overrides, validated before use. Throws `ConfigError` when invalid. */
  config?: Partial<SimConfig>;
  /** Identity of this consumer's event channel. Default "game". */
  consumerId?: string;
  /** Timeline label for the genesis world. Default "genesis". */
  label?: string;
}

/**
 * Create a fresh causal world and everything needed to run it.
 *
 * Validation happens here, at the product boundary, so an invalid causal
 * configuration fails before a single tick is simulated.
 */
export function createGame(opts: CreateGameOptions = {}): CausalRuntime {
  const consumerId = opts.consumerId ?? "game";
  const seed = opts.seed ?? 42;
  const config = createConfig({ ...(opts.config ?? {}), seed });

  const engine = createEngine();
  const world = createWorld(config, engine, opts.label ?? "genesis");
  const delivery = createDeliveryState();
  registerConsumer(delivery, consumerId);

  return { world, engine, delivery, consumerId };
}

export interface ApplyResult {
  ok: boolean;
  errors: string[];
  /** The world's intervention sequence AFTER the attempt. Useful for correlating. */
  interventionSeq: number;
}

/**
 * Submit an already-built intervention.
 *
 * Acceptance/rejection is entirely the engine's decision — this is a pass-through
 * that only reshapes the result. Rejections (e.g. destroying an already-destroyed
 * bridge) surface as `ok: false` with the engine's own errors.
 */
export function apply(rt: CausalRuntime, intervention: Intervention): ApplyResult {
  const result = submitIntervention(rt.world, intervention, rt.engine);
  return {
    ok: result.ok,
    errors: result.errors,
    interventionSeq: rt.world.interventionSeq,
  };
}

export interface StepResult {
  /** World tick after advancing. */
  tick: number;
  /** How many ticks the engine actually advanced. */
  ticksAdvanced: number;
  /** Physical world identity (excludes causal history). */
  stateHash: string;
  /** Causal history identity (includes provenance/interventions). */
  traceHash: string;
}

/**
 * Advance causal time.
 *
 * CE never ticks on its own — the game decides when time passes. A game may call
 * this once per frame, many times per frame, or not at all; CE imposes no clock.
 */
export function step(rt: CausalRuntime, ticks = 1): StepResult {
  const ticksAdvanced = advance(rt.world, rt.engine, ticks);
  return {
    tick: rt.world.tick,
    ticksAdvanced,
    stateHash: stateHash(rt.world),
    traceHash: traceHash(rt.world),
  };
}

/**
 * Bundle an already-restored world into a runtime.
 *
 * Used by the save/timeline modules. `attach` controls whether a fresh engine is
 * attached: `forkTimeline`/`rewindTo` already attach one, `restoreCheckpoint` does not.
 */
export function bundleRuntime(
  world: WorldState,
  consumerId: string,
  engine?: Engine,
): CausalRuntime {
  const resolvedEngine = engine ?? attachEngine(world, createEngine());
  const delivery = createDeliveryState();
  registerConsumer(delivery, consumerId);
  return { world, engine: resolvedEngine, delivery, consumerId };
}

export type { Engine, DeliveryState };
