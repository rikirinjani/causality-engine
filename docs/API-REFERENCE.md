# CE v1.0 API Reference

Everything here is imported from one place:

```typescript
import { ... } from "causality-engine/product";
```

The engine's internal surface (`causality-engine/engine`) exists for adapter authors who need low-level delivery or lifecycle control. **You should not need it.** If you do, that is a productization gap worth reporting.

---

## Runtime API

### `createGame(options?): CausalRuntime`

Create a fresh causal world and everything needed to run it.

```typescript
const game = createGame({ seed: 42, consumerId: "renderer" });
```

| Option | Type | Default | Meaning |
|--------|------|---------|---------|
| `seed` | `number` | `42` | Deterministic seed. Same seed + same interventions = same world. |
| `config` | `Partial<SimConfig>` | `{}` | Config overrides. Validated; throws `ConfigError` if invalid. |
| `consumerId` | `string` | `"game"` | Identity of this consumer's event channel. |
| `label` | `string` | `"genesis"` | Timeline label for the genesis world. |

Returns a `CausalRuntime`: `{ world, engine, delivery, consumerId }`. Hold one per timeline.

### `apply(runtime, intervention): ApplyResult`

Submit an already-built `Intervention`. Most games use `intervene()` instead.

Returns `{ ok, errors, interventionSeq }`. Rejections (e.g. destroying an already-destroyed structure) come back as `ok: false` with the engine's own reasons.

### `step(runtime, ticks?): StepResult`

Advance causal time. Default 1 tick.

```typescript
const result = step(game, 5);
// { tick: 5, ticksAdvanced: 5, stateHash: "5404...", traceHash: "..." }
```

CE has no clock of its own. Nothing happens until you call this.

---

## Intervention API

### `listActions(): ActionInfo[]`

Every action the world accepts, sorted by name.

```typescript
for (const a of listActions()) {
  console.log(a.action, a.allowedTargets, a.summary);
}
```

### `describeAction(action): ActionInfo | undefined`

One action, or `undefined` if the engine does not know it.

```typescript
interface ActionInfo {
  action: string;
  allowedTargets: readonly TargetKind[];       // "infrastructure" | "entity" | "region"
  locationMustEqualTarget: boolean;            // true for region-scoped actions
  summary: string;
}
```

### `isActionAvailable(action): boolean`

### `intervene(runtime, spec): ApplyResult`

Build and submit in one call. The common case.

```typescript
intervene(game, {
  action: "destroy_infrastructure",
  target: { type: "infrastructure", id: "grain_road" },
  location: "RF",
});
```

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `action` | `string` | — | Action name from the catalog. |
| `target` | `{ type, id }` | — | What is acted upon. |
| `location` | `string` | `target.id` | Region the action happens in. |
| `actor` | `string` | `"player"` | Who did it. |
| `magnitude` | `number` | `1.0` | Normalised strength in `[0, 1]`. |
| `intent` | `string` | — | Optional free text, carried for auditing. |

### `buildIntervention(runtime, spec): BuildResult`

Build without submitting. Returns `{ ok: true, intervention }` or `{ ok: false, errors }`.

The built intervention always has **`causalDomains: []`**. Causal pressure is authored exclusively by the engine's action schemas — the builder never invents it.

### `validateInterventionSpec(spec): { ok, errors }`

Check a spec against the action contract without touching the world. Reports every problem at once.

---

## Event API

### `openEventStream(runtime): EventStream`

Open a stream over the runtime's delivery channel. Cursor position survives across calls.

### `stream.next(): EventBatch`

Poll once. **Never acks** — reading is not consuming.

```typescript
interface EventBatch {
  status: "events" | "caught_up" | "gap" | "disconnected" | "wrong_timeline";
  events: Array<{ event: WorldEvent; streamSeq: number; attempt: number }>;
  highestSeq: number;        // -1 when empty
  gap?: RetentionGap;        // present when status === "gap"
  expectedTimeline?: string; // present when status === "wrong_timeline"
  actualTimeline?: string;
}
```

`attempt > 1` means this fact was redelivered. That is at-least-once delivery working correctly, not a bug.

### `stream.ack(throughSeq): { ok, reason? }`

Acknowledge through an explicit `streamSeq`. Cursors never move backwards.

### `stream.ackBatch(batch): { ok, reason? }`

Acknowledge a batch through its `highestSeq`. Successful no-op for empty batches.

### `stream.drain(handler): DrainReport`

Poll, hand every event to the handler **in canonical order**, then ack.

