/**
 * CE v1.0 — Causal explanation (product boundary).
 *
 * Answers "why did this happen?" for any CE-tracked quantity.
 *
 * The answer comes entirely from CE's own provenance DAG. Nothing here computes,
 * infers, or guesses causality — that authority stays in the engine. This module
 * reshapes `explain()` into a flatter view and exposes the quantity-key helpers
 * so a developer can name a quantity without memorising string formats.
 */
import { explain, key } from "../core/provenance.js";
import type { WorldState } from "../core/types.js";
import type { CausalRuntime } from "./runtime.js";

export interface RootAction {
  interventionId: string;
  action: string;
  /** Region the originating action was performed in. */
  location: string;
  /** What the action targeted. */
  targetId: string;
  tick: number;
}

export interface CauseView {
  /** The quantity that was asked about. */
  quantity: string;
  /** Whether any cause was found at all. */
  explained: boolean;
  /**
   * True when the trace may be missing ancestors, because the bounded provenance
   * record evicted them. An incomplete explanation announces itself rather than
   * masquerading as a complete one.
   */
  incomplete: boolean;
  /** Distinct originating actions, deduped and stably ordered. */
  rootActions: RootAction[];
  /** Ancestor label chains from the queried quantity to each root. */
  chains: string[][];
}

function worldOf(source: CausalRuntime | WorldState): WorldState {
  return "world" in source ? source.world : source;
}

/**
 * Ask CE why a quantity has its current value.
 *
 * Use the `quantity` helpers to name the target, e.g.
 * `why(rt, quantity.price("RF", "grain"))`.
 */
export function why(source: CausalRuntime | WorldState, quantityKey: string): CauseView {
  const world = worldOf(source);
  const explanation = explain(world, quantityKey);

  // Dedupe by intervention id: one action reached through several paths is still
  // one cause. Sort by (tick, interventionId) for stable, replayable output.
  const byId = new Map<string, RootAction>();
  for (const root of explanation.roots) {
    if (byId.has(root.interventionId)) continue;
    byId.set(root.interventionId, {
      interventionId: root.interventionId,
      action: root.action,
      location: root.location,
      targetId: root.targetId,
      tick: root.tick,
    });
  }

  const rootActions = [...byId.values()].sort((a, b) =>
    a.tick !== b.tick ? a.tick - b.tick : a.interventionId.localeCompare(b.interventionId),
  );

  return {
    quantity: explanation.target,
    explained: explanation.explained,
    incomplete: explanation.incomplete,
    rootActions,
    chains: explanation.paths,
  };
}

/**
 * Quantity key helpers — how to name what you want explained.
 *
 * Re-exported from the engine so producers and queries cannot drift apart.
 * Examples: `quantity.price("RF", "grain")`, `quantity.hostility("MG")`,
 * `quantity.infra("RF", "grain_road")`, `quantity.unrest("RF")`.
 */
export { key as quantity };
