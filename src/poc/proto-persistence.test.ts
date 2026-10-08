/**
 * Persistence Equivalence Test for __proto__ World
 *
 * Verifies that a world containing an own __proto__ data key survives
 * checkpoint → fresh-process reload → resume with identical stateHash.
 *
 * This closes the Astra v5 gap: "fresh-process persistence equivalence
 * for a world containing __proto__".
 *
 * Run: npx tsx src/poc/proto-persistence.test.ts
 */
import { describe, expect, it } from "vitest";
import { createWorld, createEngine, advance, attachEngine } from "../core/world.js";
import { stateHash, traceHash } from "../core/hash.js";
import { makeConfig } from "../core/config.js";
import {
  createCheckpoint,
  serializeCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
} from "../core/persistence.js";
import type { WorldState } from "../core/types.js";

const SEEDS = [42, 12345, 99999] as const;
const TICKS_BEFORE = 100;
const TICKS_AFTER = 100;

/** Inject own __proto__ key into first entity's attrs. */
function injectProtoKey(world: WorldState): WorldState {
  const cloned = JSON.parse(JSON.stringify(world)) as WorldState;
  const entityId = Object.keys(cloned.entities).sort()[0]!;
  const attrs = cloned.entities[entityId]!.attrs;
  Object.defineProperty(attrs, "__proto__", {
    value: "persistence-test-injected",
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return cloned;
}

describe("persistence-equivalence-proto-world", () => {
  for (const seed of SEEDS) {
    it(`uninterrupted vs checkpoint-reload matches for __proto__ world (seed=${seed})`, () => {
      // --- Path A: uninterrupted ---
      const engineA = createEngine();
      const worldA = createWorld(makeConfig({ seed }), engineA);
      advance(worldA, engineA, TICKS_BEFORE + TICKS_AFTER);

      // Inject __proto__ after full run
      const worldA_with_proto = injectProtoKey(worldA);
      const hashUninterrupted = stateHash(worldA_with_proto);
      const traceUninterrupted = traceHash(worldA_with_proto);

      // --- Path B: checkpoint before injection, reload, inject, continue ---
      const engineB = createEngine();
      const worldB = createWorld(makeConfig({ seed }), engineB);
      advance(worldB, engineB, TICKS_BEFORE);

      // Checkpoint at TICKS_BEFORE
      const env = createCheckpoint(worldB, "proto-test");
      const serialized = serializeCheckpoint(env);

      // Deserialize and restore (fresh-process simulation)
      const result = deserializeCheckpoint(serialized);
      expect(result.ok).toBe(true);
      const restoreResult = restoreCheckpoint(result.value);
      expect(restoreResult.ok).toBe(true);

      const { world: worldC } = restoreResult.value;
      const engineC = createEngine();
      attachEngine(worldC, engineC);

      // Continue to TICKS_BEFORE + TICKS_AFTER
      advance(worldC, engineC, TICKS_AFTER);

      // Now inject __proto__ into the continued world
      const worldC_with_proto = injectProtoKey(worldC);
      const hashContinued = stateHash(worldC_with_proto);
      const traceContinued = traceHash(worldC_with_proto);

      // Verify: both paths reach identical state after injection
      expect(hashUninterrupted).toBe(hashContinued);
      expect(traceUninterrupted).toBe(traceContinued);
    });

    it(`checkpoint identity preserved after __proto__ injection (seed=${seed})`, () => {
      const engine = createEngine();
      const world = createWorld(makeConfig({ seed }), engine);
      advance(world, engine, TICKS_BEFORE);

      // Inject __proto__ BEFORE checkpoint
      const worldWithProto = injectProtoKey(world);

      const env = createCheckpoint(worldWithProto, "proto-test");
      const serialized = serializeCheckpoint(env);

      // Verify checkpoint identity includes the __proto__ key
      const result = deserializeCheckpoint(serialized);
      expect(result.ok).toBe(true);
      const restoreResult = restoreCheckpoint(result.value);
      expect(restoreResult.ok).toBe(true);

      const { world: restored } = restoreResult.value;
      const entityId = Object.keys(restored.entities).sort()[0]!;
      const hasOwnKey = Object.prototype.hasOwnProperty.call(
        restored.entities[entityId]!.attrs,
        "__proto__"
      );
      expect(hasOwnKey).toBe(true);
      expect(stateHash(restored)).toBe(env.identity.stateHash);
    });
  }
});
