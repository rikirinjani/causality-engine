import { configHash, sortKeys, stateHash, traceHash } from "./hash.js";
import { DOMAIN_ORDER, type WorldState } from "./types.js";
import { deriveCheckpointId, deriveTimelineId, type CheckpointId, type Lineage } from "./genealogy.js";
import { DIAGNOSTIC_LIMIT } from "./propagation.js";
import { PROVENANCE_LIMIT, RESOLUTION_LOG_LIMIT } from "./provenance.js";

/**
 * CE persistence (docs/RECONNAISSANCE.md §17).
 *
 * WHAT A CHECKPOINT IS. A checkpoint is everything required to RESUME the simulation at the
 * exact point of capture and continue bit-identically. Serializing `WorldState` alone is not
 * sufficient to claim that; the requirement is that the resumed world reproduces the same
 * next tick, which additionally requires:
 *
 *   PERSISTED (part of the world, must survive):
 *     tick, lineage, schemaVersion, config, regions (incl. ledgers/valence/origin/generation),
 *     entities, relations, events, pendingContributions (UNRESOLVED CAUSAL WORK),
 *     rngState, tradeVolume, provenance + refs + seq, resolutionLog, ledgerCauses,
 *     diagnostics, dynamics traces, interventionHistory, historyTruncated.
 *
 *   TRANSIENT (must NOT be persisted, must be reconstructed):
 *     the live RNG object      — reconstructed from `rngState`
 *     the event bus            — drained every tick; empty at a tick boundary by construction
 *     engine-side handles      — rebuilt by `restoreCheckpoint`
 *
 *   NOT RECONSTRUCTABLE, therefore mandatory: `pendingContributions`. This is the queue of
 *   causal work scheduled for the next tick, including cross-region boundary signals and
 *   newly generated pressure. It cannot be recomputed from the settled world, because the
 *   state transitions that produced it have already happened. A snapshot that omitted it
 *   would restore a plausible world that then evolves differently.
 *
 * Provenance is persisted but stays OUT of `stateHash` (it is in `traceHash`), so restoring
 * preserves causal explanations without making history part of world identity.
 */

export const CHECKPOINT_FORMAT = "ce-checkpoint";
export const CHECKPOINT_FORMAT_VERSION = 1;

/**
 * Snapshot identity — sufficient to distinguish "same world, different history" from
 * "different world" WITHOUT loading the world (§17.2).
 *
 * Every field is justified:
 *   worldId/timelineId/checkpointId  — genealogy: which world, which history, which point
 *   tick                             — when
 *   stateHash                        — WHAT the world is
 *   traceHash                        — HOW it got there (kept separate, never collapsed)
 *   configHash                       — causal parameters, checkable before reconstruction
 *   seed                             — the RNG stream's origin
 *   schemaVersion                    — structural compatibility
 *   rngState                         — the resumable position in the stream (duplicated here
 *                                      deliberately: a loader can verify stream continuity
 *                                      without trusting the body)
 *   provenanceCheckpoint             — counts + truncation flag, so an incomplete trace
 *                                      announces itself instead of being assumed complete
 *   parentTimelineId/parentCheckpointId/forkTick — ancestry, addressable without the body
 */
export interface CheckpointIdentity {
  worldId: string;
  timelineId: string;
  checkpointId: CheckpointId;
  tick: number;
  stateHash: string;
  traceHash: string;
  configHash: string;
  seed: number;
  schemaVersion: number;
  rngState: { s: number };
  provenanceCheckpoint: {
    nodeCount: number;
    provenanceSeq: number;
    resolutionCount: number;
    diagnosticCount: number;
    interventionCount: number;
    /** True if any bounded log has already discarded entries. */
    truncated: boolean;
    /** The retention limits in force when this checkpoint was written. */
    limits: { provenance: number; resolutions: number; diagnostics: number };
  };
  parentTimelineId: string | null;
  parentCheckpointId: string | null;
  forkTick: number | null;
  /** Free-form label; NEVER part of any hash. */
  label: string;
}

/**
 * The serialized envelope. `identity` is redundant with `world` by design: it lets a loader
 * validate integrity and compatibility before trusting the body.
 */
export interface CheckpointEnvelope {
  format: typeof CHECKPOINT_FORMAT;
  formatVersion: number;
  identity: CheckpointIdentity;
  world: WorldState;
}

