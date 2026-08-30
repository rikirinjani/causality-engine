/**
 * Convergence semantics for cyclic causality (docs/RECONNAISSANCE.md §16.2–16.4).
 *
 * A feedback loop can end in qualitatively different places, and CE must tell them apart
 * rather than reporting a number and hoping:
 *
 *   converged        — successive changes shrink below epsilon and stay there
 *   converged_at_bound — the signal is stable ONLY because it is pinned against a clamp.
 *                      Numerically indistinguishable from `converged`; causally completely
 *                      different. Reporting these as the same thing is the "plausible-looking
 *                      answer" failure the brief forbids (§10), so they are separate classes.
 *   oscillating      — the signal alternates around a level without settling
 *   diverging        — successive changes grow without bound
 *
 * Two further outcomes are NOT convergence and are never reported as such:
 *
 *   settling         — still moving, no verdict yet
 *   cutoff           — a COMPUTATIONAL bound stopped the work. A safety limit, not a
 *                      statement about the system. Always paired with a diagnostic.
 *
 * Classification is a pure function of a bounded numeric history plus an optional bound, so
 * it replays exactly.
 */

export type ConvergenceClass =
  | "settling"
  | "converged"
  | "converged_at_bound"
  | "oscillating"
  | "diverging"
  | "cutoff";

export interface SignalTrace {
  signal: string;
  /** Bounded ring of recent values, oldest first. */
  history: number[];
  classification: ConvergenceClass;
  /** Consecutive samples whose delta was below epsilon. */
  stableCount: number;
  /** Consecutive sign alternations of the delta. */
  alternations: number;
  /** Ratio of the two most recent |deltas| (growth factor); 0 when undefined. */
  growth: number;
  /** Tick at which the current classification was assigned. */
  classifiedAtTick: number;
  /** True if this signal was ever classified `diverging` before settling. */
  divergedEver: boolean;
  /** True while the latest sample sits on a configured clamp. */
  atBound: boolean;
  /**
   * True once the signal has moved materially at least once. A signal that never moved is
   * simply at its initial value; calling that "stable at a bound" would be noise. Only a
   * signal that was PUSHED into a clamp earns `converged_at_bound`.
   */
  movedEver: boolean;
}

export interface ConvergenceConfig {
  /** |delta| below this counts as "not moving". */
  epsilon: number;
  /** Consecutive stable samples required to declare convergence. */
  stableSamplesRequired: number;
  /** Consecutive alternations required to declare oscillation. */
  alternationsRequired: number;
  /** |delta| growth ratio above which the signal is treated as diverging. */
  divergenceGrowth: number;
  /** Consecutive growing samples required to declare divergence. */
  divergenceSamplesRequired: number;
  /** Ring buffer length. */
  historyWindow: number;
  /** Minimum |delta| for oscillation to count (ignores float noise flapping). */
  oscillationMinAmplitude: number;
  /** Relative tolerance for deciding a value is sitting on a bound. */
  boundTolerance: number;
}

/** Clamp limits for a tracked signal, when it has any. */
export interface SignalBounds {
  min?: number;
  max?: number;
}

export function createTrace(signal: string): SignalTrace {
  return {
    signal,
    history: [],
    classification: "settling",
    stableCount: 0,
    alternations: 0,
    growth: 0,
    classifiedAtTick: 0,
    divergedEver: false,
    atBound: false,
    movedEver: false,
  };
}

function onBound(value: number, bounds: SignalBounds | undefined, tol: number): boolean {
  if (!bounds) return false;
  const near = (limit: number) => Math.abs(value - limit) <= tol * Math.max(1, Math.abs(limit));
  if (bounds.max !== undefined && near(bounds.max)) return true;
  if (bounds.min !== undefined && near(bounds.min)) return true;
  return false;
}

/**
 * Record a sample and re-classify. Pure apart from mutating the passed trace.
 *
 * Precedence is deliberate: divergence outranks oscillation outranks convergence. A diverging
 * signal that happens to alternate sign is still diverging, and that is the more dangerous
 * fact. Stability observed while pinned to a clamp is reported as `converged_at_bound`.
 */
