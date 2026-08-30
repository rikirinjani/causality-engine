import type { WorldState } from "./types.js";

/**
 * World schema versioning (docs/RECONNAISSANCE.md §18.11).
 *
 * The version describes the SHAPE of `WorldState`, not the simulation's meaning. Bumping it
 * is a statement about serialization layout; it must never be a statement about physics.
 *
 * History of real changes (these are not invented examples — each was an actual restructuring):
 *
 *   v3  feedback/convergence pass: added dynamics + diagnostics; pressure gained valence.
 *   v4  same pass, later: PendingEntry gained `items` for canonical summation.
 *   v5  persistence pass: `universe` (Kronos-inherited) REPLACED by `lineage`;
 *       `interventionHistory` and `historyTruncated` added.
 *   v6  lifecycle pass: provenance ids moved OUT of PendingEntry into `pendingCauses`,
 *       because ids inside a hashed bucket made a physically identical world hash
 *       differently once compaction renumbered them.
 *   v7  retention pass: events gained `streamSeq` (a stable stream coordinate) and the world
 *       gained `highestEmittedSeq` / `oldestRetainedSeq` / `evictedCount`, because cursors were
 *       array positions into a derived stream and silently repositioned on eviction.
 */
export const CURRENT_SCHEMA_VERSION = 7;

/** Oldest version any migration path can start from. */
export const MIN_MIGRATABLE_SCHEMA_VERSION = 5;

/**
 * What a migrated world can honestly claim about its own history.
 *
 * `exact`      — nothing was lost or invented.
 * `incomplete` — required information did not exist in the source schema and was NOT
 *                fabricated. Consumers must treat explanations as partial.
 */
export type HistoryCompleteness = "exact" | "incomplete";

export interface MigrationNote {
  fromVersion: number;
  toVersion: number;
  /** Machine-readable description of what the step did. Never prose for the engine to parse. */
  change: string;
  /** True if the step could not recover information the target schema expects. */
  lossy: boolean;
  detail?: Record<string, string | number | boolean>;
}

export interface MigrationOutcome {
  world: WorldState;
  /** Versions traversed, oldest first. */
  path: number[];
  notes: MigrationNote[];
  completeness: HistoryCompleteness;
}

export type MigrationErrorCode =
  | "unknown_schema_version"
  | "schema_too_old"
  | "schema_from_future"
  | "migration_step_missing"
  | "migration_precondition_failed";

export interface MigrationError {
  code: MigrationErrorCode;
  message: string;
  detail?: Record<string, string | number | boolean>;
}

export type MigrationResult =
  | { ok: true; value: MigrationOutcome }
  | { ok: false; errors: MigrationError[] };

/** One migration step. Steps are pure and operate on a loosely-typed bag. */
interface MigrationStep {
  from: number;
  to: number;
  apply(raw: Record<string, unknown>): { raw: Record<string, unknown>; note: MigrationNote };
}

/**
 * v5 -> v6: provenance ids move out of pending buckets into `pendingCauses`.
 *
 * This is LOSSLESS and can be done honestly: the ids exist in the v5 payload, they just live
 * in the wrong place. The step relocates them rather than inventing anything.
 */
