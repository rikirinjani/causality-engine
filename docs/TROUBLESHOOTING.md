# Troubleshooting

Problems actually encountered building and packaging CE, with the real cause and
fix. Not an exhaustive manual.

---

## Installation

### `npm install causality-engine` — module not found on import

**Cause:** importing from a path the package does not export.

CE exports exactly three entry points:

```typescript
import { createGame } from "causality-engine";            // product surface
import { createGame } from "causality-engine/product";    // same, explicit
import { createWorld } from "causality-engine/engine";    // low-level, adapter authors
```

Deep imports such as `causality-engine/dist/core/world.js` are not part of the
contract and may break at any version.

### `ERR_MODULE_NOT_FOUND` for a relative path

**Cause:** CE is ESM with `NodeNext` resolution. Your project must be ESM too.

Add to your `package.json`:

```json
{ "type": "module" }
```

Or use `.mjs` files. CommonJS `require("causality-engine")` will not work.

### `engine "node" is incompatible`

**Cause:** Node below 20. CE uses `node:crypto` and ESM resolution features that
require it.

```bash
node --version   # must be >= 20
```

### No `dist/` after cloning the repository

**Cause:** the repository ships source, not build output.

```bash
npm install
npm run build
```

`npm run build` uses `tsconfig.build.json`, which excludes `src/poc` tooling and
tests. Running bare `tsc` instead will surface pre-existing type errors in
proof-of-concept tool files — those files are not part of the shipped package.

---

## CE runtime

### `connect_to_url failed` / connection refused

**Cause:** no CE runtime at the endpoint.

```bash
cd causality-engine
npm run serve
# CE WebSocket server running on ws://127.0.0.1:7778
```

Confirm the client agrees:

```gdscript
print(ce.endpoint())   # ws://127.0.0.1:7778
```

### `EADDRINUSE: address already in use 127.0.0.1:7778`

**Cause:** a CE runtime is already listening — often one left over from an earlier
run.

```bash
lsof -nP -iTCP:7778 -sTCP:LISTEN     # macOS / Linux
netstat -ano | findstr :7778         # Windows
```

Kill it, or start CE on another port and update the client's `port`.

### Connects, then closes immediately

**Cause:** wrong port. CE's HTTP server and WebSocket server listen on different
ports and are not interchangeable. The WS default is **7778**.

### Connection works from the same machine but not another

**Expected.** CE binds `127.0.0.1` by default and has **no authentication**.
Binding it to another interface exposes full world control to anything that can
reach the port. See `docs/DEPLOYMENT.md` — Security.

---

## Godot addon

### `Preload file "res://addons/causality_engine/..." does not exist`

**Cause:** the addon is not at that exact path. Godot resolves `res://` from the
project root.

```
your-project/
  project.godot
  addons/
    causality_engine/
      plugin.cfg
      ce_client.gd
      quantity.gd
```

This is also the expected error immediately after uninstalling the addon while
scenes still reference it.

### `CeClient` missing from the Add Node dialog

**Cause:** the plugin is not enabled. Enable it under **Project → Project
Settings → Plugins**.

You do not have to. The addon works without being enabled:

```gdscript
var ce := preload("res://addons/causality_engine/ce_client.gd").new()
add_child(ce)
```

### Parse error mentioning `is_connected` and `Callable`

**Cause:** a script declares `var is_connected`, which collides with Godot 4's
`Object.is_connected()` method.

The addon uses `connection_open` for this reason. If you added your own
`is_connected` variable, rename it.

### `create_world` appears to do nothing

**Not a fault.** Frames sent before the socket opens are queued and flushed on
open. Wait for the signal:

```gdscript
ce.connected.connect(func(_id, _tl):
    ce.create_world(42)
    ce.request_snapshot()
)
```

### Godot version mismatch

The addon needs Godot **4.3+** for the `WebSocketPeer` API, typed GDScript, and
`@export` annotations. On 4.2 or earlier it will not load.

See `docs/RUNTIME-REQUIREMENTS.md` for which versions were actually tested versus
expected-compatible.

---

## Events and delivery

### The same event arrives more than once

**Expected.** CE delivers **at-least-once**, not exactly-once. The `attempt`
counter tells you which delivery this is:

```gdscript
func _on_event(event: Dictionary) -> void:
    # attempt > 1 means redelivery
```

If your reaction is not idempotent, deduplicate on `event.id`.

### Events stop arriving

**Cause:** you are polling but not acknowledging. CE keeps redelivering
unacknowledged facts and the cursor never advances.

In-process:

```typescript
const stream = openEventStream(game);
stream.drain((event, meta) => render(event));   // polls, handles, acks
```

Over WebSocket, acknowledge explicitly:

```gdscript
ce.ack(highest_stream_seq)
```

### `gap` status / `gap_received` fired

**Expected and important.** CE bounds its event record. Facts were evicted before
your consumer read them.

CE reports this rather than silently skipping ahead. Recover by adopting CE's
present:

```gdscript
ce.gap_received.connect(func(gap):
    push_warning("missed %s..%s" % [gap.get("missingFromSeq"), gap.get("missingToSeq")])
    ce.request_snapshot()
)
```