export function observeSignal(
  trace: SignalTrace,
  value: number,
  tick: number,
  cfg: ConvergenceConfig,
  bounds?: SignalBounds,
): SignalTrace {
  const prev = trace.history.length > 0 ? trace.history[trace.history.length - 1]! : undefined;
  const prevPrev = trace.history.length > 1 ? trace.history[trace.history.length - 2]! : undefined;

  trace.history.push(value);
  if (trace.history.length > cfg.historyWindow) {
    trace.history.splice(0, trace.history.length - cfg.historyWindow);
  }
  trace.atBound = onBound(value, bounds, cfg.boundTolerance);

  if (prev === undefined) return trace;

  const delta = value - prev;
  const prevDelta = prevPrev !== undefined ? prev - prevPrev : undefined;

  // --- stability ---
  if (Math.abs(delta) <= cfg.epsilon) {
    trace.stableCount += 1;
    trace.alternations = 0;
  } else {
    trace.stableCount = 0;
    trace.movedEver = true;
  }

  // --- alternation (sign flip with meaningful amplitude) ---
  if (
    prevDelta !== undefined &&
    Math.abs(delta) > cfg.oscillationMinAmplitude &&
    Math.abs(prevDelta) > cfg.oscillationMinAmplitude &&
    Math.sign(delta) !== 0 &&
    Math.sign(prevDelta) !== 0 &&
    Math.sign(delta) !== Math.sign(prevDelta)
  ) {
    trace.alternations += 1;
  } else if (Math.abs(delta) > cfg.epsilon) {
    trace.alternations = 0;
  }

  // --- growth ---
  if (prevDelta !== undefined && Math.abs(prevDelta) > cfg.epsilon) {
    trace.growth = Math.abs(delta) / Math.abs(prevDelta);
  } else {
    trace.growth = 0;
  }

  // --- classification, highest severity first ---
  if (trace.growth >= cfg.divergenceGrowth && Math.abs(delta) > cfg.epsilon) {
    if (countGrowingRun(trace.history, cfg) >= cfg.divergenceSamplesRequired) {
      trace.classification = "diverging";
      trace.divergedEver = true;
      trace.classifiedAtTick = tick;
      return trace;
    }
  }
  if (trace.alternations >= cfg.alternationsRequired) {
    trace.classification = "oscillating";
    trace.classifiedAtTick = tick;
    return trace;
  }
  if (trace.stableCount >= cfg.stableSamplesRequired) {
    // Stable AT A CLAMP is not the same statement as stable because the dynamics settled.
    // A signal that never moved is just sitting at its initial value, which may coincide
    // with a bound — that is not "pinned", so it does not earn the distinction.
    trace.classification = trace.atBound && trace.movedEver ? "converged_at_bound" : "converged";
    trace.classifiedAtTick = tick;
    return trace;
  }

  // Leave a terminal verdict in place unless the signal starts moving again.
  const settledClasses: ConvergenceClass[] = ["converged", "converged_at_bound"];
  if (settledClasses.includes(trace.classification) && Math.abs(delta) > cfg.epsilon) {
    trace.classification = "settling";
    trace.classifiedAtTick = tick;
  } else if (trace.classification === "oscillating" && trace.stableCount > 0) {
    trace.classification = "settling";
    trace.classifiedAtTick = tick;
  } else if (trace.classification === "settling") {
    trace.classifiedAtTick = tick;
  }
  return trace;
}

/** How many trailing samples had strictly growing |delta|. */
function countGrowingRun(history: number[], cfg: ConvergenceConfig): number {
  const deltas: number[] = [];
  for (let i = 1; i < history.length; i++) deltas.push(Math.abs(history[i]! - history[i - 1]!));
  let run = 0;
  for (let i = deltas.length - 1; i > 0; i--) {
    const a = deltas[i]!;
    const b = deltas[i - 1]!;
    if (b > cfg.epsilon && a / b >= cfg.divergenceGrowth) run += 1;
    else break;
  }
  return run + 1; // the current sample participates
}

/** Mark a trace as computationally cut off. Never conflated with "converged". */
export function markCutoff(trace: SignalTrace, tick: number): SignalTrace {
  trace.classification = "cutoff";
  trace.classifiedAtTick = tick;
  return trace;
}

/** True when a classification is a real statement about the system, not a safety stop. */
export function isSemanticVerdict(c: ConvergenceClass): boolean {
  return c === "converged" || c === "converged_at_bound" || c === "oscillating" || c === "diverging";
}

/** True when the signal genuinely settled on its own dynamics (not against a clamp). */
export function isTrueConvergence(c: ConvergenceClass): boolean {
  return c === "converged";
}