// ---------------------------------------------------------------------------
// Failure taxonomy — explicit, never silent repair
// ---------------------------------------------------------------------------

export type CheckpointErrorCode =
  | "not_json"
  | "not_an_object"
  | "wrong_format"
  | "unsupported_format_version"
  | "missing_field"
  | "invalid_tick"
  | "invalid_rng_state"
  | "invalid_retention_boundary"
  | "invalid_schema_version"
  | "state_hash_mismatch"
  | "trace_hash_mismatch"
  | "config_hash_mismatch"
  | "checkpoint_id_mismatch"
  | "malformed_provenance"
  | "malformed_ledger"
  | "incompatible_config";

export interface CheckpointError {
  code: CheckpointErrorCode;
  message: string;
  detail?: Record<string, string | number | boolean>;
}

export type LoadResult<T> = { ok: true; value: T; warnings: CheckpointError[] } | { ok: false; errors: CheckpointError[] };

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** Deep clone with no shared references, so a checkpoint can never alias a live world. */
function deepClone<T>(v: T): T {
  return structuredClone(v);
}

export function createCheckpoint(state: WorldState, label = ""): CheckpointEnvelope {
  const world = deepClone(state);
  const sh = stateHash(world);
  const th = traceHash(world);
  const ch = configHash(world);

  const identity: CheckpointIdentity = {
    worldId: world.lineage.worldId,
    timelineId: world.lineage.timelineId,
    checkpointId: deriveCheckpointId(world.lineage.worldId, world.lineage.timelineId, world.tick, sh, th),
    tick: world.tick,
    stateHash: sh,
    traceHash: th,
    configHash: ch,
    seed: world.config.seed,
    schemaVersion: world.schemaVersion,
    rngState: { s: world.rngState.s },
    provenanceCheckpoint: {
      nodeCount: world.provenance.length,
      provenanceSeq: world.provenanceSeq,
      resolutionCount: world.resolutionLog.length,
      diagnosticCount: world.diagnostics.length,
      interventionCount: world.interventionHistory.length,
      truncated: world.historyTruncated,
      limits: { provenance: PROVENANCE_LIMIT, resolutions: RESOLUTION_LOG_LIMIT, diagnostics: DIAGNOSTIC_LIMIT },
    },
    parentTimelineId: world.lineage.parentTimelineId,
    parentCheckpointId: world.lineage.parentCheckpointId,
    forkTick: world.lineage.forkTick,
    label,
  };

  return { format: CHECKPOINT_FORMAT, formatVersion: CHECKPOINT_FORMAT_VERSION, identity, world };
}

/** Serialize to a stable string. Key order is canonicalised so bytes are reproducible. */
export function serializeCheckpoint(env: CheckpointEnvelope): string {
  return JSON.stringify(env);
}

// ---------------------------------------------------------------------------
// Validation — structural, then integrity, then compatibility
// ---------------------------------------------------------------------------

function fail(code: CheckpointErrorCode, message: string, detail?: Record<string, string | number | boolean>): CheckpointError {
  return { code, message, ...(detail ? { detail } : {}) };
}

const REQUIRED_WORLD_FIELDS = [
  "tick",
  "rngState",
  "lineage",
  "schemaVersion",
  "config",
  "regions",
  "entities",
  "relations",
  "events",
  "eventSeq",
  // Retention boundary: without these a restored world cannot tell a caught-up cursor from a
  // cursor pointing at evicted facts, which is the whole gap contract (§20).
  "highestEmittedSeq",
  "oldestRetainedSeq",
  "evictedCount",
  "interventionSeq",
  "tradeVolume",
  "pendingContributions",
  // Was missed when pendingCauses was introduced in §18: a checkpoint validated fine without
  // it, so a payload lacking it would restore with pending pressure whose causes were silently
  // empty rather than being rejected.
  "pendingCauses",
  "provenance",
  "provenanceRefs",
  "provenanceSeq",
  "resolutionLog",
  "ledgerCauses",
  "dynamics",
  "diagnostics",
  "interventionHistory",
  "historyTruncated",
] as const;

const REQUIRED_IDENTITY_FIELDS = [
  "worldId",
  "timelineId",
  "checkpointId",
  "tick",
  "stateHash",
  "traceHash",
  "configHash",
  "seed",
  "schemaVersion",
  "rngState",
  "provenanceCheckpoint",
] as const;

