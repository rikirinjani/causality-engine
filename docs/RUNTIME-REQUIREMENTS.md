# Runtime Requirements

What you actually need, separated by who needs it. Nothing here is hidden in
implementation notes.

---

## Required by the CE runtime

| Requirement | Version | Why |
|-------------|---------|-----|
| **Node.js** | 20+ | CE is TypeScript/ESM. Uses `node:crypto` for SHA-256 state identity. |
| **npm** | 9+ | Dependency install. |

CE's only runtime dependency is `ws` (WebSocket), and only in standalone mode.
In-process mode has **zero** runtime dependencies.

### In-process mode

```
your TS/JS game process
└── causality-engine (library)
```

Nothing else. No network, no second process, no port.

### Standalone mode

```
your game process (any language)
       │  WebSocket
       ▼
CE runtime process (Node)
```

The CE process must be running wherever the game runs. For a shipped desktop
game that means bundling a Node runtime or launching CE as a child process. This
is a genuine deployment requirement, not an inconvenience to paper over.

---

## Required by the Godot addon

| Requirement | Version | Why |
|-------------|---------|-----|
| **Godot** | 4.3+ | `WebSocketPeer` API, typed GDScript, `@export` annotations. |
| **CE runtime** | standalone mode | The addon is a client. It does not embed CE. |
| **Network reachability** | — | Default `ws://127.0.0.1:7778`. |

The addon needs **no** Node installation on the Godot side and **no** access to
CE source. It speaks the WebSocket protocol and nothing else.

Verified on Godot 4.7.2 (macOS arm64). Should work on any 4.3+ build; if it does
not, report it.

---

## Required only by the sample and demo

| Requirement | Needed for | Not needed for |
|-------------|-----------|----------------|
| CE repository clone | running the bundled sample, the medieval demo, the CE test suite | shipping a game |
| `tsx` | `npm run serve`, `npm run example` | production (use `npm run build` output) |
| `vitest` | CE's own test suite | anything you ship |

None of this is required by a shipped game.

---

## Network contract

| Setting | Default | Notes |
|---------|---------|-------|
| Protocol | `ws://` | `wss://` via `use_tls = true` |
| Host | `127.0.0.1` | Configurable |
| Port | `7778` | Configurable. Distinct from CE's HTTP port. |
| Frames | JSON text | Not binary |
| Auth | **none** | See below |

### Security

**The CE WebSocket runtime has no authentication.** It binds to `127.0.0.1` by
default, which keeps it local-only.

If you bind it to a public interface, anything that can reach the port can create
worlds, submit interventions, and read state. Before exposing CE beyond
localhost, put authentication and transport security in front of it. CE does not
provide either.

For single-player games on one machine, the localhost default is appropriate.

---

## Determinism requirements

CE guarantees: same seed + same config + same interventions in the same order →
same `stateHash` at every tick.

That holds when:

- the world was created with the same seed
- the same config was used (config is part of `stateHash`)
- interventions were submitted in the same order
- the same CE version is running

Verified identical on:

| Platform | Arch | Node |
|----------|------|------|
| macOS 26.6 | arm64 (Apple M4) | 26.5.0 |
| Windows 11 | x64 | 22.x |

Not formally proven across all platforms. CE relies on IEEE-754 double
arithmetic and deterministic key ordering. If you ship somewhere outside the
verified set and determinism matters, run your own replay comparison first.

---

## Resource characteristics

Measured on Apple M4, PoC-scale world (3 regions, 20 entities):

| Metric | Value |
|--------|-------|
| Full CE test suite | ~4.3 s (746 tests) |
| Event retention | 500 events (bounded, configurable) |
| Checkpoint size | ~7–35 KB serialized, grows with history |
| Godot render (demo) | ~145 FPS |

**Hardware-specific.** Do not generalise these numbers.

---

## What CE does not require

- No database
- No GPU
- No internet connection
- No cloud service
- No LLM or ML runtime
- No native compilation
- No platform-specific binaries

---

## Deployment checklist

Shipping a Godot game backed by CE:

- [ ] Decide in-process vs standalone (Godot needs standalone)
- [ ] Bundle a Node runtime, or require one
- [ ] Launch CE before, or from, the game
- [ ] Make host/port configurable, not hard-coded
- [ ] Handle `connection_failed` and `disconnected` in-game
- [ ] Handle `gap_received` — CE reports eviction explicitly
- [ ] Decide where checkpoint payloads are stored
- [ ] Record a known-good `stateHash` if you depend on replay
- [ ] Keep CE on `127.0.0.1` unless you have added auth
