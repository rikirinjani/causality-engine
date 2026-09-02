/**
 * Prove the real CE engine reproduces the P-014 replay baseline while using the
 * browser SHA-256 shim instead of node:crypto.
 *
 * The shim already matches node:crypto byte-for-byte on synthetic payloads
 * (scripts/verify-shim.mjs). This is the stronger claim: the actual engine,
 * hashing through the shim, produces the same world identity CI produces.
 *
 * If this passes, the browser demo can display real state hashes and they will
 * agree with the hashes in the release notes.
 *
 * Method: build CE to dist/, then rewrite the two compiled modules that import
 * node:crypto so they import the shim instead. No source file is modified — the
 * engine is research-frozen. Work happens in a scratch copy of dist/.
 *
 * Run: node scripts/verify-browser-parity.mjs
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const scratch = join(root, ".browser-parity");

let passed = 0;
let failed = 0;

function check(label, expected, actual) {
  if (expected === actual) {
    passed += 1;
    console.log(`PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL: ${label}`);
    console.log(`  expected: ${expected}`);
    console.log(`  actual:   ${actual}`);
  }
}

console.log("=== CE engine parity: browser shim vs node:crypto ===");

// ── 1. Build the shippable engine ─────────────────────────────────────────
console.log("building dist/ ...");
execSync("npx tsc -p tsconfig.build.json", { cwd: root, stdio: "pipe" });
if (!existsSync(join(root, "dist", "api", "product.js"))) {
  console.log("FAIL: build produced no dist/api/product.js");
  process.exit(1);
}

// ── 2. Reference run: the engine as shipped, using node:crypto ─────────────
const nodeApi = await import(`file://${join(root, "dist", "api", "product.js")}`);

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

/**
 * The canonical demo scenario, run end to end. Returns every observable the web
 * demo will display, so parity covers the whole surface rather than one hash.
 */
function scenario(api) {
  const game = api.createGame({ seed: 42 });
  const initial = api.inspect(game);

  const branchPoint = api.saveGame(game, "branch-point");

  api.intervene(game, DESTROY);
  const stepped = api.step(game, 5);
  const after = api.inspect(game);

  const cause = api.why(game, api.quantity.price("RF", "grain"));

  // Save/load determinism.
  const mid = api.saveGame(game, "mid");
  const continued = api.step(game, 5).stateHash;
  const reloaded = api.loadGame(mid.data);
  const reloadedContinued = reloaded.ok ? api.step(reloaded.runtime, 5).stateHash : "LOAD_FAILED";

  // Fork an alternate timeline and diverge.
  const forked = api.forkGame(branchPoint.data, "B");
  let comparison = null;
  let branchPrice = null;
  if (forked.ok) {
    api.intervene(forked.runtime, SUBSIDY);
    api.step(forked.runtime, 5);
    comparison = api.compareTimelines(game, forked.runtime);
    branchPrice = api.inspect(forked.runtime).regions.RF.prices.grain;
  }

  const events = api.recentEvents(game, 50).map((e) => `${e.streamSeq}:${e.type}`);

  return {
    initialHash: initial.stateHash,
    initialPrice: initial.regions.RF.prices.grain,
    initialTimeline: initial.timelineId,
    steppedHash: stepped.stateHash,
    steppedTraceHash: stepped.traceHash,
    afterPrice: after.regions.RF.prices.grain,
    bridgeIntact: after.regions.RF.infrastructure.grain_road.intact,
    unrest: after.regions.RF.unrest,
    relations: JSON.stringify(after.relations),
    checkpointId: branchPoint.checkpointId,
    branchPointHash: branchPoint.stateHash,
    explained: cause.explained,
    rootAction: cause.rootActions[0]?.action ?? "NONE",
    rootTick: cause.rootActions[0]?.tick ?? -1,
    chainCount: cause.chains.length,
    continued,
    reloadedContinued,
    forkTimeline: forked.ok ? api.timelineOf(forked.runtime).timelineId : "FORK_FAILED",
    branchPrice,
    comparisonDistinct: comparison?.distinct ?? null,
    comparisonStateEqual: comparison?.stateHashEqual ?? null,
    comparisonDiffCount: comparison?.differences.length ?? -1,
    events: events.join(","),
  };
}

const reference = scenario(nodeApi);

// ── 3. Sanity: the reference run matches the documented baseline ───────────
check("reference: initial grain price 10", 10, reference.initialPrice);
check(
  "reference: post-destroy stateHash starts 5404d32e (P-014 baseline)",
  true,
  reference.steppedHash.startsWith("5404d32e"),
);
check("reference: grain price 13.13", "13.13", reference.afterPrice.toFixed(2));
check("reference: explained by destroy_infrastructure", "destroy_infrastructure", reference.rootAction);

// ── 4. Rebuild dist into scratch, swapping node:crypto for the shim ────────
console.log("preparing shim-backed copy ...");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
cpSync(join(root, "dist"), join(scratch, "dist"), { recursive: true });

// Compile the shim next to the copied engine.
execSync(
  `npx tsc "${join(root, "web", "src", "node-crypto-shim.ts")}" --outDir "${join(scratch, "shim")}" --module esnext --target es2022 --moduleResolution bundler --strict`,
  { cwd: root, stdio: "pipe" },
);
// Give it an .mjs extension so Node treats it as ESM without a package.json.
writeFileSync(
  join(scratch, "shim", "shim.mjs"),
  readFileSync(join(scratch, "shim", "node-crypto-shim.js"), "utf8"),
);

// Rewrite exactly the modules that import node:crypto.
const patchTargets = [
  join(scratch, "dist", "core", "hash.js"),
  join(scratch, "dist", "core", "events.js"),
];

let patchedCount = 0;
for (const file of patchTargets) {
  const before = readFileSync(file, "utf8");
  if (!before.includes('from "node:crypto"')) {
    console.log(`FAIL: expected node:crypto import in ${file}`);
    failed += 1;
    continue;
  }
  // core/*.js -> ../../shim/shim.mjs
  const after = before.replace(/from "node:crypto"/g, 'from "../../shim/shim.mjs"');
  writeFileSync(file, after);
  patchedCount += 1;
}
check("patched both node:crypto importers", 2, patchedCount);

// Confirm nothing else in the shipped engine reaches for node:crypto.
const remaining = execSync(
  `grep -rl 'node:crypto' "${join(scratch, "dist")}" || true`,
  { encoding: "utf8", shell: "/bin/bash" },
).trim();
check("no remaining node:crypto imports in dist", "", remaining);

// ── 5. Run the identical scenario through the shim-backed engine ───────────
const shimApi = await import(`file://${join(scratch, "dist", "api", "product.js")}`);
const shimResult = scenario(shimApi);

// ── 6. Compare every observable ───────────────────────────────────────────
console.log("");
console.log("--- observable-by-observable parity ---");
const keys = Object.keys(reference);
for (const key of keys) {
  check(`parity: ${key}`, reference[key], shimResult[key]);
}

// ── 7. The headline claim, stated explicitly ──────────────────────────────
console.log("");
check(
  "shim-backed engine reproduces the P-014 baseline hash",
  true,
  shimResult.steppedHash.startsWith("5404d32e"),
);

console.log("");
console.log(`reference stateHash: ${reference.steppedHash}`);
console.log(`shim      stateHash: ${shimResult.steppedHash}`);
console.log(`reference traceHash: ${reference.steppedTraceHash}`);
console.log(`shim      traceHash: ${shimResult.steppedTraceHash}`);

rmSync(scratch, { recursive: true, force: true });

console.log("");
console.log(`=== RESULTS: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
