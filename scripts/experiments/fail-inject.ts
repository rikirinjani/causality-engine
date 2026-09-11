/**
 * Experiment adapter: fail-inject.
 *
 * A test fixture, not a real experiment. Exists so the runner's failure path
 * can be verified with a controlled, deterministic failure: unit "boom" always
 * fails with class "injected_failure". Everything else passes.
 *
 * This validates failure capture, failure records, and failure replay without
 * needing a real invariant violation.
 */
export interface FailInjectUnit {
  experiment: "fail-inject";
  unitId: string;
  mode: "ok" | "fail";
}

export function enumerateUnits(): FailInjectUnit[] {
  return [
    { experiment: "fail-inject", unitId: "ok-1", mode: "ok" },
    { experiment: "fail-inject", unitId: "boom", mode: "fail" },
    { experiment: "fail-inject", unitId: "ok-2", mode: "ok" },
  ];
}

export function runUnit(unit: FailInjectUnit): Record<string, unknown> {
  if (unit.mode === "fail") {
    return {
      schemaVersion: 1,
      experiment: "fail-inject",
      unitId: unit.unitId,
      seed: null,
      config: {},
      scenario: { mode: "fail" },
      iteration: 0,
      pass: false,
      failure: {
        class: "injected_failure",
        message: "controlled failure for runner testing",
      },
      hashes: {},
      metrics: { durationMs: 0 },
      repro: { command: "npx tsx scripts/run-experiment.ts --replay <record>", unit },
    };
  }
  return {
    schemaVersion: 1,
    experiment: "fail-inject",
    unitId: unit.unitId,
    seed: null,
    config: {},
    scenario: { mode: "ok" },
    iteration: 0,
    pass: true,
    failure: null,
    hashes: {},
    metrics: { durationMs: 0 },
    repro: { command: "npx tsx scripts/run-experiment.ts --replay <record>", unit },
  };
}