const step5to6: MigrationStep = {
  from: 5,
  to: 6,
  apply(raw) {
    const pending = (raw.pendingContributions ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
    const pendingCauses: Record<string, string[]> = {};
    let relocated = 0;

    for (const [regionId, buckets] of Object.entries(pending)) {
      if (buckets === null || typeof buckets !== "object") continue;
      for (const [domain, entry] of Object.entries(buckets)) {
        if (entry === null || typeof entry !== "object") continue;
        const causes = entry.causes;
        if (Array.isArray(causes) && causes.length > 0) {
          pendingCauses[`${regionId}:${domain}`] = [...(causes as string[])].sort();
          relocated += causes.length;
        }
        delete entry.causes;
        // items also carried a `cause` field in v5
        const items = entry.items;
        if (Array.isArray(items)) {
          entry.items = (items as Array<Record<string, unknown>>).map((it) => {
            const { cause, ...rest } = it;
            void cause;
            return rest;
          });
        }
      }
    }

    return {
      raw: { ...raw, pendingCauses, schemaVersion: 6 },
      note: {
        fromVersion: 5,
        toVersion: 6,
        change: "relocate_pending_cause_ids",
        lossy: false,
        detail: { relocatedCauseIds: relocated },
      },
    };
  },
};

/**
 * v6 -> v7: assign stream coordinates and a retention boundary.
 *
 * This step is **LOSSY, and says so.** A v6 payload has no `streamSeq` anywhere and no record of
 * how many events were ever emitted or evicted. Sequences can be assigned to the RETAINED events
 * in canonical order, which is enough to resume delivery — but the count of events already
 * evicted is simply not in the data.
 *
 * The honest consequence: `oldestRetainedSeq` is set to 1, which asserts "nothing was evicted".
 * If the v6 world had in fact evicted events, that assertion is wrong in the SAFE direction —
 * a consumer with an old cursor is told `deliverable` rather than `gap`. Manufacturing a
 * plausible `evictedCount` would be fabricating history, so instead the step marks the result
 * `lossy` and sets `historyTruncated`, which propagates into `traceHash` and into every
 * checkpoint made afterwards. A migrated world therefore announces that its causal record is
 * not trustworthy, rather than quietly claiming a clean boundary.
 */
const step6to7: MigrationStep = {
  from: 6,
  to: 7,
  apply(raw) {
    const events = Array.isArray(raw.events) ? (raw.events as Array<Record<string, unknown>>) : [];

    // Canonical order for assignment: (tick, ordinal). Both already exist in v6 and are
    // deterministic, so the same v6 payload always migrates to the same coordinates.
    const ordered = [...events].sort((a, b) => {
      const ta = Number(a.tick ?? 0);
      const tb = Number(b.tick ?? 0);
      if (ta !== tb) return ta - tb;
      return Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0);
    });
    const seqById = new Map<unknown, number>();
    ordered.forEach((e, i) => seqById.set(e.id, i + 1));

    const withSeq = events.map((e) => ({ ...e, streamSeq: seqById.get(e.id) ?? 0 }));
    const highestEmittedSeq = ordered.length;

    return {
      raw: {
        ...raw,
        events: withSeq,
        highestEmittedSeq,
        oldestRetainedSeq: 1,
        evictedCount: 0,
        schemaVersion: 7,
      },
      note: {
        fromVersion: 6,
        toVersion: 7,
        change: "assign_stream_coordinates",
        lossy: true,
        detail: {
          assignedSequences: withSeq.length,
          highestEmittedSeq,
          note: "pre-migration eviction count is unrecoverable; boundary assumes nothing was evicted",
        },
      },
    };
  },
};

const STEPS: MigrationStep[] = [step5to6, step6to7];

/**
 * Migrate a raw world payload to the current schema.
 *
 * ORDER MATTERS: migration runs BEFORE integrity validation, because an old payload's hashes
 * were computed over the old shape and cannot match a current recomputation. Validation of the
 * migrated result is the caller's job, and hashes are RE-DERIVED after migration rather than
 * carried over — a hash is a claim about a representation, so it must be recomputed when the
 * representation changes (§18.14).
 *
 * NEVER BEST-EFFORT. An unknown or too-old version is refused outright; a step that cannot
 * recover required information marks the result `incomplete` instead of fabricating it.
 */
export function migrateWorld(raw: unknown): MigrationResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: [{ code: "unknown_schema_version", message: "payload is not an object" }] };
  }
  const bag = { ...(raw as Record<string, unknown>) };
  const version = bag.schemaVersion;

  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return {
      ok: false,
      errors: [
        { code: "unknown_schema_version", message: "schemaVersion is missing or not a positive integer", detail: { got: String(version) } },
      ],
    };
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        {
          code: "schema_from_future",
          message: "payload was written by a newer CE and cannot be downgraded",
          detail: { got: version, current: CURRENT_SCHEMA_VERSION },
        },
      ],
    };
  }
  if (version < MIN_MIGRATABLE_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        {
          code: "schema_too_old",
          message: "no migration path exists from this schema version",
          detail: { got: version, oldestSupported: MIN_MIGRATABLE_SCHEMA_VERSION },
        },
      ],
    };
  }

  const path: number[] = [version];
  const notes: MigrationNote[] = [];
  let current = bag;
  let at = version;

  while (at < CURRENT_SCHEMA_VERSION) {
    const step = STEPS.find((s) => s.from === at);
    if (!step) {
      return {
        ok: false,
        errors: [
          {
            code: "migration_step_missing",
            message: "no migration step registered for this version",
            detail: { from: at, target: CURRENT_SCHEMA_VERSION },
          },
        ],
      };
    }
    const result = step.apply(current);
    current = result.raw;
    notes.push(result.note);
    at = step.to;
    path.push(at);
  }

  const completeness: HistoryCompleteness = notes.some((n) => n.lossy) ? "incomplete" : "exact";
  const world = current as unknown as WorldState;

  // A lossy migration must be visible in the world itself, not only in the return value:
  // downstream code asks the world whether its history is trustworthy.
  if (completeness === "incomplete") world.historyTruncated = true;

  return { ok: true, value: { world, path, notes, completeness } };
}
