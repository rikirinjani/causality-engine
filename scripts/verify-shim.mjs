/**
 * Verify the browser SHA-256 shim against node:crypto.
 *
 * The shim exists so CE can run in a browser without changing frozen engine
 * code. If it disagreed with node:crypto by a single bit, the web demo would
 * report different state hashes than CI — silently contradicting CE's
 * determinism claim. This script is the gate on that.
 *
 * Run: node scripts/verify-shim.mjs
 */
import { createHash as nodeCreateHash } from "node:crypto";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const shimSrc = join(root, "web", "src", "node-crypto-shim.ts");
const tmpDir = join(root, ".shim-check");

// ── Compile the shim to plain JS so we can import it here ──────────────────
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

execSync(
  `npx tsc "${shimSrc}" --outDir "${tmpDir}" --module esnext --target es2022 --moduleResolution bundler --strict`,
  { cwd: root, stdio: "pipe" },
);

const compiled = join(tmpDir, "node-crypto-shim.js");
// Node needs .mjs (or a package type) to treat it as ESM.
const asMjs = join(tmpDir, "shim.mjs");
writeFileSync(asMjs, readFileSync(compiled, "utf8"));

const { createHash: shimCreateHash } = await import(`file://${asMjs}`);

let passed = 0;
let failed = 0;

function check(label, expected, actual) {
  if (expected === actual) {
    passed += 1;
  } else {
    failed += 1;
    console.log(`FAIL: ${label}`);
    console.log(`  node: ${expected}`);
    console.log(`  shim: ${actual}`);
  }
}

function compare(label, payload) {
  const expected = nodeCreateHash("sha256").update(payload).digest("hex");
  const actual = shimCreateHash("sha256").update(payload).digest("hex");
  check(label, expected, actual);
}

console.log("=== SHA-256 shim vs node:crypto ===");

// ── FIPS 180-4 known-answer tests ─────────────────────────────────────────
check(
  "KAT: empty string",
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  shimCreateHash("sha256").update("").digest("hex"),
);
check(
  'KAT: "abc"',
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  shimCreateHash("sha256").update("abc").digest("hex"),
);
check(
  "KAT: 448-bit message",
  "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  shimCreateHash("sha256")
    .update("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")
    .digest("hex"),
);

// ── Block-boundary behaviour: padding is where naive implementations break ──
for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 255, 256, 1000]) {
  compare(`length ${length}`, "a".repeat(length));
}

// ── UTF-8 multi-byte: CE payloads contain region names and labels ──────────
compare("utf8 2-byte", "Ǆ".repeat(40));
compare("utf8 3-byte", "→".repeat(40));
compare("utf8 4-byte (surrogate pair)", "𝄞".repeat(40));
compare("mixed ascii + multibyte", 'Riverford — grain ▲ "13.13"');

// ── Streaming: CE calls .update() once, but chunking must not change output ─
{
  const chunks = ["{\"tick\":", "5,", "\"regions\":{\"RF\":", "{\"prices\":{\"grain\":13.13}}}}"];
  const whole = chunks.join("");
  const expected = nodeCreateHash("sha256").update(whole).digest("hex");
  const streamed = chunks
    .reduce((h, c) => h.update(c), shimCreateHash("sha256"))
    .digest("hex");
  check("streaming equals single update", expected, streamed);
}

// ── Realistic CE payload shapes ───────────────────────────────────────────
const worldish = JSON.stringify({
  tick: 5,
  schemaVersion: 7,
  lineage: {
    worldId: "W-9f2c1a",
    timelineId: "T-28c9d0a2",
    origin: "genesis",
    parentTimelineId: null,
    generation: 0,
  },
  config: { seed: 42, thresholds: { civic: 0.6, ecology: 0.6, economy: 0.6, faction: 0.6 } },
  regions: {
    RF: {
      id: "RF",
      name: "Riverford",
      prices: { grain: 13.134310936532078, iron: 4, cloth: 3 },
      stocks: { grain: 11.2, iron: 4 },
      infrastructure: { grain_road: { type: "trade_route", health: 0 } },
      unrest: 0.04,
    },
  },
  relations: { "MG>RF": 0.42, "WA>RF": 0.11 },
  rngState: { s: 2463534242 },
});
compare("world-shaped payload", worldish);

const eventish = JSON.stringify({
  timelineId: "T-28c9d0a2",
  tick: 5,
  ordinal: 3,
  type: "economy.price_shock",
  regionId: "RF",
  data: { resource: "grain", from: 10, to: 13.134310936532078 },
});
compare("event-shaped payload", eventish);

// ── Digest encodings CE may request ───────────────────────────────────────
check(
  "base64 encoding",
  nodeCreateHash("sha256").update(worldish).digest("base64"),
  shimCreateHash("sha256").update(worldish).digest("base64"),
);

// ── Algorithm-name handling ───────────────────────────────────────────────
check(
  "SHA-256 alias accepted",
  nodeCreateHash("sha256").update("x").digest("hex"),
  shimCreateHash("SHA-256").update("x").digest("hex"),
);

let rejected = false;
try {
  shimCreateHash("md5");
} catch {
  rejected = true;
}
check("unsupported algorithm rejected", true, rejected);

// ── Fuzz: random payloads, including binary-ish and pathological input ─────
{
  let mismatch = 0;
  // Deterministic PRNG so a failure is reproducible.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let i = 0; i < 500; i += 1) {
    const len = Math.floor(rand() * 300);
    let s = "";
    for (let j = 0; j < len; j += 1) s += String.fromCharCode(Math.floor(rand() * 0x2fff));
    const expected = nodeCreateHash("sha256").update(s).digest("hex");
    const actual = shimCreateHash("sha256").update(s).digest("hex");
    if (expected !== actual) mismatch += 1;
  }
  check("fuzz 500 random payloads", 0, mismatch);
}

// ── Large payload: checkpoints reach tens of KB ────────────────────────────
compare("large payload 100 KB", JSON.stringify({ blob: "x".repeat(100_000) }));

rmSync(tmpDir, { recursive: true, force: true });

console.log("");
console.log(`=== RESULTS: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
