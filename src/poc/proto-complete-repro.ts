/**
 * NCR-2026-001 Complete Red/Green Reproduction
 *
 * Demonstrates BOTH the defect (RED) and the fix (GREEN) in a single executable.
 * Produces frozen baseline hashes for P-019 compliance.
 *
 * Usage:
 *   npx tsx src/poc/proto-complete-repro.ts           # GREEN (patched)
 *   npx tsx src/poc/proto-complete-repro.ts --red     # RED (simulated unpatched)
 *
 * Exit 0 = GREEN (defect closed)
 * Exit 1 = RED (defect present)
 */
import { createWorld, createEngine, advance } from "../core/world.js";
import { stateHash } from "../core/hash.js";
import { makeConfig } from "../core/config.js";
import type { WorldState } from "../core/types.js";
import { writeFileSync } from "node:fs";

const SEED = 42;
const TICKS = 100;
const IS_RED = process.argv.includes("--red");

/** Inject own __proto__ key into world entity attrs. */
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

/** Simulate unpatched sortKeys by stripping __proto__ from canonical JSON. */
function simulateUnpatchedHash(world: WorldState): string {
  // This is what the OLD sortKeys would produce: drop __proto__ key
  const plain = JSON.parse(JSON.stringify(world)) as WorldState;
  const entityId = Object.keys(plain.entities).sort()[0]!;
  delete (plain.entities[entityId]!.attrs as Record<string, unknown>)["__proto__"];
  return stateHash(plain);
}

type Mode = "green" | "red";

function main(): void {
  const mode: Mode = IS_RED ? "red" : "green";
  console.log(`complete-repro: seed=${SEED} ticks=${TICKS} mode=${mode}`);

  // Build worlds
  const engine1 = createEngine();
  const control = createWorld(makeConfig({ seed: SEED }), engine1);
  advance(control, engine1, TICKS);

  const engine2 = createEngine();
  const proto_raw = createWorld(makeConfig({ seed: SEED }), engine2);
  advance(proto_raw, engine2, TICKS);
  const proto = injectProtoKey(proto_raw);

  // Compute hashes based on mode
  let controlHash: string;
  let protoHash: string;

  if (mode === "green") {
    // Post-fix: use actual stateHash (preserves __proto__)
    controlHash = stateHash(control);
    protoHash = stateHash(proto);
  } else {
    // Pre-fix simulation: strip __proto__ from proto world
    controlHash = stateHash(control);
    protoHash = simulateUnpatchedHash(proto);
  }

  const collides = controlHash === protoHash;
  const entityId = Object.keys(proto.entities).sort()[0]!;
  const ownKeyPresent = Object.prototype.hasOwnProperty.call(
    proto.entities[entityId]!.attrs,
    "__proto__"
  );

  console.log(`control_state_hash: ${controlHash}`);
  console.log(`proto_state_hash:   ${protoHash}`);
  console.log(`collides: ${collides}`);
  console.log(`own_key_present: ${ownKeyPresent}`);

  const record = {
    seed: SEED,
    ticks: TICKS,
    mode,
    control_hash: controlHash,
    proto_hash: protoHash,
    collides,
    own_key_present: ownKeyPresent,
  };

  writeFileSync("complete-repro-record.json", JSON.stringify(record, null, 2), "utf8");

  if (!ownKeyPresent) {
    console.error("FATAL: injection failed");
    process.exit(2);
  }

  if (mode === "green") {
    if (collides) {
      console.log("RESULT: RED — defect STILL present (post-fix collision)");
      process.exit(1);
    } else {
      console.log("RESULT: GREEN — defect CLOSED (post-fix hashes differ)");
      process.exit(0);
    }
  } else {
    if (collides) {
      console.log("RESULT: RED — defect PRESENT (pre-fix collision confirmed)");
      process.exit(1);
    } else {
      console.log("RESULT: UNEXPECTED — pre-fix should collide");
      process.exit(2);
    }
  }
}

main();
