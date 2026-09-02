/**
 * CE v1.0 — Configuration validation (product boundary).
 *
 * Invalid causal configuration must fail LOUDLY and EARLY. This module never
 * clamps, normalises, or repairs a bad config: silently fixing a threshold would
 * change causal behaviour behind the developer's back, which is exactly the class
 * of bug the frozen invariants exist to prevent.
 *
 * Validation is an ergonomics/product concern. It contains no causal logic.
 */
import { DEFAULT_CONFIG, makeConfig, type SimConfig } from "../core/config.js";
import { DOMAIN_ORDER, type DomainId } from "../core/types.js";

export interface ConfigIssue {
  field: string;
  problem: string;
  value: unknown;
}

export interface ConfigValidation {
  ok: boolean;
  errors: ConfigIssue[];
  warnings: ConfigIssue[];
}

/** Thrown by `createConfig` when validation fails. Carries every issue, not just the first. */
export class ConfigError extends Error {
  readonly issues: ConfigIssue[];
  constructor(issues: ConfigIssue[]) {
    const summary = issues.map((i) => `${i.field}: ${i.problem}`).join("; ");
    super(`invalid CE configuration — ${summary}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Numeric fields that must be finite whenever they are supplied. */
const NUMERIC_FIELDS: readonly (keyof SimConfig)[] = [
  "seed",
  "ledgerDecayPerTick",
  "capPerDomainRegionTick",
  "pressureSoftKnee",
  "capLedgerEntry",
  "ledgerFloor",
  "contestRatio",
  "maxCausalGeneration",
  "generationMateriality",
  "boundaryDecay",
  "boundaryMaxHops",
  "boundaryFloor",
  "targetStock",
  "storageCap",
  "tradeRate",
  "priceExponent",
  "priceClampMin",
  "priceClampMax",
  "convergenceEpsilon",
  "investmentMin",
  "investmentMax",
] as const;

/**
 * Validate configuration overrides without mutating them.
 *
 * Only fields the caller actually supplied are checked individually; cross-field
 * relationships are checked against the MERGED config, because a single override
 * (e.g. `priceClampMax`) can invalidate a default it must be compared against.
 */
export function validateConfig(overrides: Partial<SimConfig>): ConfigValidation {
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];
  const supplied = new Set(Object.keys(overrides));
  const has = (f: keyof SimConfig): boolean => supplied.has(f as string);

  // ---- finiteness of every supplied numeric field -------------------------
  for (const field of NUMERIC_FIELDS) {
    if (!has(field)) continue;
    const value = overrides[field];
    if (!isFiniteNumber(value)) {
      errors.push({ field: field as string, problem: "must be a finite number", value });
    }
  }

  // ---- seed ---------------------------------------------------------------
  if (has("seed")) {
    const seed = overrides.seed;
    if (isFiniteNumber(seed) && !Number.isInteger(seed)) {
      errors.push({ field: "seed", problem: "must be an integer", value: seed });
    }
  }

  // ---- thresholds (per-domain quota) --------------------------------------
  if (has("thresholds")) {
    const thresholds = overrides.thresholds;
    if (typeof thresholds !== "object" || thresholds === null) {
      errors.push({ field: "thresholds", problem: "must be an object keyed by domain", value: thresholds });
    } else {
      const partial = thresholds as Partial<Record<DomainId, number>>;
      for (const key of Object.keys(partial)) {
        if (!(DOMAIN_ORDER as readonly string[]).includes(key)) {
          errors.push({
            field: `thresholds.${key}`,
            problem: `unknown causal domain (expected one of: ${DOMAIN_ORDER.join(", ")})`,
            value: key,
          });
        }
      }
      for (const domain of DOMAIN_ORDER) {
        const value = partial[domain];
        if (value === undefined) continue;
        if (!isFiniteNumber(value)) {
          errors.push({ field: `thresholds.${domain}`, problem: "must be a finite number", value });
          continue;
        }
        if (value <= 0) {
          errors.push({ field: `thresholds.${domain}`, problem: "must be greater than 0", value });
          continue;
        }
        if (value > 2.0) {
          warnings.push({
            field: `thresholds.${domain}`,
            problem: "above 2.0 the quota may never fire for a single action",
            value,
          });
        }
      }
    }
  }

  // ---- single-field range checks -----------------------------------------
  if (has("ledgerDecayPerTick")) {
    const v = overrides.ledgerDecayPerTick;
    if (isFiniteNumber(v)) {
      if (v <= 0 || v >= 1) {
        errors.push({ field: "ledgerDecayPerTick", problem: "must be within the exclusive range (0, 1)", value: v });
      } else if (v > 0.95) {
        warnings.push({
          field: "ledgerDecayPerTick",
          problem: "above 0.95 unresolved pressure lingers for a very long time",
          value: v,
        });
      }
    }
  }

  if (has("boundaryDecay")) {
    const v = overrides.boundaryDecay;
    if (isFiniteNumber(v) && (v < 0 || v >= 1)) {
      errors.push({ field: "boundaryDecay", problem: "must be within the range [0, 1)", value: v });
    }
  }

  if (has("boundaryMaxHops")) {
    const v = overrides.boundaryMaxHops;
    if (isFiniteNumber(v)) {
      if (!Number.isInteger(v) || v < 0) {
        errors.push({ field: "boundaryMaxHops", problem: "must be a non-negative integer", value: v });
      } else if (v === 0) {
        warnings.push({
          field: "boundaryMaxHops",
          problem: "0 disables cross-region propagation entirely",
          value: v,
        });
      }
    }
  }

  if (has("boundaryFloor")) {
    const v = overrides.boundaryFloor;
    if (isFiniteNumber(v) && v < 0) {
      errors.push({ field: "boundaryFloor", problem: "must be greater than or equal to 0", value: v });
    }
  }

  if (has("contestRatio")) {
    const v = overrides.contestRatio;
    if (isFiniteNumber(v) && (v < 0 || v > 1)) {
      errors.push({ field: "contestRatio", problem: "must be within the range [0, 1]", value: v });
    }
  }

  if (has("maxCausalGeneration")) {
    const v = overrides.maxCausalGeneration;
    if (isFiniteNumber(v) && (!Number.isInteger(v) || v < 0)) {
      errors.push({ field: "maxCausalGeneration", problem: "must be a non-negative integer", value: v });
    }
  }

  if (has("generationMateriality")) {
    const v = overrides.generationMateriality;
    if (isFiniteNumber(v) && (v < 0 || v > 1)) {
      errors.push({ field: "generationMateriality", problem: "must be within the range [0, 1]", value: v });
    }
  }

  if (has("capPerDomainRegionTick")) {
    const v = overrides.capPerDomainRegionTick;
    if (isFiniteNumber(v) && v <= 0) {
      errors.push({ field: "capPerDomainRegionTick", problem: "must be greater than 0", value: v });
    }
  }

  if (has("pressureSoftKnee")) {
    const v = overrides.pressureSoftKnee;
    if (isFiniteNumber(v) && v <= 0) {
      errors.push({ field: "pressureSoftKnee", problem: "must be greater than 0", value: v });
    }
  }

  if (has("capLedgerEntry")) {
    const v = overrides.capLedgerEntry;
    if (isFiniteNumber(v) && v <= 0) {
      errors.push({ field: "capLedgerEntry", problem: "must be greater than 0", value: v });
    }
  }

  if (has("ledgerFloor")) {
    const v = overrides.ledgerFloor;
    if (isFiniteNumber(v) && v < 0) {
      errors.push({ field: "ledgerFloor", problem: "must be greater than or equal to 0", value: v });
    }
  }

  if (has("targetStock")) {
    const v = overrides.targetStock;
    if (isFiniteNumber(v) && v <= 0) {
      errors.push({ field: "targetStock", problem: "must be greater than 0", value: v });
    }
  }

  if (has("storageCap")) {
    const v = overrides.storageCap;
    if (isFiniteNumber(v) && v <= 0) {
      errors.push({ field: "storageCap", problem: "must be greater than 0", value: v });
    }
  }

  if (has("tradeRate")) {
    const v = overrides.tradeRate;
    if (isFiniteNumber(v) && v < 0) {
      errors.push({ field: "tradeRate", problem: "must be greater than or equal to 0", value: v });
    }
  }

  if (has("priceClampMin")) {
    const v = overrides.priceClampMin;
    if (isFiniteNumber(v) && v <= 0) {
      errors.push({ field: "priceClampMin", problem: "must be greater than 0", value: v });
    }
  }

  if (has("convergenceEpsilon")) {
    const v = overrides.convergenceEpsilon;
    if (isFiniteNumber(v) && v <= 0) {
      errors.push({ field: "convergenceEpsilon", problem: "must be greater than 0", value: v });
    }
  }

  // ---- cross-field checks against the merged config -----------------------
  // Resolved against the merge because one override can invalidate a default.
  if (errors.length === 0) {
    const merged = makeConfig(overrides);

    if (merged.priceClampMax <= merged.priceClampMin) {
      errors.push({
        field: "priceClampMax",
        problem: `must be greater than priceClampMin (${merged.priceClampMin})`,
        value: merged.priceClampMax,
      });
    }

    if (merged.investmentMax < merged.investmentMin) {
      errors.push({
        field: "investmentMax",
        problem: `must be greater than or equal to investmentMin (${merged.investmentMin})`,
        value: merged.investmentMax,
      });
    }

    if (merged.pressureSoftKnee > merged.capPerDomainRegionTick) {
      warnings.push({
        field: "pressureSoftKnee",
        problem: `above capPerDomainRegionTick (${merged.capPerDomainRegionTick}) the soft knee never engages`,
        value: merged.pressureSoftKnee,
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Build a validated `SimConfig`.
 *
 * Throws `ConfigError` rather than returning a partially-valid config: a game that
 * boots on a silently-corrected causal configuration would produce results the
 * developer cannot reason about.
 */
export function createConfig(overrides: Partial<SimConfig> = {}): SimConfig {
  const validation = validateConfig(overrides);
  if (!validation.ok) throw new ConfigError(validation.errors);
  return makeConfig(overrides);
}

export { DEFAULT_CONFIG };
export type { SimConfig };
