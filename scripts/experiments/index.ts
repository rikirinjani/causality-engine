/**
 * Experiment adapter registry.
 *
 * Each adapter exports:
 *   enumerateUnits(): Array<{ experiment: string; unitId: string; ... }>
 *   runUnit(unit): ResultRecord (without commit — the caller stamps it)
 *
 * Adding an experiment = add a file here and register it. No runner changes.
 */
import * as causalMatrix from "./causal-matrix.js";
import * as failInject from "./fail-inject.js";

export interface ExperimentAdapter {
  enumerateUnits(): Array<{ experiment: string; unitId: string; [k: string]: unknown }>;
  runUnit(unit: never): Record<string, unknown>;
}

export const EXPERIMENTS: Record<string, ExperimentAdapter> = {
  "causal-matrix": causalMatrix as unknown as ExperimentAdapter,
  "fail-inject": failInject as unknown as ExperimentAdapter,
};