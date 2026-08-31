/**
 * P-011: Headless CE Runtime
 *
 * A minimal, standalone simulation process that demonstrates CE can exist
 * independently of Vitest and the development test harness.
 *
 * Usage:
 *   npx tsx src/poc/headless.ts                    # Interactive mode
 *   npx tsx src/poc/headless.ts --ticks 100        # Run N ticks
 *   npx tsx src/poc/headless.ts --checkpoint       # Checkpoint after run
 *   npx tsx src/poc/headless.ts --restore <file>   # Restore from checkpoint
 *   npx tsx src/poc/headless.ts --json             # JSON output mode
 *
 * This is NOT the public network API. It's a proof that CE can run as
 * an independent headless simulation process.
 */
import { performance } from "node:perf_hooks";
import * as fs from "node:fs";
import * as readline from "node:readline";
import {
  createEngine, createWorld, submitIntervention, advance, snapshot,
  stateHash, traceHash, factStream, stream,
  createCheckpoint, serializeCheckpoint, deserializeCheckpoint,
  validateCheckpoint, restoreCheckpoint,
  makeConfig, attachEngine,
  type Engine, type WorldState, type Intervention,
} from "../api/public.js";

// ── CLI arguments ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {
  ticks: parseInt(args.find((_, i, a) => a[i - 1] === "--ticks") || "0", 10),
  checkpoint: args.includes("--checkpoint"),
  restore: args.find((_, i, a) => a[i - 1] === "--restore") || "",
  json: args.includes("--json"),
  help: args.includes("--help"),
};

if (flags.help) {
  console.log(`
Headless CE Runtime — P-011

Usage:
  npx tsx src/poc/headless.ts [options]

Options:
  --ticks N       Run N ticks automatically (default: interactive)
  --checkpoint    Write checkpoint to headless-checkpoint.json after run
  --restore FILE  Restore from checkpoint file
  --json          Output state as JSON (one per line)
  --help          Show this help

Interactive commands:
  tick            Advance one tick
  tick N          Advance N ticks
  submit ACTION   Submit intervention (interactive)
  state           Print current state summary
  events          Print event stream
  hash            Print state/trace hashes
  checkpoint      Write checkpoint to headless-checkpoint.json
  quit            Exit
`);
  process.exit(0);
}

// ── Initialize ─────────────────────────────────────────────────────────────
let engine: Engine;
let world: WorldState;

if (flags.restore) {
  const data = fs.readFileSync(flags.restore, "utf8");
  const env = deserializeCheckpoint(data);
  if (!env.ok) {
    console.error("Failed to restore checkpoint:", env.errors);
    process.exit(1);
  }
  const result = restoreCheckpoint(env.value);
  if (!result.ok) {
    console.error("Failed to restore:", result.errors);
    process.exit(1);
  }
  engine = createEngine();
  world = result.value.world;
  attachEngine(world, engine);
  console.log(`Restored from ${flags.restore} (tick ${world.tick})`);
} else {
  engine = createEngine();
  const config = makeConfig({ seed: 42 });
  world = createWorld(config, engine, "headless");
  console.log("Created new world (seed=42)");
}

// ── State output ───────────────────────────────────────────────────────────
function printState() {
  const snap = snapshot(world);
  const fs = factStream(world);
  const sh = stateHash(snap);
  const th = traceHash(snap);

  console.log(`tick: ${world.tick}`);
  console.log(`stateHash: ${sh}`);
  console.log(`traceHash: ${th}`);
  console.log(`events: ${fs.length}`);
  console.log(`provenance: ${snap.provenance.length} nodes`);
  console.log(`resolutions: ${snap.resolutionLog.length}`);
  console.log(`rngState: ${snap.rngState.s}`);

  // Region summary
  for (const [id, region] of Object.entries(snap.regions)) {
    if (!region) continue;
    const grain = region.stocks["grain"] ?? 0;
    const price = region.prices["grain"] ?? 0;
    console.log(`  ${id}: grain=${grain.toFixed(1)} price=${price.toFixed(1)}`);
  }
}

function printEvents() {
  const events = stream(world);
  if (events.length === 0) {
    console.log("No events yet.");
    return;
  }
  for (const e of events) {
    console.log(`  [${e.tick}] ${e.type}: ${e.source} (${e.regionId || "global"})`);
  }
}

function printHashes() {
  const snap = snapshot(world);
  console.log(`stateHash: ${stateHash(snap)}`);
  console.log(`traceHash: ${traceHash(snap)}`);
}

