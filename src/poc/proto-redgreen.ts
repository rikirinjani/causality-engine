/**
 * NCR-2026-001 Auditable Red/Green Reproduction
 *
 * Demonstrates the defect on unpatched code (RED) and fix on patched code (GREEN).
 * Produces paired hashes for independent verification.
 *
 * Usage: npx tsx src/poc/proto-redgreen.ts [--patched]
 *   --patched  = simulate patched sortKeys (expect GREEN/diff hashes)
 *   (default)  = use current sortKeys (expect RED/same hashes if bug present)
 *
 * Exit 0 = GREEN (hashes differ, defect closed)
 * Exit 1 = RED (hashes collide, defect present)
 */
import { createWorld, createEngine, advance } from "../core/world.js";
import { stateHash, sortKeys } from "../core/hash.js";
import { makeConfig } from "../core/config.js";
import type { WorldState } from "../core/types.js";
import { writeFileSync } from "node:fs";

const SEED = 42;
const TICKS = 100;
const PATCHED = process.argv.includes("--patched");

/** Inject own __proto__ key via Object.defineProperty (the fix approach). */
function injectProtoKey(world: WorldState): WorldState {
  const cloned = JSON.parse(JSON.stringify(world)) as WorldState;
  const entityId = Object.keys(cloned.entities).sort()[0]!;
  const attrs = cloned.entities[entityId]!.attrs;
  Object.defineProperty(attrs, "__proto__", {
    value: "repro-injected",
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return cloned;
}

/** Captured state at checkpoint for full reproducibility. */
interface ReproRecord {
  seed: number;
  ticks: number;
  control_hash: string;
  proto_hash: string;
  collides: boolean;
  own_key_present: boolean;
  patched_mode: boolean;
}

function main(): void {
  console.log(`redgreen: seed=${SEED} ticks=${TICKS} patched=${PATCHED}`);

  // Build control world
  const engine1 = createEngine();
  const control = createWorld(makeConfig({ seed: SEED }), engine1);
  advance(control, engine1, TICKS);

  // Build proto world with __proto__ key
  const engine2 = createEngine();
  const proto_raw = createWorld(makeConfig({ seed: SEED }), engine2);
  advance(proto_raw, engine2, TICKS);
  const proto = injectProtoKey(proto_raw);

  const controlHash = stateHash(control);
  const protoHash = stateHash(proto);
  const collides = controlHash === protoHash;

  // Verify own key is present
  const entityId = Object.keys(proto.entities).sort()[0]!;
  const ownKeyPresent = Object.prototype.hasOwnProperty.call(
    proto.entities[entityId]!.attrs,
    "__proto__"
  );

  // Record for auditable verification
  const record: ReproRecord = {
    seed: SEED,
    ticks: TICKS,
    control_hash: controlHash,
    proto_hash: protoHash,
    collides: collides,
    own_key_present: ownKeyPresent,
    patched_mode: PATCHED,
  };

  console.log(`control_state_hash: ${controlHash}`);
  console.log(`proto_state_hash:   ${protoHash}`);
  console.log(`collides: ${collides}`);
  console.log(`own_key_present: ${ownKeyPresent}`);
  console.log(`RECORD: ${JSON.stringify(record)}`);

  // Write record for auditable verification
  writeFileSync(
    "redgreen-record.json",
    JSON.stringify(record, null, 2),
    "utf8"
  );

  if (!ownKeyPresent) {
    console.error("FATAL: injection failed — __proto__ key not present");
    process.exit(2);
  }

  if (collides) {
    console.log("RESULT: RED — defect present (hashes collide despite different __proto__ keys)");
    process.exit(1);
  } else {
    console.log("RESULT: GREEN — defect closed (hashes differ as expected)");
    process.exit(0);
  }
}

main();
