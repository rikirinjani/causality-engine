/**
 * CE experiment runner — worker process.
 *
 * Reads unit JSON lines from stdin, executes each through the experiment
 * adapter, and writes one result JSON line per unit to stdout.
 *
 * The worker is persistent: the orchestrator spawns N of these and streams
 * units to them, so tsx startup cost is paid once per worker, not per unit.
 *
 * Protocol:
 *   stdin:  one JSON unit per line
 *   stdout: one JSON result per line
 *   stderr: inherited (logs)
 */
import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPERIMENTS } from "./experiments/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;

  let unit: { experiment: string; unitId: string; [k: string]: unknown };
  try {
    unit = JSON.parse(line);
  } catch {
    process.stdout.write(
      JSON.stringify({ error: "bad unit json", raw: line.slice(0, 200) }) + "\n",
    );
    return;
  }

  const adapter = EXPERIMENTS[unit.experiment];
  if (!adapter) {
    process.stdout.write(
      JSON.stringify({ error: `unknown experiment: ${unit.experiment}` }) + "\n",
    );
    return;
  }

  try {
    const result = adapter.runUnit(unit);
    result.commit = result.commit ?? COMMIT;
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (err) {
    // A thrown error is a worker-level failure, recorded so the orchestrator
    // can preserve it as a failure record rather than losing the unit.
    process.stdout.write(
      JSON.stringify({
        schemaVersion: 1,
        experiment: unit.experiment,
        unitId: unit.unitId,
        commit: COMMIT,
        seed: unit.seed ?? null,
        config: {},
        scenario: {},
        iteration: 0,
        pass: false,
        failure: {
          class: "worker_error",
          message: err instanceof Error ? err.message : String(err),
          detail: err instanceof Error ? err.stack : undefined,
        },
        hashes: {},
        metrics: {},
        repro: { command: "", unit },
      }) + "\n",
    );
  }
});