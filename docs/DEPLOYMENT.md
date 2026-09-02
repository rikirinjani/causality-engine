# Deploying Causality Engine

CE supports two runtime models. Pick one before you write integration code —
they have different dependency and deployment consequences.

---

## Model 1 — In-process

```
your application (TypeScript / JavaScript)
└── causality-engine (library)
```

CE runs inside your process as a library call. No network, no second process, no
port.

```bash
npm install causality-engine
```

```typescript
import { createGame, intervene, step, inspect } from "causality-engine/product";

const game = createGame({ seed: 42 });
intervene(game, {
  action: "destroy_infrastructure",
  target: { type: "infrastructure", id: "grain_road" },
  location: "RF",
});
step(game, 5);
console.log(inspect(game).regions.RF.prices.grain);
```

**Use when** your game or server is TypeScript/JavaScript.
**Cannot be used** from Godot, Unity, Unreal, or any non-JS runtime.

### Deployment

Nothing beyond your own application. CE has **zero runtime dependencies** in this
mode.

---

## Model 2 — Standalone runtime

```
your game (any language)
       │  WebSocket (JSON frames)
       ▼
CE runtime process (Node.js)
```

CE runs as its own process. Your game connects over WebSocket.

```bash
npm run serve
```

```
CE WebSocket server running on ws://127.0.0.1:7778
```

**Use when** your game is not JavaScript — this is the Godot path.

### Deployment

The CE process must be running wherever the game runs. Concretely:

| Scenario | What you must do |
|----------|------------------|
| Local development | Run `npm run serve` in a terminal |
| Shipped desktop game | Bundle a Node runtime and launch CE as a child process, or require Node as a prerequisite |
| Dedicated server | Run CE as a service alongside your game server |

This is a real deployment obligation. A Godot game that ships without a CE
runtime will connect to nothing.

---

## Requirements

| Requirement | Version | Applies to |
|-------------|---------|-----------|
| Node.js | **20+** | Both models |
| npm | 9+ | Install only |
| `ws` | ^8.21 | Standalone only (bundled dependency) |
| Godot | 4.3+ | Godot integration only |

CE uses `node:crypto` for SHA-256 state identity and ESM module resolution. Node
20 is the floor, not a preference.

Verified on Node 22.x (Windows x64) and Node 26.5 (macOS arm64).

---

## Configuration

### CE runtime

| Setting | Default | Change via |
|---------|---------|-----------|
| Port | `7778` | `startCeWsServer({ port })` |
| Bind address | `127.0.0.1` | Server construction |
| World seed | `42` | `startCeWsServer({ seed })` or the client's `create-world` |
| Backpressure limit | 64 KiB | `startCeWsServer({ bufferedAmountLimit })` |

The default bind address is deliberate. See Security below.

### Godot client

```gdscript
ce.host = "127.0.0.1"
ce.port = 7778
ce.use_tls = false
ce.auto_reconnect = true
ce.reconnect_delay_seconds = 2.0
ce.socket_buffer_bytes = 1 << 21   # 2 MiB
```

Expose these as project settings or a config file. Do not hard-code them into a
shipped build.

---

## Security

> **The CE WebSocket runtime has no authentication.**

It binds `127.0.0.1` by default, which keeps it reachable only from the same
machine.

If you bind it to any other interface, **anything that can reach the port can
create worlds, submit interventions, read full world state, and fork timelines.**
There is no credential, no token, no origin check, and no rate limit.

Adding authentication and transport security is **not part of CE v1.0.** If you
need CE reachable across a network, put your own authenticated proxy in front of
it and keep CE bound to localhost behind that proxy.

For single-player games running CE on the player's own machine, the localhost
default is appropriate and no additional work is required.

### Checklist before exposing CE beyond localhost

- [ ] Authenticated reverse proxy in front of CE
- [ ] TLS terminated at the proxy (`use_tls = true` on the client)
- [ ] CE still bound to `127.0.0.1`, reachable only from the proxy
- [ ] Rate limiting at the proxy
- [ ] Per-consumer isolation if multiple clients share a runtime

