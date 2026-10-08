/**
 * NCR-2026-001 Reproducible Reproducer — Fresh-Process State Comparison
 *
 * This script demonstrates the `__proto__` hashing defect independently:
 * 1. Builds two worlds that differ ONLY by an own `__proto__` data key
 * 2. Shows stateHash collision BEFORE fix (or confirms no collision AFTER fix)
 * 3. Runs in a fresh process to avoid any in-memory state contamination
 *
 * Usage: npx tsx src/poc/proto-reproducer.ts [seed]
 *
 * Exit 0 = defect closed (hashes differ as expected)
 * Exit 1 = defect still present (hashes collide — FIX REQUIRED)
 */
import { createWorld, createEngine, advance } from "../core/world.js";
import { stateHash } from "../core/hash.js";
import { makeConfig } from "../core/config.js";
import type { WorldState } from "../core/types.js";

const SEED = parseInt(process.argv[2] ?? "42", 10);
const TICKS = 100;

/** Inject an own `__proto__` data key via raw JSON.parse (the persistence.ts:458 attack surface). */
function injectProtoKey(world: WorldState): WorldState {
  // Deep clone via JSON round-trip
  const proto = JSON.parse(JSON.stringify(world)) as WorldState;
  // Find first entity and inject __proto__ into its attrs
  const entityId = Object.keys(proto.entities).sort()[0]!;
  const originalAttrs = proto.entities[entityId]!.attrs;
  proto.entities[entityId]!.attrs = JSON.parse(
    JSON.stringify(originalAttrs).replace(
      "{",
      '{"__proto__":"reproducer-injected","'
    )
  ) as Record<string, number | string | boolean>;
  return proto;
}

function main(): void {
  console.log(`reproducer: seed=${SEED} ticks=${TICKS}`);
  console.log("building control world...");
  const engine1 = createEngine();
  const control = createWorld(makeConfig({ seed: SEED }), engine1);
  advance(control, engine1, TICKS);

  console.log("building proto world (inject __proto__ key)...");
  const engine2 = createEngine();
  const proto = createWorld(makeConfig({ seed: SEED }), engine2);
  advance(proto, engine2, TICKS);
  const protoWithKey = injectProtoKey(proto);

  const controlHash = stateHash(control);
  const protoHash = stateHash(protoWithKey);
  const collides = controlHash === protoHash;

  console.log(`control_state_hash: ${controlHash}`);
  console.log(`proto_state_hash:   ${protoHash}`);
  console.log(`collides: ${collides}`);

  // Verify the injection is real
  const firstEntityId = Object.keys(protoWithKey.entities).sort()[0]!;
  const hasOwnProto = Object.prototype.hasOwnProperty.call(
    protoWithKey.entities[firstEntityId]!.attrs,
    "__proto__"
  );
  console.log(`ownKeyInjected: ${hasOwnProto}`);

  if (!hasOwnProto) {
    console.error("FATAL: injection failed — __proto__ key not found");
    process.exit(2);
  }

  if (collides) {
    console.log("RESULT: DEFECT PRESENT — worlds with different __proto__ keys hash identically");
    console.log("ACTION: fix sortKeys in src/core/hash.ts to use Object.defineProperty for __proto__");
    process.exit(1);
  } else {
    console.log("RESULT: DEFECT CLOSED — worlds with different __proto__ keys produce distinct hashes");
    process.exit(0);
  }
}

main();
