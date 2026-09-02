/**
 * CE v1.0 — Intervention catalog (product boundary).
 *
 * Makes the intervention vocabulary DISCOVERABLE without reading engine source.
 *
 * This is a description of the public contract, not a second implementation of
 * causal rules. Every entry is derived from the engine's own `ACTION_SCHEMAS`
 * registry — the catalog reports what the engine accepts, it never decides it.
 * Causal pressure is computed exclusively by the engine's schemas.
 */
import { ACTION_SCHEMAS } from "../game/interventions.js";

export type TargetKind = "infrastructure" | "entity" | "region";

export interface ActionInfo {
  action: string;
  allowedTargets: readonly TargetKind[];
  /**
   * True when the engine requires `target.id === location`.
   * Region-scoped actions act on the region they are performed in.
   */
  locationMustEqualTarget: boolean;
  summary: string;
}

/**
 * Developer-facing summaries and the location constraint each schema enforces.
 *
 * The constraint is not machine-readable from `ActionSchema` (it lives inside
 * `immediateEffects` as a guard), so it is recorded here as documentation of the
 * engine's existing behaviour. Verified against `src/game/interventions.ts`.
 */
const ACTION_DOCS: Record<string, { locationMustEqualTarget: boolean; summary: string }> = {
  destroy_infrastructure: {
    locationMustEqualTarget: false,
    summary:
      "Destroy a structure (trade route, warehouse, shrine). Disables it and destroys any stored reserve. Rejected if the structure is already destroyed.",
  },
  kill_entity: {
    locationMustEqualTarget: false,
    summary:
      "Remove an agent from the world. The entity must currently be located in the given location. Raises faction and civic pressure.",
  },
  hold_public_rally: {
    locationMustEqualTarget: true,
    summary:
      "Hold a rally in a region. Purely civic: raises unrest pressure with no economic or ecological pathway. Target must equal location.",
  },
  grant_merchant_subsidy: {
    locationMustEqualTarget: true,
    summary:
      "Grant a merchant subsidy. Restocks a surviving granary and boosts trade investment; applies relieving pressure. Target must equal location.",
  },
};

function toInfo(action: string): ActionInfo {
  const schema = ACTION_SCHEMAS[action]!;
  const docs = ACTION_DOCS[action];
  return {
    action,
    allowedTargets: [...schema.allowedTargets] as readonly TargetKind[],
    locationMustEqualTarget: docs?.locationMustEqualTarget ?? false,
    summary: docs?.summary ?? "No summary available for this action.",
  };
}

/** Every action the engine currently accepts, sorted by name. */
export function listActions(): ActionInfo[] {
  return Object.keys(ACTION_SCHEMAS)
    .sort()
    .map((action) => toInfo(action));
}

/** Describe one action, or `undefined` when the engine does not know it. */
export function describeAction(action: string): ActionInfo | undefined {
  if (!Object.prototype.hasOwnProperty.call(ACTION_SCHEMAS, action)) return undefined;
  return toInfo(action);
}

/** Whether the engine accepts this action name. */
export function isActionAvailable(action: string): boolean {
  return Object.prototype.hasOwnProperty.call(ACTION_SCHEMAS, action);
}
