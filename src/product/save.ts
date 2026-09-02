/**
 * CE v1.0 — Save / load (product boundary).
 *
 * Reduces the four-step checkpoint cycle (create -> serialize -> validate ->
 * restore) to two calls, WITHOUT introducing a second persistence model. Every
 * function here delegates to the engine's own checkpoint machinery; the save
 * payload is the engine's serialized checkpoint and nothing else.
 *
 * Preserved: deterministic restore, timeline identity, provenance, schema
 * migration policy, and the fact that DeliveryState lives OUTSIDE WorldState.
 */
import {
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
  validateCheckpoint,
  type CheckpointEnvelope,
  type CheckpointError,
} from "../core/persistence.js";
import { stateHash } from "../core/hash.js";
import { bundleRuntime, type CausalRuntime } from "./runtime.js";

export interface SaveGameResult {
  /**
   * Opaque save payload. Store it anywhere (file, cloud, blob column) — the game
   * must never parse or edit it. Checkpoint internals are not a public contract.
   */
  data: string;
  checkpointId: string;
  tick: number;
  timelineId: string;
  stateHash: string;
}

export type LoadResult =
  | { ok: true; runtime: CausalRuntime; migrated: boolean; warnings: string[] }
  | { ok: false; errors: string[] };

export interface LoadOptions {
  /** Identity for the restored world's event channel. Default "game". */
  consumerId?: string;
}

/** Render engine checkpoint errors as developer-readable strings. */
function messages(errors: CheckpointError[]): string[] {
  return errors.map((e) => `${e.code}: ${e.message}`);
}

/**
 * Capture a save point.
 *
 * DeliveryState is deliberately NOT bundled into the payload. Cursors describe a
 * consumer's read position, not the world; a restored world starts with a fresh
 * channel so a save can never resurrect a stale cursor onto different facts.
 */
export function saveGame(rt: CausalRuntime, label = ""): SaveGameResult {
  const envelope = createCheckpoint(rt.world, label);
  return {
    data: serializeCheckpoint(envelope),
    checkpointId: envelope.identity.checkpointId,
    tick: envelope.identity.tick,
    timelineId: envelope.identity.timelineId,
    stateHash: envelope.identity.stateHash,
  };
}

/**
 * Parse and validate save data into a checkpoint envelope.
 * Shared by load/fork/rewind so all three reject bad payloads identically.
 */
export function readSave(data: string): { ok: true; envelope: CheckpointEnvelope } | { ok: false; errors: string[] } {
  const parsed = deserializeCheckpoint(data);
  if (!parsed.ok) return { ok: false, errors: messages(parsed.errors) };

  const validated = validateCheckpoint(parsed.value);
  if (!validated.ok) return { ok: false, errors: messages(validated.errors) };

  return { ok: true, envelope: validated.value };
}

/**
 * Resume a saved world.
 *
 * Continuation is deterministic: advancing a loaded world produces the same state
 * hashes as advancing the original would have. `migrated` reports honestly when
 * the world was resumed under a different config and therefore given a new
 * timeline identity.
 */
export function loadGame(data: string, opts: LoadOptions = {}): LoadResult {
  const read = readSave(data);
  if (!read.ok) return { ok: false, errors: read.errors };

  const restored = restoreCheckpoint(read.envelope);
  if (!restored.ok) return { ok: false, errors: messages(restored.errors) };

  // restoreCheckpoint returns a detached world — it does not attach an engine.
  const runtime = bundleRuntime(restored.value.world, opts.consumerId ?? "game");

  return {
    ok: true,
    runtime,
    migrated: restored.value.migrated,
    warnings: messages(restored.warnings ?? []),
  };
}

/** Alias of `loadGame`, named for symmetry with `createGame`. */
export function loadWorld(data: string, opts: LoadOptions = {}): LoadResult {
  return loadGame(data, opts);
}

/** Verify save data parses and validates, without building a runtime. */
export function inspectSave(
  data: string,
): { ok: true; checkpointId: string; timelineId: string; tick: number; stateHash: string } | { ok: false; errors: string[] } {
  const read = readSave(data);
  if (!read.ok) return { ok: false, errors: read.errors };
  const id = read.envelope.identity;
  return {
    ok: true,
    checkpointId: id.checkpointId,
    timelineId: id.timelineId,
    tick: id.tick,
    stateHash: id.stateHash,
  };
}

export { stateHash };
