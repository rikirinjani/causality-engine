/**
 * Headless browser verification for the CE web demo.
 *
 * The shim matches node:crypto (scripts/verify-shim.mjs) and the engine matches
 * itself through the shim (scripts/verify-browser-parity.mjs). This is the last
 * claim: the bundled site, loaded in a real browser engine, runs CE and produces
 * the P-014 baseline hash.
 *
 * Drives the actual built bundle through the DOM — the same buttons a visitor
 * clicks — rather than importing modules directly, so bundling, aliasing and the
 * demo wiring are all covered.
 *
 * Requires: npm run build in web/, and a Chromium available to Puppeteer.
 * Run: node scripts/verify-web-demo.mjs
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, extname, normalize } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dist = join(root, "web", "dist");

if (!existsSync(join(dist, "index.html"))) {
  console.log("FAIL: web/dist/index.html not found — run `npm run build` in web/ first");
  process.exit(1);
}

/**
 * Load puppeteer.
 *
 * It is a devDependency of web/, not of the repo root, so a bare specifier would
 * resolve against this script's own location and miss it. Resolve explicitly
 * from web/ instead.
 */
async function loadPuppeteer() {
  const attempts = [
    // Installed under web/ (the normal case).
    () => {
      const require = createRequire(join(root, "web", "package.json"));
      return import(pathToFileURL(require.resolve("puppeteer")).href);
    },
    // Installed at the repo root.
    () => {
      const require = createRequire(join(root, "package.json"));
      return import(pathToFileURL(require.resolve("puppeteer")).href);
    },
    // Available globally.
    () => import("puppeteer"),
  ];

  for (const attempt of attempts) {
    try {
      const mod = await attempt();
      return mod.default ?? mod;
    } catch {
      // try the next location
    }
  }
  return null;
}

const puppeteer = await loadPuppeteer();

if (puppeteer === null) {
  console.log("SKIP: puppeteer is not installed.");
  console.log("      Install it to run this check:  cd web && npm i -D puppeteer");
  console.log("      Then fetch a browser:          npx puppeteer browsers install chrome");
  process.exit(0);
}

// ── Static server ─────────────────────────────────────────────────────────
// The bundle is built with base "/causality-engine/", so serve under that path.
const BASE = "/causality-engine/";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (path.startsWith(BASE)) path = path.slice(BASE.length - 1);
    if (path === "/" || path === "") path = "/index.html";

    const file = join(dist, normalize(path).replace(/^(\.\.[/\\])+/, ""));
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const url = `http://127.0.0.1:${port}${BASE}`;

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

