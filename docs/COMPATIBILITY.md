# CE Compatibility Contract

What is stable, what may change, and what happens when you upgrade CE with old saves on disk.

---

## Version numbers

| Component | Current | Stability |
|-----------|---------|-----------|
| **Package version** | `0.2.0` | Provisional until v1.0 |
| **World schema version** | `7` | Migratable |
| **WS protocol** | `1.0` | Stable |
| **Product API** (`causality-engine/product`) | v1 draft | Additive changes only within a major |
| **Engine API** (`causality-engine/engine`) | provisional | May change between minors |

Read the current schema constants at runtime:

```typescript
import { CURRENT_SCHEMA_VERSION, MIN_MIGRATABLE_SCHEMA_VERSION } from "causality-engine/product";
```

---

## API stability tiers

### Stable — safe to build on

Breaking changes require a major version bump.

```
createGame  apply  step
intervene  buildIntervention  validateInterventionSpec
listActions  describeAction  isActionAvailable
openEventStream  (next, ack, ackBatch, drain, recover, cursor)
inspect  whatChanged  recentEvents
why  quantity
saveGame  loadGame  loadWorld  inspectSave
timelineOf  forkGame  rewindGame  compareTimelines
validateConfig  createConfig  ConfigError
stateHash  traceHash
```

### Provisional — may change in a minor

```
readSave  bundleRuntime
```

These exist for adapter authors. Shapes may be refined based on integration feedback.

### Internal — do not import

Everything under `src/core/` and `src/game/` that is not re-exported from a public barrel. Importing these couples your game to engine mechanics that are explicitly free to change.

The `causality-engine/engine` export exists for adapter authors who need low-level delivery or lifecycle control. Treat needing it for ordinary integration as a gap worth reporting.

---

## Save compatibility

### The contract

| Situation | Behaviour |
|-----------|-----------|
| Save schema **equals** current | Loads directly |
| Save schema **older**, at or above `MIN_MIGRATABLE_SCHEMA_VERSION` | Forward-migrated automatically |
| Save schema **older than** `MIN_MIGRATABLE_SCHEMA_VERSION` | Rejected with a clear error |
| Save schema **newer** than current | Rejected — an older CE cannot understand a newer world |
| Save corrupted or truncated | Rejected by validation |

Rejection is always explicit. `loadGame` returns `{ ok: false, errors }`; it never returns a partially-loaded world.

```typescript
const loaded = loadGame(oldSaveData);
if (!loaded.ok) {
  // errors look like: "schema_too_old: checkpoint schema 3 predates the migration floor 5"
  console.error(loaded.errors);
}
```

### Save payloads are opaque

`saveGame().data` is a string you store and hand back. Do not parse it, edit it, diff it, or depend on its internal shape. Checkpoint internals are **not** part of the public contract and change freely between versions.

If you need to know something about a save without loading it, use `inspectSave()`:

```typescript
const peek = inspectSave(data);
// { ok: true, checkpointId, timelineId, tick, stateHash }
```

### Config changes on load

Resuming a world under a different config is a **timeline change**, not a silent adjustment. When it happens, CE gives the world a new timeline identity and reports it honestly:

```typescript
const loaded = loadGame(save.data);
if (loaded.ok && loaded.migrated) {
  // resumed under different tuning; new timeline identity assigned
  console.warn(loaded.warnings);
}
```

Config is part of `stateHash`. Two runs with the same seed but different tuning are distinguishable by design — a differently-tuned world is a different world.

### Delivery cursors are not saved

Save payloads contain the world, never a consumer's read position. A reloaded runtime starts with a fresh event channel.

This is deliberate. A cursor describes a reader, not the world. Restoring a stale cursor onto a reloaded world could silently reposition a consumer onto different facts — a defect class CE closed and will not reopen.

---

## What breaks determinism

Determinism is CE's core contract:

> Same seed + same config + same interventions in the same order → same `stateHash` at every tick.

The following **break** it, and therefore require a major version bump plus a migration note:

- changing domain resolution logic
- changing propagation or accumulation algorithms
- changing default quota thresholds or decay rates
- changing the RNG implementation
- changing tick phase order
- changing what `stateHash` covers

The following **do not** break it:

- adding a new action to the catalog
- adding a new event type
- changing retention limits (affects delivery, not state)
- changing transport (HTTP, WebSocket, in-process)
- changing adapter logic (the adapter is outside CE)
- adding product-layer conveniences (this whole surface)
- documentation, packaging, tooling

### Verifying determinism yourself

```typescript
import { createGame, intervene, step } from "causality-engine/product";

function run() {
  const g = createGame({ seed: 42 });
  intervene(g, { action: "destroy_infrastructure", target: { type: "infrastructure", id: "grain_road" }, location: "RF" });
  return step(g, 5).stateHash;
}

console.assert(run() === run(), "determinism broken");
```

The repository ships a replay check:

```bash
npm run verify:replay
```

---

## Cross-platform determinism

Verified identical on:

| Platform | Arch | Node |
|----------|------|------|
| macOS 26.6 | arm64 (Apple M4) | 26.5.0 |
| Windows 11 | x64 | 22.x |

**Not formally guaranteed.** CE relies on IEEE-754 double arithmetic and deterministic key ordering. Both platforms produce bit-identical state hashes in testing, but CE makes no formal proof of floating-point identity across all platforms and runtimes.

If you ship to a platform outside the verified set and determinism matters to you, run your own replay comparison before depending on it.

---

## Upgrade checklist

When moving to a new CE version:

1. Read the changelog for any determinism-breaking entry.
2. Run `npm run verify:replay` — confirms the shipped baseline still reproduces.
3. Load one representative old save and check `migrated` and `warnings`.
4. Re-run your own determinism assertion (above) against a known-good hash you recorded before upgrading.
5. If `stateHash` changed for identical inputs, the upgrade changed causal behaviour. Existing saves remain loadable, but recorded hashes and any replay-based tests you own need re-baselining.

---

## Known limitations

These are current, deliberate boundaries — not bugs:

- **Single process.** No IPC, no distributed simulation.
- **Single consumer per channel.** Multiple consumers need multiple channels.
- **At-least-once delivery, not exactly-once.** Handle duplicate `eventId` values; `attempt > 1` marks a redelivery.
- **Bounded event and provenance records.** Old facts are evicted. Eviction is always reported (`historyTruncated`, gap status, `incomplete` explanations) — never silent.
- **No formal determinism proof.** Empirically validated, not proven.
- **Not a game engine.** No rendering, animation, input, or audio.
- **WebSocket transport not production-soaked.** Validated by integration tests, not load testing.
