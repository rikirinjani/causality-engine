/**
 * CE v1.0 — Intervention ergonomics (product boundary).
 *
 * Building an `Intervention` by hand requires seven fields, two of which
 * (`provenance`, `tick`) are engine bookkeeping the developer should never have to
 * think about. This module reduces that to an action, a target, and a location.
 *
 * ERGONOMICS ONLY. `causalDomains` is always emitted EMPTY: causal pressure is
 * authored exclusively by the engine's ACTION_SCHEMAS. If this builder ever
 * populated `causalDomains`, causal physics would have leaked out of the engine
 * and into the product layer — which would violate the frozen invariant that CE
 * is the sole causal authority.
 */
import type { Intervention } from "../core/types.js";
import { describeAction, isActionAvailable, listActions, type TargetKind } from "./catalog.js";
import { apply, type ApplyResult, type CausalRuntime } from "./runtime.js";

export interface InterventionSpec {
  /** Action name from the catalog (see `listActions()`). */
  action: string;
  target: { type: TargetKind; id: string };
  /** Region the action happens in. Defaults to `target.id`. */
  location?: string;
  /** Who performed it. Default "player". */
  actor?: string;
  /** Normalised strength in [0, 1]. Default 1.0. */
  magnitude?: number;
  /** Optional free-text intent, carried through for auditing. */
  intent?: string;
}

export type BuildResult =
  | { ok: true; intervention: Intervention }
  | { ok: false; errors: string[] };

/**
 * Check a spec against the engine's action contract without touching the world.
 *
 * Reports every problem at once so a developer fixes one call, not four.
 */
export function validateInterventionSpec(spec: InterventionSpec): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof spec.action !== "string" || spec.action.length === 0) {
    errors.push("action must be a non-empty string");
  } else if (!isActionAvailable(spec.action)) {
    const available = listActions()
      .map((a) => a.action)
      .join(", ");
    errors.push(`unknown action "${spec.action}" (available: ${available})`);
  }

  if (typeof spec.target !== "object" || spec.target === null) {
    errors.push("target must be an object of the form { type, id }");
  } else {
    if (typeof spec.target.id !== "string" || spec.target.id.length === 0) {
      errors.push("target.id must be a non-empty string");
    }
    const info = describeAction(spec.action);
    if (info !== undefined && !info.allowedTargets.includes(spec.target.type)) {
      errors.push(
        `action "${spec.action}" cannot target "${spec.target.type}" (allowed: ${info.allowedTargets.join(", ")})`,
      );
    }
  }

  const info = describeAction(spec.action);
  if (info !== undefined && info.locationMustEqualTarget) {
    const location = spec.location ?? spec.target?.id;
    if (location !== spec.target?.id) {
      errors.push(
        `action "${spec.action}" requires location to equal target.id (got location="${String(location)}", target.id="${String(spec.target?.id)}")`,
      );
    }
  }

  if (spec.magnitude !== undefined) {
    const m = spec.magnitude;
    if (typeof m !== "number" || !Number.isFinite(m)) {
      errors.push("magnitude must be a finite number");
    } else if (m < 0 || m > 1) {
      errors.push(`magnitude must be within [0, 1] (got ${m})`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Build a well-formed `Intervention` from a minimal spec.
 *
 * The id is derived from actor + tick + action + sequence, so it is deterministic
 * (no counters, no wall-clock) and unique within a timeline.
 */
export function buildIntervention(rt: CausalRuntime, spec: InterventionSpec): BuildResult {
  const validation = validateInterventionSpec(spec);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const actor = spec.actor ?? "player";
  const tick = rt.world.tick;
  const sequence = rt.world.interventionSeq;

  const intervention: Intervention = {
    id: `${actor}-${tick}-${spec.action}-${sequence}`,
    tick,
    actor,
    action: spec.action,
    target: { type: spec.target.type, id: spec.target.id },
    location: spec.location ?? spec.target.id,
    magnitude: spec.magnitude ?? 1.0,
    // ALWAYS EMPTY. Causal contributions are authored by the engine's
    // ACTION_SCHEMAS registry. The product layer must never author causal pressure.
    causalDomains: [],
    provenance: { submittedAtTick: tick, sequence },
  };

  if (spec.intent !== undefined) intervention.intent = spec.intent;

  return { ok: true, intervention };
}

/**
 * Build and submit in one call — the common case for a game.
 *
 * A build failure returns `ok: false` with the validation errors and leaves the
 * world's intervention sequence untouched.
 */
export function intervene(rt: CausalRuntime, spec: InterventionSpec): ApplyResult {
  const built = buildIntervention(rt, spec);
  if (!built.ok) {
    return { ok: false, errors: built.errors, interventionSeq: rt.world.interventionSeq };
  }
  return apply(rt, built.intervention);
}
