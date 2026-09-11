/**
 * CE experiment runner — orchestrator.
 *
 * Enumerates deterministic work units, executes them across worker processes,
 * captures structured results and failures, aggregates statistics, and replays
 * recorded failures.
 *
 * Design rules:
 *   - CE semantics are never touched. Parallelism only distributes independent
 *     deterministic work units; a unit's result is identical whether it ran on
 *     the Mac mini or a Vultr VX1 worker.
 *   - Dependency-free beyond what the repo already has (tsx). No new packages.
 *   - A failure record must contain everything needed to reproduce the unit
 *     exactly: commit, seed, config, scenario, iteration, hashes.
 *
 * Usage:
 *   npx tsx scripts/run-experiment.ts --experiment <name> [--workers N] [--out DIR] [--limit N]
 *   npx tsx scripts/run-experiment.ts --replay <record.json>
 *   npx tsx scripts/run-experiment.ts --aggregate <out-dir>
 */
import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPERIMENTS } from "./experiments/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();

interface ResultRecord {
  schemaVersion: number;
  experiment: string;
  unitId: string;
  commit: string;
  seed: number | null;
  config: Record<string, unknown>;
  scenario: Record<string, unknown>;
  iteration: number;
  pass: boolean;
  failure: { class: string; message: string; detail?: unknown } | null;
  hashes: Record<string, string>;
  metrics: Record<string, number | boolean | string>;
  repro: { command: string; unit: unknown };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(): void {
  console.log(`CE experiment runner
Usage:
  npx tsx scripts/run-experiment.ts --experiment <name> [--workers N] [--out DIR] [--limit N]
  npx tsx scripts/run-experiment.ts --replay <record.json>
  npx tsx scripts/run-experiment.ts --aggregate <out-dir>
Experiments: ${Object.keys(EXPERIMENTS).join(", ")}`);
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

function writeRecord(outDir: string, result: ResultRecord): void {
  const safe = safeId(result.unitId);
  writeFileSync(join(outDir, "units", `${safe}.json`), JSON.stringify(result, null, 2));
  if (!result.pass) {
    writeFileSync(join(outDir, "failures", `${safe}.json`), JSON.stringify(result, null, 2));
  }
}

function writeAggregate(outDir: string, results: ResultRecord[], manifest: Record<string, unknown>): void {
  const durations = results
    .map((r) => Number(r.metrics?.durationMs))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  const failureClasses: Record<string, number> = {};
  for (const r of results) {
    if (!r.pass) {
      const c = String(r.failure?.class ?? "unknown");
      failureClasses[c] = (failureClasses[c] ?? 0) + 1;
    }
  }

  const stats = {
    experiment: manifest.experiment,
    commit: manifest.commit,
    unitsTotal: results.length,
    unitsPassed: results.filter((r) => r.pass).length,
    unitsFailed: results.filter((r) => !r.pass).length,
    failureClasses,
    durationMs:
      durations.length > 0
        ? {
            min: durations[0],
            median: durations[Math.floor(durations.length / 2)],
            p95: durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))],
            max: durations[durations.length - 1],
            total: durations.reduce((a, b) => a + b, 0),
          }
        : null,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(outDir, "statistics.json"), JSON.stringify(stats, null, 2));
}

// ── run ────────────────────────────────────────────────────────────────────