```typescript
const report = stream.drain((event, meta) => {
  render(event, meta.streamSeq);
});
// { status, delivered, acked, highestSeq, gap? }
```

A `gap`, `disconnected`, or `wrong_timeline` batch is **not** acked — acking would skip facts silently.

### `stream.recover(): { ok, reason? }`

Recover from a gap by adopting the world's present. This does not pretend the gap did not happen; you already saw it in the batch status.

### `stream.cursor(): Cursor`

Current acknowledged position: `{ afterSeq, throughTick }`.

---

## Inspection API

### `inspect(runtime | world): WorldView`

Project the world into a game-facing view. This is a projection, not a clone — ledger internals, provenance nodes, and RNG registers are deliberately absent.

```typescript
interface WorldView {
  tick: number;
  timelineId: string;
  schemaVersion: number;
  stateHash: string;         // physical identity
  traceHash: string;         // causal-history identity
  regions: Record<string, RegionView>;
  relations: Record<string, number>;
  eventCount: number;
  highestSeq: number;
  historyTruncated: boolean; // true when facts have been evicted
}

interface RegionView {
  id: string;
  name: string;
  prices: Record<string, number>;
  stocks: Record<string, number>;
  infrastructure: Record<string, { type: string; health: number; intact: boolean }>;
  unrest: number;
  patrolDemand: number;
  tradeInvestment: number;
}
```

Key order is always sorted, never insertion order.

### `whatChanged(before, after): ViewDifference[]`

Structural diff between two views.

```typescript
const before = inspect(game);
step(game, 5);
const changes = whatChanged(before, inspect(game));
// [{ path: "regions.RF.prices.grain", before: 10, after: 13.13 }, ...]
```

Hashes are excluded — they change whenever anything changes. Compare `stateHash` directly for identity.

### `recentEvents(runtime | world, limit?): WorldEvent[]`

The most recent retained events, oldest-last. Default limit 20.

This reads the world's record. It is **not** delivery: it moves no cursor and carries no acknowledgement obligation. Use `openEventStream()` when you need at-least-once semantics.

---

## Explanation API

### `why(runtime | world, quantityKey): CauseView`

Ask CE why a quantity has its current value.

```typescript
const cause = why(game, quantity.price("RF", "grain"));

interface CauseView {
  quantity: string;
  explained: boolean;
  incomplete: boolean;      // true when provenance was evicted
  rootActions: Array<{ interventionId; action; location; targetId; tick }>;
  chains: string[][];       // ancestor label paths
}
```

`incomplete: true` means the trace may be missing ancestors because the bounded record discarded them. An incomplete explanation announces itself rather than masquerading as a complete one.

### `quantity`

Helpers for naming what you want explained:

| Helper | Example | Names |
|--------|---------|-------|
| `quantity.price(region, resource)` | `price("RF","grain")` | market price |
| `quantity.stock(region, resource)` | `stock("RF","grain")` | stored quantity |
| `quantity.infra(region, id)` | `infra("RF","grain_road")` | structure health |
| `quantity.hostility(faction)` | `hostility("MG")` | faction hostility |
| `quantity.unrest(region)` | `unrest("RF")` | civic unrest |
| `quantity.patrolDemand(region)` | `patrolDemand("RF")` | patrol pressure |
| `quantity.investment(region)` | `investment("RF")` | trade investment |
| `quantity.population(region)` | `population("RF")` | resident agents |
| `quantity.tradeBlocked(region)` | `tradeBlocked("RF")` | trade blockage |
| `quantity.ledger(region, domain)` | `ledger("RF","economy")` | quota pressure |

---

## Persistence API

### `saveGame(runtime, label?): SaveGameResult`

```typescript
const save = saveGame(game, "checkpoint-1");
// { data, checkpointId, tick, timelineId, stateHash }
```

`data` is an **opaque string**. Store it anywhere. Never parse or edit it — checkpoint internals are not a public contract.

Delivery state is deliberately not bundled. Cursors describe a reader, not the world; a reload starts with a fresh channel so a save can never resurrect a stale cursor onto different facts.

### `loadGame(data, options?): LoadResult`

```typescript
const loaded = loadGame(save.data);
if (loaded.ok) {
  step(loaded.runtime, 5);   // deterministic continuation
} else {
  console.error(loaded.errors);
}
```

Returns `{ ok: true, runtime, migrated, warnings }` or `{ ok: false, errors }`.

`migrated: true` means the world resumed under a different config and was honestly given a new timeline identity.

### `loadWorld(data, options?): LoadResult`

