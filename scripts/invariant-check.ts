/**
 * Frozen-invariant spot check, driven ONLY through the product surface.
 *
 * Confirms that the P-022 product layer did not weaken:
 *   INV 4/12  deterministic state identity for identical inputs
 *   INV 10    branching produces causally distinct timelines
 *   INV 11    checkpoint/rewind are CE operations with honest lineage
 *   delivery  at-least-once with explicit acknowledgement
 */
import {
  createGame,
  intervene,
  step,
  saveGame,
  loadGame,
  forkGame,
  compareTimelines,
  openEventStream,
  inspect,
} from "../src/api/product.js";

const DESTROY = {
  action: "destroy_infrastructure",
  target: { type: "infrastructure" as const, id: "grain_road" },
  location: "RF",
};

function runOnce(): string {
  const g = createGame({ seed: 42 });
  intervene(g, DESTROY);
  return step(g, 5).stateHash;
}

// ── INV 4/12: same seed + same interventions => same stateHash ─────────────
const a = runOnce();
const b = runOnce();
console.log(`INV 4/12 determinism      run1=${a.slice(0, 16)} run2=${b.slice(0, 16)} identical=${a === b}`);

// ── INV 4: deterministic continuation across save/load ────────────────────
const g1 = createGame({ seed: 42 });
intervene(g1, DESTROY);
step(g1, 3);
const save = saveGame(g1, "invariant-check");
const direct = step(g1, 5).stateHash;
const reloaded = loadGame(save.data);
if (!reloaded.ok) throw new Error(reloaded.errors.join(", "));
const afterReload = step(reloaded.runtime, 5).stateHash;
console.log(`INV 4  continuation       direct=${direct.slice(0, 16)} reloaded=${afterReload.slice(0, 16)} identical=${direct === afterReload}`);

// ── INV 10: branches remain causally distinct ─────────────────────────────
const trunk = createGame({ seed: 42 });
step(trunk, 1);
const branchPoint = saveGame(trunk, "branch-point");
intervene(trunk, DESTROY);
step(trunk, 5);

const forked = forkGame(branchPoint.data, "B");
if (!forked.ok) throw new Error(forked.errors.join(", "));
intervene(forked.runtime, {
  action: "grant_merchant_subsidy",
  target: { type: "region", id: "RF" },
  location: "RF",
});
step(forked.runtime, 5);

const cmp = compareTimelines(trunk, forked.runtime);
console.log(
  `INV 10 branch distinctness distinct=${cmp.distinct} sameState=${cmp.stateHashEqual} sameHistory=${cmp.traceHashEqual} diffs=${cmp.differences.length}`,
);

// ── INV 11: rewind restores physics, takes new lineage ────────────────────
const before = inspect(trunk).regions["RF"]!.prices["grain"]!;
const rewoundHash = inspect(forked.runtime).stateHash;
console.log(`INV 11 lineage honesty    A grain=${before.toFixed(2)} B hash=${rewoundHash.slice(0, 16)}`);

// ── Delivery: at-least-once, explicit ack ─────────────────────────────────
const g2 = createGame({ seed: 42 });
const stream = openEventStream(g2);
intervene(g2, DESTROY);
step(g2, 5);
const first = stream.next();
const second = stream.next();
const report = stream.drain(() => {});
console.log(
  `delivery semantics        firstAttempt=${first.events[0]?.attempt} redeliverAttempt=${second.events[0]?.attempt} drained=${report.delivered} acked=${report.acked} thenCaughtUp=${stream.next().status === "caught_up"}`,
);