console.log("=== CE web demo in a real browser ===");
console.log(`serving ${dist}`);
console.log(`at      ${url}`);
console.log("");

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto(url, { waitUntil: "networkidle0", timeout: 30_000 });

  const text = (sel) => page.$eval(sel, (el) => el.textContent?.trim() ?? "");
  const enabled = (sel) => page.$eval(sel, (el) => !el.disabled);
  const click = async (sel) => {
    await page.click(sel);
    // Let the demo's synchronous work and DOM writes settle.
    await new Promise((r) => setTimeout(r, 120));
  };

  // ── Engine boots ───────────────────────────────────────────────────────
  await page.waitForFunction(
    () => !document.querySelector("[data-act=destroy]")?.disabled,
    { timeout: 20_000 },
  );
  check("engine loaded and demo became interactive", true, await enabled("[data-act=destroy]"));

  // ── Initial world ──────────────────────────────────────────────────────
  check("initial tick is 0", "0", await text("[data-tick]"));
  check("initial grain price is 10.00", "10.00", await text("[data-price]"));
  check("grain road starts intact", "intact", await text("[data-road]"));

  const initialHash = await text("[data-hash]");
  check("initial state hash is rendered", 8, initialHash.length);

  // ── Checkpoint first, so the fork branches from an intact world ────────
  // Order matters: a checkpoint taken after the road is destroyed would give
  // both timelines a destroyed road and the comparison would prove nothing.
  await click("[data-act=checkpoint]");
  check("fork unlocked after checkpoint", true, await enabled("[data-act=fork]"));

  // ── Intervene ──────────────────────────────────────────────────────────
  await click("[data-act=destroy]");
  check("road reported destroyed after intervention", "destroyed", await text("[data-road]"));
  check("advance unlocked", true, await enabled("[data-act=advance]"));

  // ── Advance: the headline determinism claim ────────────────────────────
  await click("[data-act=advance]");
  check("tick advanced to 5", "5", await text("[data-tick]"));
  check("grain price is 13.13", "13.13", await text("[data-price]"));
  check(
    "state hash matches the P-014 baseline 5404d32e",
    "5404d32e",
    await text("[data-hash]"),
  );

  // ── Explain ────────────────────────────────────────────────────────────
  await click("[data-act=why]");
  const whyVisible = await page.$eval("[data-why]", (el) => !el.hidden);
  check("explanation panel shown", true, whyVisible);

  const whyText = await text("[data-why]");
  check(
    "explanation names destroy_infrastructure",
    true,
    whyText.includes("destroy_infrastructure"),
  );
  check("explanation reports a causal chain", true, (await page.$$(".chain li")).length > 0);

  // ── Fork the alternate timeline ────────────────────────────────────────
  await click("[data-act=fork]");
  check("compare unlocked after fork", true, await enabled("[data-act=compare]"));

  // ── Compare ────────────────────────────────────────────────────────────
  await click("[data-act=compare]");
  const compareVisible = await page.$eval("[data-compare]", (el) => !el.hidden);
  check("comparison panel shown", true, compareVisible);

  const compareText = await text("[data-compare]");
  check("comparison reports distinct timelines", true, compareText.includes("distinct true"));
  check("comparison reports differing worlds", true, compareText.includes("same state false"));

  // Read the two branch panels rather than substring-matching the whole block,
  // so this asserts the actual per-timeline values CE reported.
  const branches = await page.$$eval(".branch", (nodes) =>
    nodes.map((node) => {
      const rows = Array.from(node.querySelectorAll(".branch__row"));
      const value = (key) =>
        rows
          .find((r) => r.querySelector("dt")?.textContent?.trim() === key)
          ?.querySelector("dd")
          ?.textContent?.trim() ?? "";
      return { road: value("road"), grain: value("grain"), hash: value("stateHash") };
    }),
  );

  check("two branch panels rendered", 2, branches.length);
  check("timeline A shows the road destroyed", "destroyed", branches[0]?.road);
  check("timeline B kept the road intact", "intact", branches[1]?.road);
  check("timeline A grain is 13.13", "13.13", branches[0]?.grain);
  check(
    "timeline B grain differs from A",
    true,
    branches[1]?.grain !== undefined && branches[1].grain !== branches[0]?.grain,
  );
  check(
    "branch state hashes differ",
    true,
    branches[0]?.hash !== undefined && branches[0].hash !== branches[1]?.hash,
  );

  // ── Reset restores the deterministic starting point ────────────────────
  await click("[data-act=reset]");
  check("reset returns to tick 0", "0", await text("[data-tick]"));
  check("reset returns grain to 10.00", "10.00", await text("[data-price]"));
  check("reset restores the road", "intact", await text("[data-road]"));
  check("reset reproduces the initial hash", initialHash, await text("[data-hash]"));

  // ── Determinism through the UI: repeat the run, same hash ──────────────
  await click("[data-act=checkpoint]");
  await click("[data-act=destroy]");
  await click("[data-act=advance]");
  check(
    "second identical run reproduces 5404d32e",
    "5404d32e",
    await text("[data-hash]"),
  );

  // ── Accessibility smoke checks ─────────────────────────────────────────
  const focusables = await page.$$eval(
    "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])",
    (els) => els.length,
  );
  check("focusable controls exist", true, focusables > 10);

  const logLive = await page.$eval("[data-log]", (el) => el.getAttribute("aria-live"));
  check("engine log is a live region", "polite", logLive);

  const langAttr = await page.$eval("html", (el) => el.getAttribute("lang"));
  check("document language declared", "en", langAttr);

  const skipLink = await page.$("a.skip-link");
  check("skip link present", true, skipLink !== null);

  // ── No console errors ──────────────────────────────────────────────────
  check(`no console errors (saw ${consoleErrors.length})`, 0, consoleErrors.length);
  for (const err of consoleErrors.slice(0, 5)) console.log(`  console: ${err}`);

  // ── Responsive sanity: no horizontal overflow ──────────────────────────
  for (const width of [360, 768, 1440]) {
    await page.setViewport({ width, height: 900 });
    await new Promise((r) => setTimeout(r, 80));
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check(`no horizontal overflow at ${width}px (${overflow}px)`, true, overflow <= 1);
  }
} finally {
  await browser.close();
  server.close();
}

console.log("");
console.log(`=== RESULTS: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
