/**
 * CE clean-consumer verification.
 *
 * This file lives OUTSIDE the CE repository and imports CE only as an installed
 * npm package. It has no access to src/, docs/, examples/, or scripts/.
 *
 * If this passes, the published artifact is self-sufficient. If it needs
 * anything from the repository, the artifact is incomplete.
 *
 * Reference values are the P-022/P-023 baseline:
 *   initial grain price  10.00
 *   after destroy + 5    13.13, stateHash prefix 5404d32e
 */
import {
  createGame,
  intervene,
  step,
  inspect,
  whatChanged,
  openEventStream,
  why,
  quantity,
  saveGame,
  loadGame,
  forkGame,
  rewindGame,
  compareTimelines,
  timelineOf,
  listActions,
  describeAction,
  validateConfig,
  createConfig,
  ConfigError,
  recentEvents,
  inspectSave,
} from "causality-engine/product";

let passed = 0;
let failed = 0;

function check(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL: ${label}`);
  }
}

const DESTROY = {
  action: "destroy_infrastructure",
  target: { type: "infrastructure", id: "grain_road" },
  location: "RF",
};

const SUBSIDY = {
  action: "grant_merchant_subsidy",
  target: { type: "region", id: "RF" },
  location: "RF",
};

console.log("=== CE clean-consumer verification (installed package only) ===");

// ── 1. Import surface ──────────────────────────────────────────────────────
check(typeof createGame === "function", "1: createGame imported from package");
check(typeof why === "function", "1: why imported from package");
check(typeof quantity.price === "function", "1: quantity helpers imported");

// ── 2. Action catalog is discoverable ──────────────────────────────────────
const actions = listActions().map((a) => a.action);
check(actions.includes("destroy_infrastructure"), "2: catalog lists destroy_infrastructure");
check(actions.includes("grant_merchant_subsidy"), "2: catalog lists grant_merchant_subsidy");
check(describeAction("hold_public_rally")?.locationMustEqualTarget === true, "2: location constraint reported");

// ── 3. Config validation at the boundary ───────────────────────────────────
check(validateConfig({}).ok === true, "3: empty override set is valid");
check(validateConfig({ ledgerDecayPerTick: 1.5 }).ok === false, "3: invalid decay rejected");
let threw = false;
try {
  createConfig({ boundaryDecay: 3 });
} catch (error) {
  threw = error instanceof ConfigError;
}
check(threw, "3: createConfig throws ConfigError on invalid input");

// ── 4. Create and inspect ──────────────────────────────────────────────────
const game = createGame({ seed: 42 });
const stream = openEventStream(game);
const initial = inspect(game);

check(initial.tick === 0, "4: world starts at tick 0");
check(initial.regions.RF !== undefined, "4: region RF projected");
const priceBefore = initial.regions.RF.prices.grain;
check(priceBefore === 10, `4: initial grain price is 10.00 (got ${priceBefore})`);
check(initial.regions.RF.infrastructure.grain_road.intact === true, "4: bridge intact initially");

// ── 5. Checkpoint before acting ────────────────────────────────────────────
const branchPoint = saveGame(game, "before-action");
check(typeof branchPoint.data === "string" && branchPoint.data.length > 0, "5: save produced opaque data");
check(inspectSave(branchPoint.data).ok === true, "5: save data is readable metadata");

// ── 6. Intervene ───────────────────────────────────────────────────────────
const applied = intervene(game, DESTROY);
check(applied.ok === true, "6: CE accepted the intervention");

const repeat = intervene(game, DESTROY);
check(repeat.ok === false, "6: repeated destroy rejected (idempotent rejection preserved)");

// ── 7. Advance ─────────────────────────────────────────────────────────────
const stepped = step(game, 5);
check(stepped.tick === 5, `7: advanced to tick 5 (got ${stepped.tick})`);
check(
  stepped.stateHash.startsWith("5404d32e"),
  `7: stateHash matches P-014 baseline 5404d32e (got ${stepped.stateHash.slice(0, 8)})`,
);

// ── 8. Consume events ──────────────────────────────────────────────────────
const seqs = [];
const report = stream.drain((event, meta) => seqs.push(meta.streamSeq));
check(report.delivered > 0, `8: consumed ${report.delivered} events`);
check(report.acked === true, "8: batch acknowledged");
check(
  seqs.every((s, i) => i === 0 || s >= seqs[i - 1]),
  "8: events delivered in non-decreasing streamSeq order",
);
check(stream.next().status === "caught_up", "8: stream caught up after ack");
check(recentEvents(game, 5).length <= 5, "8: recentEvents respects its limit");

// ── 9. Observe the consequence ─────────────────────────────────────────────
const after = inspect(game);
const priceAfter = after.regions.RF.prices.grain;
check(priceAfter > priceBefore, `9: grain price rose ${priceBefore} -> ${priceAfter.toFixed(2)}`);
check(priceAfter.toFixed(2) === "13.13", `9: grain price matches baseline 13.13 (got ${priceAfter.toFixed(2)})`);
check(after.regions.RF.infrastructure.grain_road.intact === false, "9: bridge reported destroyed");

const changes = whatChanged(initial, after);
check(
  changes.some((c) => c.path === "regions.RF.prices.grain"),
  "9: whatChanged reports the grain price path",
);
check(whatChanged(initial, initial).length === 0, "9: identical views report no changes");

// ── 10. Explain ────────────────────────────────────────────────────────────
const cause = why(game, quantity.price("RF", "grain"));
check(cause.explained === true, "10: CE explained the grain price");
check(
  cause.rootActions.some((r) => r.action === "destroy_infrastructure"),
  "10: explanation rooted in destroy_infrastructure",
);
check(why(game, quantity.hostility("NOPE")).explained === false, "10: unknown quantity honestly unexplained");

// ── 11. Save / load deterministic continuation ─────────────────────────────
const midSave = saveGame(game, "mid");
const expectedHash = step(game, 5).stateHash;
const reloaded = loadGame(midSave.data);
check(reloaded.ok === true, "11: save data loaded");
if (reloaded.ok) {
  check(inspect(reloaded.runtime).stateHash === midSave.stateHash, "11: restored hash matches saved hash");
  check(step(reloaded.runtime, 5).stateHash === expectedHash, "11: continuation is deterministic");
}
check(loadGame("not-json").ok === false, "11: malformed save rejected with errors");

// ── 12. Fork an alternate timeline ─────────────────────────────────────────
const forked = forkGame(branchPoint.data, "B");
check(forked.ok === true, "12: fork succeeded");
if (forked.ok) {
  const alternate = forked.runtime;
  check(
    timelineOf(alternate).timelineId !== timelineOf(game).timelineId,
    "12: forked timeline is distinct",
  );
  check(timelineOf(alternate).origin === "fork", "12: fork lineage recorded");

  check(intervene(alternate, SUBSIDY).ok === true, "13: alternate intervention accepted");
  step(alternate, 5);
  check(
    inspect(alternate).regions.RF.infrastructure.grain_road.intact === true,
    "13: bridge intact on the branch",
  );

  // ── 14. Compare ──────────────────────────────────────────────────────────
  const comparison = compareTimelines(game, alternate);
  check(comparison.distinct === true, "14: timelines reported distinct");
  check(comparison.stateHashEqual === false, "14: worlds differ");
  check(comparison.traceHashEqual === false, "14: histories differ");
  check(comparison.differences.length > 0, `14: ${comparison.differences.length} observable differences`);
}

// ── 15. Rewind ─────────────────────────────────────────────────────────────
const rewound = rewindGame(game, branchPoint.data);
check(rewound.ok === true, "15: rewind succeeded");
if (rewound.ok) {
  check(rewound.runtime.world.tick === branchPoint.tick, "15: returned to the checkpoint tick");
  check(
    inspect(rewound.runtime).regions.RF.infrastructure.grain_road.intact === true,
    "15: physical world restored (bridge intact)",
  );
  check(rewound.abandonedTimelineId.length > 0, "15: abandoned timeline named");
  check(timelineOf(rewound.runtime).origin === "rewind", "15: rewind lineage recorded");
}

// ── 16. Determinism across independent runs ────────────────────────────────
function runOnce() {
  const g = createGame({ seed: 42 });
  intervene(g, DESTROY);
  return step(g, 5).stateHash;
}
check(runOnce() === runOnce(), "16: identical inputs produce identical state hashes");

console.log("");
console.log(`=== RESULTS: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