In-process: `stream.recover()`.

### `wrong_timeline` status

**Cause:** the cursor was issued by a different timeline than the world you are
now polling. Happens after a fork, rewind, or timeline switch.

A cursor is only meaningful against the timeline that issued it. Re-register the
consumer or adopt a fresh sync.

---

## Interventions

### `ok: false` with `already destroyed`

**Correct behaviour.** CE refuses to destroy an already-destroyed structure. This
is idempotent rejection, not a bug. Surface it to the player; do not suppress it.

### `ok: false` with `location to equal target.id`

**Cause:** region-scoped actions require `location == target.id`.

```typescript
// wrong
intervene(game, { action: "hold_public_rally", target: { type: "region", id: "RF" }, location: "PS" });

// right
intervene(game, { action: "hold_public_rally", target: { type: "region", id: "RF" }, location: "RF" });
```

`hold_public_rally` and `grant_merchant_subsidy` are region-scoped.

### `unknown action`

Discover what CE accepts rather than guessing:

```typescript
import { listActions } from "causality-engine/product";
console.log(listActions().map(a => a.action));
```

### Nothing changed after an intervention

**Cause:** you did not advance time. CE has no clock.

```typescript
intervene(game, { ... });
step(game, 5);          // consequences unfold here
```

Interventions are deferred: they accumulate as causal pressure and resolve when a
threshold is crossed. A single tick may not be enough.

---

## Checkpoints and saves

### Checkpoint payload is empty

**Cause:** you read `last_checkpoint` after `state_updated` instead of waiting for
`checkpoint_ready`. Large checkpoints arrive in chunks and are reassembled first.

```gdscript
ce.checkpoint_ready.connect(func(cid, payload, delivery):
    save_to_disk(payload)
)
ce.checkpoint()
```

### `loadGame` returns `ok: false`

Read the errors — they are specific:

| Error prefix | Meaning |
|--------------|---------|
| parse / deserialize | Not valid checkpoint data |
| `schema_too_old` | Predates the migration floor |
| `schema_too_new` | Written by a newer CE |
| validation | Structurally invalid or corrupted |

CE never returns a partially-restored world.

### Restored world has a different `stateHash` than the checkpoint

**Two different situations.**

After **`loadGame`**, the hash must match. If it does not, report it.

After **`rewindGame`**, the hash is *expected* to differ. A rewound world takes a
new timeline identity, and lineage is part of world identity — a save must not be
able to claim an ancestry it does not have. The physics are identical; the
identity is not.

### Reloaded world redelivers events I already consumed

**Expected.** Save payloads deliberately exclude delivery cursors. A cursor
describes a reader, not the world; restoring one could reposition a consumer onto
different facts. A reloaded world starts with a fresh channel.

---

## Timelines

### Forked timeline has the same `stateHash` as its parent

**Possible and correct** if you have not diverged yet. A fork starts as a copy.
Apply a different intervention and advance; then the hashes differ.

### `compareTimelines` reports `stateHashEqual: false` but `physicsEqual: true`

**Correct.** Two branches converged to identical physics while retaining different
causal histories. CE never collapses them — `stateHash` includes lineage,
`traceHash` includes provenance.

### `rewindGame` rejected with `different world`

**Cause:** the checkpoint belongs to another world. Rewind only works within a
world's own lineage. Use `forkGame` to branch from an unrelated checkpoint.

---

## Explanation

### `explained: false` for a quantity that visibly changed

**Two possible causes.**

Wrong key format. Use the helpers rather than hand-writing strings:

```typescript
import { why, quantity } from "causality-engine/product";
why(game, quantity.price("RF", "grain"));
```

```gdscript
const Quantity = preload("res://addons/causality_engine/quantity.gd")
ce.request_explain(Quantity.price("RF", "grain"))
```

Or the change had no recorded cause — a value moved by ordinary tick dynamics
rather than by any intervention. CE says "not explained" rather than inventing a
reason.

### `incomplete: true`

**Expected, and it is telling you something.** The bounded provenance record
evicted ancestors, so the trace may be missing causes. An incomplete explanation
announces itself instead of masquerading as a complete one.

---

## Determinism

### Same seed produces different hashes

Check, in order:

1. Same config? Config is part of `stateHash` — different tuning is a different world.
2. Same intervention order? Order matters.
3. Same CE version? A version that changes causal behaviour re-baselines hashes.
4. Same platform? Verified on macOS arm64 and Windows x64; not formally proven elsewhere.

Verify the shipped baseline:

```bash
npm run verify:replay
# replay identical: true
# hash: 5404d32e6ca92e9e...
# matches: true
```

### `npm test` passes but my own replay assertion fails

Your recorded hash was taken under different conditions — different config,
different intervention order, or a different CE version. Re-record it after
confirming `verify:replay` still matches.

---

## Still stuck

1. `npm run verify:release` — full verification from your checkout
2. `npm run example` — known-good in-process loop
3. `godot --headless --path godot res://sample/verify_integration.tscn` — known-good Godot loop, 23 assertions

If those pass and your integration does not, the difference is in your
integration. If they fail, file an issue with the output.
