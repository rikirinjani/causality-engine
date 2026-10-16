Causality Engine 1.0.0-rc.1 — release candidate

A deterministic causal world-simulation layer for games. CE owns world state,
causal propagation, RNG, events, provenance, branching and rewind. Your game
renders.

This is a RELEASE CANDIDATE, not a 1.0.0 release. See "Release status" below for
what is and is not yet true.

## Assets

| Asset | Use |
|-------|-----|
| `causality-engine-1.0.0-rc.1.tgz` | npm package. `npm install ./causality-engine-1.0.0-rc.1.tgz` |
| `causality-engine-godot-addon-1.0.0-rc.1.zip` | Godot addon. Unzip into `your-project/addons/` |

Both are downloadable directly from this release — no repository clone required.

## Install

### TypeScript / JavaScript (in-process)

```bash
npm install ./causality-engine-1.0.0-rc.1.tgz
```

Your project must be ESM (`"type": "module"`).

```typescript
import { createGame, intervene, step, inspect } from "causality-engine/product";

const game = createGame({ seed: 42 });
intervene(game, {
  action: "destroy_infrastructure",
  target: { type: "infrastructure", id: "grain_road" },
  location: "RF",
});
step(game, 5);
console.log(inspect(game).regions.RF.prices.grain);   // 13.13
```

### Godot (standalone runtime)

Unzip the addon into `your-project/addons/`, then start a CE runtime:

```bash
git clone https://github.com/rikirinjani/causality-engine.git
cd causality-engine && npm install && npm run serve
```

```gdscript
var ce := preload("res://addons/causality_engine/ce_client.gd").new()
add_child(ce)
ce.connected.connect(func(id, _tl): print("CE connected: ", id))
ce.connect_to_ce()
```

Requires Node.js 20+ and Godot 4.3+.

## Documentation

`docs/GETTING-STARTED.md` · `docs/INSTALLATION.md` · `docs/API-REFERENCE.md` ·
`docs/GODOT-INTEGRATION.md` · `docs/DEPLOYMENT.md` · `docs/COMPATIBILITY.md` ·
`docs/TROUBLESHOOTING.md`

## Verified at this tag

| Check | Result |
|-------|--------|
| CE test suite | 746 / 746 |
| Clean-consumer suite (packed tarball, outside repo) | 51 / 51 |
| Godot 4.3 integration | 23 / 23 |
| Godot 4.4 integration | 23 / 23 |
| Godot 4.7.2 integration | 23 / 23 |
| Deterministic replay | `5404d32e` matches the P-014 baseline |
| Tarball audit | PASS — 162 entries, 9 exclusions absent, 14 required present |
| Hosted CI | Green across 3 OS x 2 Node versions |
| Frozen invariants | 12 / 12 unchanged |

Determinism confirmed on Linux x64, macOS arm64, and Windows x64 under Node 20
and 22 — all six combinations produce `5404d32e`.

## Release status

**Not published to npm.** `npm install causality-engine` will 404. Install from
the tarball attached here.

**No independent developer validation yet.** Every test above was written and run
by the authors. That is the reason this is `rc.1` and not `1.0.0`.

## Known limitations

- **The WebSocket runtime has no authentication** and binds `127.0.0.1`. Exposing
  it beyond localhost requires a security layer that is not part of CE. See
  `docs/DEPLOYMENT.md`.
- Single process. No IPC, no distributed simulation, no multiplayer.
- At-least-once event delivery, not exactly-once. Consumers must tolerate
  redelivery.
- Bounded event and provenance records. Eviction is always reported, never silent.
- No formal determinism proof — empirically validated, not proven.
- Not a game engine. No rendering, animation, input, or audio.
- Godot support tested on 4.3, 4.4, 4.7.2. Versions 4.5 and 4.6 are untested and
  not claimed.

## Feedback

If you try this, the most useful thing you can report is where the documentation
failed you. Open an issue.