None of the above is provided by CE.

---

## Checkpoints and saves

`saveGame()` (in-process) and the `checkpoint` frame (standalone) produce an
**opaque string**. Store it; never parse it.

| Consideration | Guidance |
|---------------|----------|
| Where to store | Anywhere you store save data. Godot: `user://`. Server: blob column or object store. |
| Size | ~7–35 KB, grows with causal history |
| Format stability | **Not a public contract.** Internals change between versions. |
| Reading metadata | Use `inspectSave()` (in-process) rather than parsing |
| Delivery cursors | Deliberately **not** included — a reload starts with a fresh event channel |
| Chunking | Large checkpoints arrive in chunks over WS and are reassembled before `checkpoint_ready` fires |

### Version compatibility

| Situation | Behaviour |
|-----------|-----------|
| Same schema version | Loads directly |
| Older, at or above the migration floor | Forward-migrated automatically |
| Older than the floor | Rejected with a clear error |
| Newer than current | Rejected |
| Corrupted | Rejected by validation |

Rejection is always explicit. Loading never returns a partially-restored world.
See `docs/COMPATIBILITY.md`.

---

## Reconnect behaviour

CE's delivery cursor lives **outside** world state. A disconnect cannot touch the
simulation.

```
disconnect  → cursor persists, world untouched
reconnect   → CE redelivers from the cursor (at-least-once)
gap         → facts were evicted before you read them; CE reports it explicitly
```

The Godot client reconnects automatically when `auto_reconnect` is true. After
reconnecting, request a snapshot to re-adopt CE's present:

```gdscript
ce.connected.connect(func(_id, _tl): ce.request_snapshot())

ce.gap_received.connect(func(gap):
    push_warning("missed %s..%s" % [gap.get("missingFromSeq"), gap.get("missingToSeq")])
    ce.request_snapshot()
)
```

A gap is never silent, and recovery is never automatic — your game decides how to
handle a hole in its own history.

---

## Local development setup

Two terminals.

```bash
# Terminal 1 — CE runtime
cd causality-engine
npm install
npm run serve
```

```bash
# Terminal 2 — Godot
godot --path your-project
```

Verify the stack:

```bash
npm test                  # 746 tests
npm run verify:replay     # deterministic replay
npm run verify:invariants # frozen-invariant spot check
npm run example           # full loop, in-process
```

Godot side, with the runtime listening:

```bash
godot --headless --path godot res://sample/verify_integration.tscn
# => === RESULTS: 23 passed, 0 failed ===
```

---

## Production considerations

| Concern | Status in v1.0 |
|---------|----------------|
| Authentication | **Not provided.** Localhost only, or proxy it. |
| TLS | Client supports `wss://`; CE does not terminate TLS. Use a proxy. |
| Multiple concurrent games | One world per runtime process. Run one process per game. |
| Horizontal scaling | Not supported. CE is single-process, single-consumer. |
| Observability | Server logs to stdout. No metrics endpoint. |
| Graceful shutdown | Checkpoint before terminating; CE does not auto-persist. |
| Crash recovery | Restore from your most recent checkpoint. CE keeps no write-ahead log. |
| Determinism across hosts | Verified on macOS arm64 and Windows x64. Not formally proven. Re-verify on any new target. |

### Shipping checklist

- [ ] Runtime model chosen (Godot requires standalone)
- [ ] Node runtime bundled or documented as a prerequisite
- [ ] CE launched before, or by, the game
- [ ] Host and port configurable, not hard-coded
- [ ] `connection_failed` and `disconnected` handled in-game
- [ ] `gap_received` handled
- [ ] Checkpoint storage location decided
- [ ] Known-good `stateHash` recorded if you depend on replay
- [ ] CE bound to `127.0.0.1` unless an authenticated proxy exists
- [ ] Checkpoint written on quit

---

## What CE does not require

No database. No GPU. No internet. No cloud service. No LLM or ML runtime. No
native compilation. No platform-specific binaries.