Alias of `loadGame`, named for symmetry with `createGame`.

### `inspectSave(data)`

Read a save's identity without building a runtime.

```typescript
const peek = inspectSave(save.data);
// { ok: true, checkpointId, timelineId, tick, stateHash }
```

### `readSave(data)`

Parse and validate into a checkpoint envelope. Used internally by load/fork/rewind.

---

## Timeline API

### `timelineOf(runtime): TimelineSummary`

```typescript
interface TimelineSummary {
  timelineId: string;
  worldId: string;
  origin: string;               // "genesis" | "fork" | "rewind" | "migration"
  parentTimelineId: string | null;
  parentCheckpointId: string | null;
  forkTick: number | null;
  generation: number;           // depth from genesis
  tick: number;
  stateHash: string;
  traceHash: string;
}
```

### `forkGame(data, discriminator, options?): LoadResult`

Fork an **independent** timeline from save data. The runtime that produced the save is completely untouched.

```typescript
const forked = forkGame(branchPoint.data, "B");
if (forked.ok) {
  intervene(forked.runtime, { ... });   // diverge freely
  step(forked.runtime, 5);
}
```

### `rewindGame(runtime, data, options?): RewindOutcome`

Rewind to an earlier checkpoint of the runtime's own timeline. Returns a **new** runtime, so a failed rewind cannot leave a half-rewound world.

```typescript
const rewound = rewindGame(game, save.data);
if (rewound.ok) {
  console.log(rewound.abandonedTimelineId);   // the discarded future stays referenceable
}
```

A rewound world takes a **new** timeline identity. Its physics match the checkpoint exactly, but its `stateHash` differs because lineage is part of world identity — a save must not be able to claim an ancestry it does not have.

### `compareTimelines(a, b): TimelineComparison`

```typescript
interface TimelineComparison {
  a: TimelineSummary;
  b: TimelineSummary;
  distinct: boolean;         // different timelineId
  stateHashEqual: boolean;   // same physical world
  traceHashEqual: boolean;   // same causal history
  differences: Array<{ path: string; a: unknown; b: unknown }>;
}
```

`stateHashEqual` and `traceHashEqual` are separate on purpose. Two branches can converge to identical physics while retaining different histories. CE never collapses them.

---

## Configuration API

### `validateConfig(overrides): ConfigValidation`

```typescript
const check = validateConfig({ ledgerDecayPerTick: 1.5 });
// { ok: false, errors: [{ field, problem, value }], warnings: [...] }
```

Never mutates or clamps the input.

**Errors** (refuse to run): non-integer seed, non-positive threshold, `ledgerDecayPerTick` outside `(0,1)`, `boundaryDecay` outside `[0,1)`, negative/non-integer `boundaryMaxHops`, `contestRatio` outside `[0,1]`, non-positive caps, `priceClampMax <= priceClampMin`, `investmentMax < investmentMin`, any `NaN`/`Infinity`.

**Warnings** (run, but you should know): `boundaryMaxHops: 0` disables cross-region propagation; `ledgerDecayPerTick > 0.95` makes pressure linger; a threshold above `2.0` may never fire.

### `createConfig(overrides?): SimConfig`

Validated config, or throws `ConfigError`.

### `ConfigError`

```typescript
try {
  createGame({ config: { boundaryDecay: 3 } });
} catch (e) {
  if (e instanceof ConfigError) console.error(e.issues);
}
```

Carries every issue, not just the first.

---

## Pass-through exports

Engine types and constants you legitimately need:

```typescript
import type {
  WorldState, Intervention, InterventionTarget, WorldEvent,
  SimConfig, DomainId, RegionId, EntityId, ResourceId,
  Engine, Cursor, DeliveryState, RetentionGap, Lineage,
  CausalRuntime,
} from "causality-engine/product";

import {
  DEFAULT_CONFIG, stateHash, traceHash,
  CURRENT_SCHEMA_VERSION, MIN_MIGRATABLE_SCHEMA_VERSION,
} from "causality-engine/product";
```

---

## What is deliberately not exported

These stay internal because exposing them would make engine mechanics part of your contract:

- propagation internals (pressure accumulation, boundary BFS, quota resolution)
- provenance graph construction (`record`, `setRef`)
- retention enforcement and checkpoint compaction
- lifecycle classification and rewind verdicts
- domain resolvers and action-schema internals
- RNG implementation

Adapter authors who genuinely need low-level delivery or lifecycle control can import `causality-engine/engine`. Needing it for ordinary game integration is a gap — report it.
