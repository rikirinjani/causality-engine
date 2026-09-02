# Getting Started with Causality Engine

CE is a **causal world-simulation layer**. It does not render, animate, or handle input. It remembers and propagates consequences.

You keep your game engine. CE becomes the authority on what happens in the world and why.

---

## Install

```bash
npm install causality-engine
```

Requires Node 20+.

---

## Five-minute integration

```typescript
import {
  createGame, intervene, step, inspect, openEventStream,
} from "causality-engine/product";

// 1. Create a world. Same seed always produces the same world.
const game = createGame({ seed: 42 });
const events = openEventStream(game);

// 2. Look at it.
const view = inspect(game);
console.log(view.regions.RF.prices.grain);   // 10
console.log(view.regions.RF.infrastructure.grain_road.intact);  // true

// 3. The player does something.
const result = intervene(game, {
  action: "destroy_infrastructure",
  target: { type: "infrastructure", id: "grain_road" },
  location: "RF",
});
if (!result.ok) console.error(result.errors);

// 4. Let time pass. CE decides the consequences.
step(game, 5);

// 5. Consume what happened.
events.drain((event, meta) => {
  console.log(event.type, meta.streamSeq);
});

// 6. Look again.
console.log(inspect(game).regions.RF.prices.grain);  // 13.13 — the bridge mattered
```

That is the whole loop. You never told CE that destroying a bridge raises grain prices. CE knew.

---

## The four core concepts

### World
A world is causal state: regions, prices, stocks, infrastructure, factions, relations. You create one with `createGame()` and hold the returned `CausalRuntime`.

### Intervention
An intervention is something an actor did. You describe *what* happened; CE decides what it *causes*.

```typescript
intervene(game, {
  action: "grant_merchant_subsidy",
  target: { type: "region", id: "RF" },
  location: "RF",
});
```

Call `listActions()` to discover what the world accepts.

### Tick
CE has no clock. Time passes only when you call `step()`. Advance once per frame, many times per frame, or not at all — CE never requires real-time sync.

```typescript
step(game);        // one tick
step(game, 30);    // thirty ticks
```

### Event
An event is a historical fact about the world. Events are delivered at-least-once, in canonical order, with stable sequence numbers. You acknowledge them explicitly.

```typescript
const batch = events.next();       // read, does not consume
events.ackBatch(batch);            // now consumed
```

Or do both at once:

```typescript
events.drain((event, meta) => render(event));
```

---

## Asking why

Any observable quantity can be traced back to the actions that caused it.

```typescript
import { why, quantity } from "causality-engine/product";

const cause = why(game, quantity.price("RF", "grain"));

console.log(cause.explained);      // true
for (const root of cause.rootActions) {
  console.log(root.action, root.tick);   // destroy_infrastructure 0
}
```

This is CE's own causal attribution, not a guess. If CE cannot explain something it says so rather than inventing a reason.

Available quantity keys: `price`, `stock`, `hostility`, `unrest`, `infra`, `patrolDemand`, `investment`, `population`, and others — see `quantity` in the API reference.

---

## Saving and loading

```typescript
import { saveGame, loadGame } from "causality-engine/product";

const save = saveGame(game, "checkpoint-1");
// save.data is an opaque string. Store it anywhere. Never parse it.

const loaded = loadGame(save.data);
if (loaded.ok) {
  step(loaded.runtime, 5);   // continues deterministically
}
```

Continuation is deterministic: advancing a loaded world produces exactly the same state hashes as advancing the original would have.

---

## Branching and rewind

Save points are not just save points. They are branch points.

```typescript
import { forkGame, rewindGame, compareTimelines } from "causality-engine/product";

const branchPoint = saveGame(game, "the-choice");

// Timeline A: destroy the bridge
intervene(game, { action: "destroy_infrastructure", target: { type: "infrastructure", id: "grain_road" }, location: "RF" });
step(game, 5);

// Timeline B: from the same point, subsidise instead
const forked = forkGame(branchPoint.data, "B");
if (forked.ok) {
  intervene(forked.runtime, { action: "grant_merchant_subsidy", target: { type: "region", id: "RF" }, location: "RF" });
  step(forked.runtime, 5);

  const diff = compareTimelines(game, forked.runtime);
  console.log(diff.distinct);          // true — separate timelines
  console.log(diff.stateHashEqual);    // false — different worlds
  console.log(diff.differences);       // exactly what differs
}

// Or abandon the future and go back
const rewound = rewindGame(game, branchPoint.data);
```

Forking never mutates the parent. Both timelines remain independently playable.

---

## Where the boundaries are

| Layer | Owns |
|-------|------|
| **Your game** | rendering, animation, camera, UI, player input, audio |
| **Your adapter** | translating intent into interventions, projecting CE state into game structures, transport |
| **CE** | world state, causal rules, propagation, RNG, events, provenance, persistence, branching, rewind |

**Put no causal rule and no RNG in your game or adapter.** If your game decides that destroying a bridge raises prices, CE is no longer the authority and determinism, attribution, and branching all stop meaning anything.

---

## Validating configuration

Bad causal configuration fails loudly, before anything simulates.

```typescript
import { createGame, validateConfig } from "causality-engine/product";

const check = validateConfig({ ledgerDecayPerTick: 1.5 });
console.log(check.ok);        // false
console.log(check.errors);    // [{ field: "ledgerDecayPerTick", problem: "must be within the exclusive range (0, 1)", ... }]

createGame({ config: { ledgerDecayPerTick: 1.5 } });  // throws ConfigError
```

CE never silently corrects a config. A quietly-clamped threshold would change causal behaviour behind your back.

---

## Running as a service

CE also runs as a standalone WebSocket process, for cross-language integration or a dedicated server:

```bash
npm run serve      # ws://127.0.0.1:7778
```

Same causal semantics, different transport. See the Godot integration guide for a working adapter.

---

## Next steps

- **[API Reference](./API-REFERENCE.md)** — every function, grouped by concern
- **[Compatibility](./COMPATIBILITY.md)** — versioning, save compatibility, what breaks determinism
- **[examples/minimal-integration.ts](../examples/minimal-integration.ts)** — the complete loop as runnable code
- **Godot integration** — `godot-iso/README.md`

---

## Complete example

Run the full loop yourself:

```bash
npm run example
```
