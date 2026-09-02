/**
 * CE v1.0 — Minimal integration example.
 *
 * The smallest complete game integration: create a world, act on it, advance
 * time, consume events, inspect the result, ask why, branch, and reload.
 *
 * Every import comes from the product surface. Nothing here reaches into CE
 * internals — this file is the proof that a developer does not need to.
 *
 * Run: npm run example
 */
import {
  createGame,
  intervene,
  step,
  openEventStream,
  inspect,
  whatChanged,
  why,
  quantity,
  saveGame,
  loadGame,
  forkGame,
  compareTimelines,
  listActions,
} from "../src/api/product.js";

// ── 1. Discover what the world accepts ─────────────────────────────────────
console.log("Available actions:");
for (const action of listActions()) {
  console.log(`  ${action.action}  (targets: ${action.allowedTargets.join(", ")})`);
}

// ── 2. Create a world ──────────────────────────────────────────────────────
const game = createGame({ seed: 42 });
const events = openEventStream(game);

const initial = inspect(game);
console.log(`\nTick ${initial.tick} | grain ${initial.regions["RF"]!.prices["grain"]!.toFixed(2)}`);

// ── 3. Checkpoint before acting, so we can branch later ────────────────────
const branchPoint = saveGame(game, "before-action");

// ── 4. The player destroys the trade bridge ────────────────────────────────
const applied = intervene(game, {
  action: "destroy_infrastructure",
  target: { type: "infrastructure", id: "grain_road" },
  location: "RF",
});
if (!applied.ok) throw new Error(`rejected: ${applied.errors.join(", ")}`);

// ── 5. Let causal consequences unfold ──────────────────────────────────────
const stepped = step(game, 5);
console.log(`Advanced to tick ${stepped.tick} | hash ${stepped.stateHash.slice(0, 8)}`);

// ── 6. Consume what happened, in canonical order, acking as we go ──────────
const report = events.drain((event, meta) => {
  console.log(`  event #${meta.streamSeq} ${event.type} (attempt ${meta.attempt})`);
});
console.log(`Consumed ${report.delivered} events, acked=${report.acked}`);

// ── 7. Observe the consequence ─────────────────────────────────────────────
const after = inspect(game);
console.log(`\nGrain price ${initial.regions["RF"]!.prices["grain"]!.toFixed(2)} -> ${after.regions["RF"]!.prices["grain"]!.toFixed(2)}`);
console.log(`Bridge intact: ${after.regions["RF"]!.infrastructure["grain_road"]!.intact}`);
console.log(`Changes: ${whatChanged(initial, after).length} projected quantities moved`);

// ── 8. Ask CE why ──────────────────────────────────────────────────────────
const cause = why(game, quantity.price("RF", "grain"));
console.log(`\nWhy is grain expensive? explained=${cause.explained}`);
for (const root of cause.rootActions) {
  console.log(`  root: ${root.action} on ${root.targetId} at tick ${root.tick}`);
}

// ── 9. Fork an alternate timeline that subsidises instead ──────────────────
const forked = forkGame(branchPoint.data, "B");
if (!forked.ok) throw new Error(forked.errors.join(", "));
const alternate = forked.runtime;

intervene(alternate, {
  action: "grant_merchant_subsidy",
  target: { type: "region", id: "RF" },
  location: "RF",
});
step(alternate, 5);

// ── 10. Compare the two worlds ─────────────────────────────────────────────
const comparison = compareTimelines(game, alternate);
console.log(`\nTimeline A ${comparison.a.timelineId.slice(0, 10)} vs B ${comparison.b.timelineId.slice(0, 10)}`);
console.log(`  distinct=${comparison.distinct} sameState=${comparison.stateHashEqual} sameHistory=${comparison.traceHashEqual}`);
console.log(`  ${comparison.differences.length} observable differences`);
console.log(`  A grain ${inspect(game).regions["RF"]!.prices["grain"]!.toFixed(2)} | B grain ${inspect(alternate).regions["RF"]!.prices["grain"]!.toFixed(2)}`);

// ── 11. Save and reload — continuation is deterministic ────────────────────
const save = saveGame(alternate, "final");
const expected = step(alternate, 3).stateHash;

const reloaded = loadGame(save.data);
if (!reloaded.ok) throw new Error(reloaded.errors.join(", "));
const actual = step(reloaded.runtime, 3).stateHash;

console.log(`\nDeterministic continuation: ${actual === expected ? "CONFIRMED" : "FAILED"}`);
console.log(`  ${expected.slice(0, 16)} === ${actual.slice(0, 16)}`);
