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
import * as adversarial from "./adversarial.js";
import * as provenanceEviction from "./provenance-eviction.js";
import * as multiWorldIsolation from "./multi-world-isolation.js";

export interface ExperimentAdapter {
  enumerateUnits(): Array<{ experiment: string; unitId: string; [k: string]: unknown }>;
  runUnit(unit: never): Record<string, unknown>;
}

export const EXPERIMENTS: Record<string, ExperimentAdapter> = {
  "causal-matrix": causalMatrix as unknown as ExperimentAdapter,
  "fail-inject": failInject as unknown as ExperimentAdapter,
  adversarial: adversarial as unknown as ExperimentAdapter,
  "provenance-eviction": provenanceEviction as unknown as ExperimentAdapter,
  "multi-world-isolation": multiWorldIsolation as unknown as ExperimentAdapter,
};