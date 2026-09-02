# Installing Causality Engine

CE ships in two independent pieces. You may need one or both.

| Piece | What it is | Who needs it |
|-------|-----------|--------------|
| **CE runtime** | The engine. TypeScript/Node. | Everyone. |
| **Godot addon** | GDScript client for the runtime. | Godot developers. |

> **Not yet published.** CE is not on npm and not in the Godot Asset Library.
> Every install below starts from a git clone. `npm install causality-engine`
> will fail with a 404 until publication.

---

## Part 1 — CE runtime

### Option A: in-process library (TypeScript / JavaScript games)

Build a local tarball and install it:

```bash
git clone https://github.com/rikirinjani/causality-engine.git
cd causality-engine
npm install
npm pack                 # produces causality-engine-<version>.tgz
```

Then, in your own project:

```bash
npm install /path/to/causality-engine-<version>.tgz
```

Your project must be ESM — add `"type": "module"` to its `package.json`.

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

No separate process, no network hop. See [GETTING-STARTED.md](./GETTING-STARTED.md).

After publication this becomes `npm install causality-engine`.

### Option B: standalone runtime (any language, including Godot)

```bash
git clone https://github.com/rikirinjani/causality-engine.git
cd causality-engine
npm install
npm run serve
```

```
CE WebSocket server running on ws://127.0.0.1:7778
```

Leave this running. Your game connects over WebSocket; the runtime is
language-agnostic.

If you see `EADDRINUSE`, a CE runtime is already listening on 7778 — reuse it or
stop it first.

Your game connects over WebSocket. The runtime is language-agnostic.

**Node 20+ is required for both options.** This is a real dependency, not an
implementation detail: if you ship a Godot game using Option B, the CE runtime
process must be running wherever the game runs.

---

## Part 2 — Godot addon

### Install

Copy the addon directory into your project:

```
your-godot-project/
  project.godot
  addons/
    causality_engine/          <- copy this whole directory
      plugin.cfg
      plugin.gd
      ce_client.gd
      quantity.gd
      icon.svg
      README.md
```

From a cloned CE repository:

```bash
cp -r causality-engine/godot/addons/causality_engine \
      your-godot-project/addons/
```

The `addons/` directory may not exist yet in a brand-new project — create it
first (`mkdir -p your-godot-project/addons`).

### Enable (optional)

**Project → Project Settings → Plugins → Causality Engine → Enable**

Enabling only registers `CeClient` in the Add Node dialog. The addon works
without it — `ce_client.gd` is a plain script you can instantiate.

### Verify

Create `verify_ce.gd` in your project root:

```gdscript
extends Node

func _ready() -> void:
    var ce := preload("res://addons/causality_engine/ce_client.gd").new()
    add_child(ce)
    ce.connected.connect(func(id, _timeline_id): print("CE connected: ", id))
    ce.connect_to_ce()

    # Headless runs need an explicit exit; a windowed run does not.
    await get_tree().create_timer(5.0).timeout
    print("connection_open=", ce.connection_open)
    get_tree().quit(0 if ce.connection_open else 1)
```

Attach it to a `Node` in a scene, then run:

```bash
godot --headless --path your-godot-project res://your_scene.tscn
```

With the runtime listening you should see:

```
CE connected: ws-1
connection_open=true
```

If it prints nothing, the runtime is not reachable — check
`print(ce.endpoint())` and that `npm run serve` is running.

### Requirements

- Godot **4.3+** — tested on 4.3, 4.4, and 4.7.2
- A reachable CE runtime (Part 1, Option B)

The addon has no other dependency. It reads no file outside its own directory
and contains no absolute paths.

---

## Configuration

Set these on the client before `connect_to_ce()`:

```gdscript
ce.host = "127.0.0.1"      # CE runtime host
ce.port = 7778             # CE runtime port
ce.use_tls = false         # wss:// instead of ws://
ce.auto_reconnect = true   # reconnect after unexpected close
ce.verbose = false         # log every frame (development aid)
```

Ship them as exported properties, project settings, or a config file — the addon
does not care. Nothing is hard-coded to a developer machine.

The port default is **7778**. CE's HTTP server uses a different port; they are
not interchangeable.

---

## Verify the whole stack

```bash
cd causality-engine

npm run verify:release   # typecheck + 746 tests + replay + invariants
npm run example          # full loop, in-process
```

Godot side, with the runtime already listening:

```bash
godot --headless --path godot res://sample/verify_integration.tscn
```

Expected:

```
=== RESULTS: 23 passed, 0 failed ===
```

Note: bare `tsc` (`npm run check`) reports pre-existing type errors in
`src/poc` proof-of-concept tooling. Those files are not shipped. Use
`npm run check:dist` or `npm run verify:release`, which typecheck only the code
that ships.

---

## Uninstall

Delete `addons/causality_engine/` from your project. Nothing else is written
anywhere. Scenes that referenced the client will report missing preloads until
you remove those references too.

---

## Troubleshooting

**`connect_to_url failed`** — no runtime at the endpoint. Check `ce.endpoint()`
and that `npm run serve` is running.

**Connects then closes** — wrong port, or something else is bound to 7778.

**`Preload file does not exist`** — the addon is not at
`res://addons/causality_engine/`. Godot needs that exact path.

**Nothing happens after `create_world`** — frames sent before the socket opens
are queued and flushed on open. Wait for the `connected` signal.

**`CeClient` missing from Add Node** — enable the plugin in Project Settings, or
instantiate the script directly.

More: [addons/causality_engine/README.md](../godot/addons/causality_engine/README.md)