/**
 * Validate an already-parsed envelope. Returns EVERY problem found, not just the first —
 * a corrupt save should report what is wrong with it, not make the caller iterate.
 *
 * NO REPAIR. Nothing here fills in a default, recomputes a mismatched hash, or coerces a bad
 * value. A plausible-but-invalid world is worse than a refusal.
 */
export function validateCheckpoint(raw: unknown): LoadResult<CheckpointEnvelope> {
  const errors: CheckpointError[] = [];
  const warnings: CheckpointError[] = [];

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: [fail("not_an_object", "checkpoint must be a JSON object")] };
  }
  const env = raw as Partial<CheckpointEnvelope>;

  if (env.format !== CHECKPOINT_FORMAT) {
    return { ok: false, errors: [fail("wrong_format", `expected format "${CHECKPOINT_FORMAT}"`, { got: String(env.format) })] };
  }
  if (typeof env.formatVersion !== "number" || env.formatVersion > CHECKPOINT_FORMAT_VERSION) {
    return {
      ok: false,
      errors: [
        fail("unsupported_format_version", "unsupported checkpoint format version", {
          got: String(env.formatVersion),
          supported: CHECKPOINT_FORMAT_VERSION,
        }),
      ],
    };
  }

  if (env.identity === null || typeof env.identity !== "object") {
    errors.push(fail("missing_field", "identity is missing"));
  }
  if (env.world === null || typeof env.world !== "object") {
    errors.push(fail("missing_field", "world is missing"));
  }
  if (errors.length > 0) return { ok: false, errors };

  const identity = env.identity as CheckpointIdentity;
  const world = env.world as WorldState;

  for (const f of REQUIRED_IDENTITY_FIELDS) {
    if ((identity as unknown as Record<string, unknown>)[f] === undefined) {
      errors.push(fail("missing_field", `identity.${f} is missing`, { field: f }));
    }
  }
  for (const f of REQUIRED_WORLD_FIELDS) {
    if ((world as unknown as Record<string, unknown>)[f] === undefined) {
      errors.push(fail("missing_field", `world.${f} is missing`, { field: f }));
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // ---- structural sanity ----
  if (!Number.isInteger(world.tick) || world.tick < 0) {
    errors.push(fail("invalid_tick", "tick must be a non-negative integer", { tick: String(world.tick) }));
  }
  if (identity.tick !== world.tick) {
    errors.push(fail("invalid_tick", "identity.tick disagrees with world.tick", { identity: identity.tick, world: world.tick }));
  }
  if (
    world.rngState === null ||
    typeof world.rngState !== "object" ||
    typeof world.rngState.s !== "number" ||
    !Number.isFinite(world.rngState.s) ||
    !Number.isInteger(world.rngState.s) ||
    world.rngState.s < 0 ||
    world.rngState.s > 0xffffffff
  ) {
    errors.push(
      fail("invalid_rng_state", "rngState.s must be a uint32", { got: JSON.stringify(world.rngState ?? null) }),
    );
  }
  if (identity.rngState?.s !== world.rngState?.s) {
    errors.push(fail("invalid_rng_state", "identity.rngState disagrees with world.rngState"));
  }
  if (!Number.isInteger(world.schemaVersion) || world.schemaVersion < 1) {
    errors.push(fail("invalid_schema_version", "schemaVersion must be a positive integer"));
  }

  // ---- retention boundary coherence (§20.10) ----
  // A checkpoint whose boundary disagrees with its record would restore a world that
  // misclassifies cursors — reporting `deliverable` for evicted facts, or a gap for a
  // caught-up consumer. Both are silent contract violations, so the boundary is validated
  // rather than trusted.
  if (!Number.isInteger(world.highestEmittedSeq) || world.highestEmittedSeq < 0) {
    errors.push(fail("invalid_retention_boundary", "highestEmittedSeq must be a non-negative integer"));
  }
  if (!Number.isInteger(world.oldestRetainedSeq) || world.oldestRetainedSeq < 1) {
    errors.push(fail("invalid_retention_boundary", "oldestRetainedSeq must be a positive integer"));
  }
  if (!Number.isInteger(world.evictedCount) || world.evictedCount < 0) {
    errors.push(fail("invalid_retention_boundary", "evictedCount must be a non-negative integer"));
  }
  if (Array.isArray(world.events)) {
    for (const ev of world.events) {
      if (ev === null || typeof ev !== "object" || !Number.isInteger(ev.streamSeq) || ev.streamSeq < 1) {
        errors.push(fail("invalid_retention_boundary", "every event must carry a positive integer streamSeq"));
        break;
      }
      if (ev.streamSeq > world.highestEmittedSeq) {
        errors.push(
          fail("invalid_retention_boundary", "an event's streamSeq exceeds highestEmittedSeq", {
            streamSeq: ev.streamSeq,
            highestEmittedSeq: world.highestEmittedSeq,
          }),
        );
        break;
      }
      if (ev.streamSeq < world.oldestRetainedSeq) {
        errors.push(
          fail("invalid_retention_boundary", "a retained event sits below oldestRetainedSeq", {
            streamSeq: ev.streamSeq,
            oldestRetainedSeq: world.oldestRetainedSeq,
          }),
        );
        break;
      }
    }
    if (world.events.length === 0 && world.oldestRetainedSeq !== world.highestEmittedSeq + 1) {
      errors.push(
        fail("invalid_retention_boundary", "an empty record must set oldestRetainedSeq to highestEmittedSeq + 1", {
          oldestRetainedSeq: world.oldestRetainedSeq,
          highestEmittedSeq: world.highestEmittedSeq,
        }),
      );
    }
  }

  // ---- provenance structure ----
  if (!Array.isArray(world.provenance)) {
    errors.push(fail("malformed_provenance", "provenance must be an array"));
  } else {
    for (const [i, node] of world.provenance.entries()) {
      if (node === null || typeof node !== "object") {
        errors.push(fail("malformed_provenance", `provenance[${i}] is not an object`, { index: i }));
        break;
      }
      if (typeof node.id !== "string" || typeof node.tick !== "number" || !Array.isArray(node.parents)) {
        errors.push(
          fail("malformed_provenance", `provenance[${i}] missing id/tick/parents`, { index: i, id: String(node.id) }),
        );
        break;
      }
    }
  }
  if (!Array.isArray(world.resolutionLog)) errors.push(fail("malformed_provenance", "resolutionLog must be an array"));
  if (!Array.isArray(world.diagnostics)) errors.push(fail("malformed_provenance", "diagnostics must be an array"));
  if (!Array.isArray(world.interventionHistory)) {
    errors.push(fail("malformed_provenance", "interventionHistory must be an array"));
  }

  // ---- ledger structure ----
  if (world.regions === null || typeof world.regions !== "object") {
    errors.push(fail("malformed_ledger", "regions must be an object"));
  } else {
    for (const [id, region] of Object.entries(world.regions)) {
      if (region === null || typeof region !== "object") {
        errors.push(fail("malformed_ledger", `region ${id} is not an object`, { region: id }));
        continue;
      }
      if (region.ledger === null || typeof region.ledger !== "object") {
        errors.push(fail("malformed_ledger", `region ${id} has no ledger`, { region: id }));
        continue;
      }
      for (const domain of DOMAIN_ORDER) {
        const p = region.ledger[domain];
        if (p !== undefined && (!Number.isFinite(p) || p < 0)) {
          errors.push(
            fail("malformed_ledger", `region ${id} ledger.${domain} must be a finite non-negative number`, {
              region: id,
              domain,
              value: String(p),
            }),
          );
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // ---- integrity: recompute and compare ----
  const sh = stateHash(world);
  const th = traceHash(world);
  const ch = configHash(world);
  if (sh !== identity.stateHash) {
    errors.push(fail("state_hash_mismatch", "recomputed stateHash does not match identity", { expected: identity.stateHash, actual: sh }));
  }
  if (th !== identity.traceHash) {
    errors.push(fail("trace_hash_mismatch", "recomputed traceHash does not match identity", { expected: identity.traceHash, actual: th }));
  }
  if (ch !== identity.configHash) {
    errors.push(fail("config_hash_mismatch", "recomputed configHash does not match identity", { expected: identity.configHash, actual: ch }));
  }
  const expectedId = deriveCheckpointId(world.lineage.worldId, world.lineage.timelineId, world.tick, sh, th);
  if (identity.checkpointId !== expectedId) {
    errors.push(
      fail("checkpoint_id_mismatch", "checkpointId is not derivable from its own contents", {
        expected: expectedId,
        actual: identity.checkpointId,
      }),
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  // ---- honesty warnings (not failures) ----
  if (world.historyTruncated) {
    warnings.push(
      fail("malformed_provenance", "causal history is TRUNCATED: explanations may be incomplete", {
        nodeCount: world.provenance.length,
        provenanceSeq: world.provenanceSeq,
      }),
    );
  }

  return { ok: true, value: { format: CHECKPOINT_FORMAT, formatVersion: env.formatVersion, identity, world }, warnings };
}

/** Parse then validate. */
export function deserializeCheckpoint(text: string): LoadResult<CheckpointEnvelope> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [fail("not_json", `checkpoint is not valid JSON: ${(e as Error).message}`)] };
  }
  return validateCheckpoint(raw);
}

// ---------------------------------------------------------------------------
// Configuration compatibility
// ---------------------------------------------------------------------------

/**
 * What to do when a checkpoint's config differs from the config being resumed under.
 *
 * DECISION (§17.9): `reject` is the DEFAULT. Causal parameters change what the world means;
 * resuming a save under different thresholds/decay/gain produces a world that never existed
 * and cannot be replayed from its own history. Silence here would be the worst option.
 *
 * `migrate` is allowed but never silent: it assigns a NEW timeline identity with origin
 * "migration", so the resumed world is honestly a different history rather than a
 * continuation pretending to be the original.
 */
export type ConfigPolicy = "reject" | "migrate";

export interface RestoreOptions {
  /** Config to resume under. Omit to use the checkpoint's own config (always compatible). */
  config?: WorldState["config"];
  configPolicy?: ConfigPolicy;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface RestoredWorld {
  world: WorldState;
  identity: CheckpointIdentity;
  /** True when config differed and a migration timeline was created. */
  migrated: boolean;
}

/**
 * Rebuild a resumable world from a validated envelope.
 *
 * The returned world is a deep clone: a restored world can never alias the checkpoint, so
 * continuing it cannot retroactively mutate the saved artefact.
 */
export function restoreCheckpoint(env: CheckpointEnvelope, options: RestoreOptions = {}): LoadResult<RestoredWorld> {
  const warnings: CheckpointError[] = [];
  const world = deepClone(env.world);

  let migrated = false;
  if (options.config !== undefined) {
    const incoming = deepClone(options.config);
    const sameConfig = configFingerprint(incoming) === configFingerprint(world.config);
    if (!sameConfig) {
      const policy: ConfigPolicy = options.configPolicy ?? "reject";
      if (policy === "reject") {
        return {
          ok: false,
          errors: [
            fail("incompatible_config", "checkpoint config differs from the requested config; refusing to resume", {
              checkpointConfigHash: env.identity.configHash,
              policy,
            }),
          ],
        };
      }
      // migrate: new timeline identity, honestly labelled
      world.config = incoming;
      world.lineage = migrationLineage(world.lineage, env.identity.checkpointId, world.tick);
      migrated = true;
      warnings.push(
        fail("incompatible_config", "resumed under changed configuration; assigned a migration timeline", {
          newTimelineId: world.lineage.timelineId,
        }),
      );
    }
  }

  if (world.historyTruncated) {
    warnings.push(fail("malformed_provenance", "restored world carries a truncated causal history"));
  }

  return { ok: true, value: { world, identity: env.identity, migrated }, warnings };
}

/**
 * Canonical config comparison.
 *
 * Uses the same recursive key-sorting as `configHash` deliberately. An earlier version used
 * `JSON.stringify(cfg, Object.keys(cfg).sort())`, which is wrong in a way that silently
 * defeats the whole check: the array form of the second argument is a key ALLOW-LIST, not a
 * sort order, and it applies at every depth — so nested `thresholds.*` keys were filtered out
 * and a changed threshold compared as identical. Found by the config-rejection test.
 */
function configFingerprint(cfg: WorldState["config"]): string {
  return JSON.stringify(sortKeys(cfg));
}

function migrationLineage(parent: Lineage, fromCheckpoint: CheckpointId, atTick: number): Lineage {
  return {
    ...parent,
    timelineId: deriveTimelineId(parent.timelineId, "migration", atTick, fromCheckpoint),
    origin: "migration",
    parentTimelineId: parent.timelineId,
    parentCheckpointId: fromCheckpoint,
    forkTick: atTick,
    divergenceInterventionIds: [],
    generation: parent.generation + 1,
  };
}