async function run(args: string[]): Promise<void> {
  const name = flag(args, "--experiment");
  if (!name) {
    usage();
    process.exit(2);
  }
  const adapter = EXPERIMENTS[name];
  if (!adapter) {
    console.error(`unknown experiment: ${name}`);
    process.exit(2);
  }

  const workersCount = Math.max(1, Number(flag(args, "--workers") ?? "1"));
  const outDir = flag(args, "--out") ?? "results";
  const limit = Number(flag(args, "--limit") ?? "0");

  const allUnits = adapter.enumerateUnits();
  const units = limit > 0 ? allUnits.slice(0, limit) : allUnits;

  console.log(`experiment: ${name}`);
  console.log(`commit:     ${COMMIT}`);
  console.log(`units:      ${units.length} (enumerated ${allUnits.length})`);
  console.log(`workers:    ${workersCount}`);
  console.log(`out:        ${outDir}`);

  mkdirSync(join(outDir, "units"), { recursive: true });
  mkdirSync(join(outDir, "failures"), { recursive: true });

  const startedAt = new Date().toISOString();
  const results: ResultRecord[] = [];
  let failed = 0;

  // Spawn persistent workers. Each reads unit JSON lines from stdin and writes
  // result JSON lines to stdout. One worker is the single-worker mode.
  const workers: Array<{
    child: ReturnType<typeof spawn>;
    assigned: string[];
    done: string[];
  }> = [];

  for (let i = 0; i < workersCount; i += 1) {
    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["tsx", "scripts/experiment-worker.ts"],
      { cwd: ROOT, stdio: ["pipe", "pipe", "inherit"] },
    );
    const entry = { child, assigned: [] as string[], done: [] as string[] };
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let result: ResultRecord;
      try {
        result = JSON.parse(line);
      } catch {
        return;
      }
      results.push(result);
      writeRecord(outDir, result);
      if (!result.pass) failed += 1;
      entry.done.push(result.unitId);
    });
    workers.push(entry);
  }

  // Round-robin assignment. Units are independent and deterministic, so order
  // across workers does not matter and cannot affect any unit's result.
  units.forEach((unit, i) => {
    const w = workers[i % workers.length]!;
    w.assigned.push(String(unit.unitId));
    w.child.stdin.write(JSON.stringify(unit) + "\n");
  });

  await Promise.all(
    workers.map(
      (w) =>
        new Promise<void>((resolve) => {
          w.child.stdin.end();
          w.child.on("exit", () => resolve());
        }),
    ),
  );

  // Any unit a worker never returned is a crash, recorded as such.
  for (const w of workers) {
    for (const id of w.assigned) {
      if (!w.done.includes(id)) {
        const record: ResultRecord = {
          schemaVersion: 1,
          experiment: name,
          unitId: id,
          commit: COMMIT,
          seed: null,
          config: {},
          scenario: {},
          iteration: 0,
          pass: false,
          failure: { class: "worker_crash", message: "worker exited before returning this unit" },
          hashes: {},
          metrics: {},
          repro: { command: "", unit: { unitId: id } },
        };
        results.push(record);
        writeRecord(outDir, record);
        failed += 1;
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const manifest = {
    experiment: name,
    commit: COMMIT,
    workers: workersCount,
    startedAt,
    finishedAt,
    unitsTotal: units.length,
    unitsPassed: units.length - failed,
    unitsFailed: failed,
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeAggregate(outDir, results, manifest);

  console.log(`\npassed: ${units.length - failed}  failed: ${failed}  total: ${units.length}`);
  console.log(`manifest:   ${join(outDir, "manifest.json")}`);
  console.log(`statistics: ${join(outDir, "statistics.json")}`);
}

// ── replay ─────────────────────────────────────────────────────────────────

async function replay(args: string[]): Promise<void> {
  const file = flag(args, "--replay");
  if (!file) {
    usage();
    process.exit(2);
  }
  const record = JSON.parse(readFileSync(file, "utf8")) as ResultRecord;
  const adapter = EXPERIMENTS[record.experiment];
  if (!adapter) {
    console.error(`unknown experiment: ${record.experiment}`);
    process.exit(2);
  }
  const unit = record.repro?.unit;
  if (unit === undefined) {
    console.error("record has no repro.unit — cannot replay");
    process.exit(2);
  }

  console.log(`replaying ${record.experiment} unit ${record.unitId}`);
  console.log(`recorded commit: ${record.commit}  current commit: ${COMMIT}`);

  const result = adapter.runUnit(unit);
  result.commit = record.commit;

  const recordedHash = record.hashes?.stateHash;
  const replayedHash = result.hashes?.stateHash;
  const hashMatch = recordedHash !== undefined ? recordedHash === replayedHash : null;
  const passMatch = result.pass === record.pass;

  console.log(`recorded: pass=${record.pass} stateHash=${recordedHash ?? "-"}`);
  console.log(`replayed: pass=${result.pass} stateHash=${replayedHash ?? "-"}`);
  console.log(`hash match: ${hashMatch === null ? "n/a" : hashMatch}`);
  console.log(`pass match: ${passMatch}`);

  const ok = passMatch && (hashMatch === null || hashMatch === true);
  console.log(ok ? "REPLAY PASS" : "REPLAY FAIL");
  process.exit(ok ? 0 : 1);
}

// ── aggregate ──────────────────────────────────────────────────────────────

function aggregate(args: string[]): void {
  const dir = flag(args, "--aggregate");
  if (!dir) {
    usage();
    process.exit(2);
  }
  const unitsDir = join(dir, "units");
  if (!existsSync(unitsDir)) {
    console.error(`no units dir in ${dir}`);
    process.exit(2);
  }
  const files = readdirSync(unitsDir).filter((f) => f.endsWith(".json"));
  const results = files.map((f) =>
    JSON.parse(readFileSync(join(unitsDir, f), "utf8")),
  ) as ResultRecord[];
  const manifest = existsSync(join(dir, "manifest.json"))
    ? (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>)
    : { experiment: "unknown", commit: "unknown" };

  writeAggregate(dir, results, manifest);
  const stats = JSON.parse(readFileSync(join(dir, "statistics.json"), "utf8"));
  console.log(JSON.stringify(stats, null, 2));
}

// ── entry ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes("--replay")) {
  await replay(args);
} else if (args.includes("--aggregate")) {
  aggregate(args);
} else {
  await run(args);
}