function writeCheckpoint() {
  const cp = createCheckpoint(world, "headless-checkpoint");
  const serialized = serializeCheckpoint(cp);
  fs.writeFileSync("headless-checkpoint.json", serialized);
  console.log(`Checkpoint written to headless-checkpoint.json (${(Buffer.byteLength(serialized) / 1024).toFixed(1)} KB)`);
}

function submitInterventionFromString(input: string): boolean {
  const parts = input.trim().split(/\s+/);
  if (parts.length < 2) {
    console.log("Usage: submit ACTION TARGET [LOCATION]");
    return false;
  }

  const action = parts[1];
  const targetId = parts[2] || "RF";
  const location = parts[3] || "RF";

  const iv: Intervention = {
    id: `cli-${Date.now()}`,
    tick: 0,
    actor: "player",
    action,
    target: { type: "region", id: targetId },
    location,
    magnitude: 1,
    causalDomains: [],
    provenance: { submittedAtTick: 0, sequence: 0 },
  };

  const result = submitIntervention(world, iv, engine);
  if (result.ok) {
    console.log(`Accepted: ${action} on ${targetId} at ${location}`);
  } else {
    console.log(`Rejected: ${result.errors.join(", ")}`);
  }
  return result.ok;
}

// ── Main loop ──────────────────────────────────────────────────────────────
async function run() {
  // Predefined interventions for automatic mode
  const autoInterventions: Array<{ tick: number; iv: Intervention }> = [
    { tick: 10, iv: { id: "auto-1", tick: 0, actor: "system", action: "destroy_infrastructure", target: { type: "infrastructure", id: "grain_warehouse" }, location: "RF", magnitude: 1, causalDomains: [], provenance: { submittedAtTick: 0, sequence: 0 } } },
    { tick: 25, iv: { id: "auto-2", tick: 0, actor: "system", action: "hold_public_rally", target: { type: "region", id: "HT" }, location: "HT", magnitude: 0.8, causalDomains: [], provenance: { submittedAtTick: 0, sequence: 0 } } },
    { tick: 50, iv: { id: "auto-3", tick: 0, actor: "system", action: "grant_merchant_subsidy", target: { type: "region", id: "RF" }, location: "RF", magnitude: 0.6, causalDomains: [], provenance: { submittedAtTick: 0, sequence: 0 } } },
  ];

  let interventionIdx = 0;

  if (flags.ticks > 0) {
    // Automatic mode: run N ticks
    const startTime = performance.now();
    for (let t = 0; t < flags.ticks; t++) {
      // Submit scheduled interventions
      while (interventionIdx < autoInterventions.length && autoInterventions[interventionIdx].tick === t) {
        submitIntervention(world, autoInterventions[interventionIdx].iv, engine);
        interventionIdx++;
      }
      advance(world, engine, 1);
    }
    const elapsed = performance.now() - startTime;

    if (flags.json) {
      const snap = snapshot(world);
      console.log(JSON.stringify({
        tick: world.tick,
        stateHash: stateHash(snap),
        traceHash: traceHash(snap),
        events: factStream(world).length,
        provenance: snap.provenance.length,
        resolutions: snap.resolutionLog.length,
        elapsed: elapsed,
        avgTick: elapsed / flags.ticks,
      }));
    } else {
      console.log(`\nCompleted ${flags.ticks} ticks in ${(elapsed / 1000).toFixed(2)}s`);
      printState();
    }

    if (flags.checkpoint) writeCheckpoint();
  } else {
    // Interactive mode
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const prompt = () => {
      rl.question(`[${world.tick}] > `, async (line) => {
        const cmd = line.trim().toLowerCase();
        if (!cmd) { prompt(); return; }

        switch (cmd.split(/\s+/)[0]) {
          case "tick": {
            const n = parseInt(cmd.split(/\s+/)[1] || "1", 10);
            for (let i = 0; i < n; i++) advance(world, engine, 1);
            console.log(`Advanced ${n} tick(s) → tick ${world.tick}`);
            break;
          }
          case "submit":
            submitInterventionFromString(cmd);
            break;
          case "state":
            printState();
            break;
          case "events":
            printEvents();
            break;
          case "hash":
            printHashes();
            break;
          case "checkpoint":
            writeCheckpoint();
            break;
          case "quit":
          case "exit":
            rl.close();
            process.exit(0);
            break;
          default:
            console.log("Commands: tick [N], submit ACTION TARGET, state, events, hash, checkpoint, quit");
        }
        prompt();
      });
    };

    console.log("\nHeadless CE Runtime — interactive mode");
    console.log("Type 'help' for commands, 'quit' to exit.\n");
    prompt();
  }
}

run().catch(console.error);
