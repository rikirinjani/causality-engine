/**
 * Persistence equivalence test (Astra v3 top fix #1).
 *
 * Compares uninterrupted execution against checkpoint → fresh-process reload → resume.
 * Verifies stateHash and traceHash equality at defined comparison points under the
 * documented retention contract.
 *
 * Uses CE's official checkpoint API: createCheckpoint, serializeCheckpoint,
 * deserializeCheckpoint, restoreCheckpoint, attachEngine.
 *
 * Run from repo root:
 *   npx vitest run src/poc/persistence-equivalence.test.ts
 */
import { describe, expect, it } from "vitest";
import { createWorld, createEngine, advance, attachEngine } from "../core/world.js";
import { stateHash, traceHash } from "../core/hash.js";
import { makeConfig } from "../core/config.js";
import { WORLD_SEED } from "../game/content.js";
import {
  createCheckpoint,
  serializeCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
} from "../core/persistence.js";
import type { WorldState } from "../core/types.js";

const TICKS_BEFORE = 200;
const TICKS_AFTER = 300;
const SEEDS = [WORLD_SEED, 12345, 99999] as const;

describe("persistence-equivalence", () => {
  for (const seed of SEEDS) {
    it(`uninterrupted vs checkpoint-reload-seq match (seed=${seed})`, () => {
      // --- uninterrupted path: run all ticks at once ---
      const engineA = createEngine();
      const worldA = createWorld(makeConfig({ seed }), engineA);
      advance(worldA, engineA, TICKS_BEFORE + TICKS_AFTER);
      const hashUninterrupted = stateHash(worldA);
      const traceUninterrupted = traceHash(worldA);

      // --- checkpoint path: save at TICKS_BEFORE, reload, continue ---
      const engineB = createEngine();
      const worldB = createWorld(makeConfig({ seed }), engineB);
      advance(worldB, engineB, TICKS_BEFORE);

      // Create and serialize checkpoint
      const env = createCheckpoint(worldB, "test");
      const serialized = serializeCheckpoint(env);

      // Deserialize and restore (simulates fresh-process reload)
      const result = deserializeCheckpoint(serialized);
      expect(result.ok, "checkpoint must deserialize").toBe(true);
      if (!result.ok) throw new Error("deserialize failed");

      const restoreResult = restoreCheckpoint(result.value);
      expect(restoreResult.ok, "checkpoint must restore").toBe(true);
      if (!restoreResult.ok) throw new Error("restore failed");

      const { world: worldC } = restoreResult.value;
      const engineC = createEngine();
      // Rebind engine: restores RNG from world.rngState, rebuilds bus/accepted
      attachEngine(worldC, engineC);
      advance(worldC, engineC, TICKS_AFTER);
      const hashContinued = stateHash(worldC);
      const traceContinued = traceHash(worldC);

      // Verify: both paths reach same state after total ticks
      expect(hashUninterrupted).toBe(hashContinued);
      expect(traceUninterrupted).toBe(traceContinued);
    });

    it(`deterministic replay: two runs with same seed produce identical hashes (seed=${seed})`, () => {
      const engine1 = createEngine();
      const world1 = createWorld(makeConfig({ seed }), engine1);
      advance(world1, engine1, TICKS_BEFORE + TICKS_AFTER);

      const engine2 = createEngine();
      const world2 = createWorld(makeConfig({ seed }), engine2);
      advance(world2, engine2, TICKS_BEFORE + TICKS_AFTER);

      expect(stateHash(world1)).toBe(stateHash(world2));
      expect(traceHash(world1)).toBe(traceHash(world2));
    });

    it(`checkpoint identity matches world hashes (seed=${seed})`, () => {
      const engine = createEngine();
      const world = createWorld(makeConfig({ seed }), engine);
      advance(world, engine, TICKS_BEFORE);

      const env = createCheckpoint(world, "test");
      expect(env.identity.stateHash).toBe(stateHash(world));
      expect(env.identity.traceHash).toBe(traceHash(world));
      expect(env.identity.tick).toBe(TICKS_BEFORE);
    });
  }
});
