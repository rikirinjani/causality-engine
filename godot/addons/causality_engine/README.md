# Causality Engine — Godot Addon

Connect a Godot game to the Causality Engine: a deterministic causal
world-simulation layer.

CE owns world state, causal propagation, RNG, events, provenance, branching and
rewind. Godot renders. This addon translates between them.

---

## Install

Copy `addons/causality_engine/` into your project's `addons/` directory:

```
your-project/
  project.godot
  addons/
    causality_engine/
      plugin.cfg
      plugin.gd
      ce_client.gd
      quantity.gd
      icon.svg
```

Optionally enable it in **Project → Project Settings → Plugins** to get
`CeClient` in the Add Node dialog. The addon works without being enabled —
`ce_client.gd` is a plain script you can instantiate directly.

## Requires

- **Godot 4.3+**
- **A reachable CE runtime** on a WebSocket endpoint (default `ws://127.0.0.1:7778`)

The CE runtime is a separate process. See `RUNTIME-REQUIREMENTS.md`.

---

## Quick start

```gdscript
extends Node2D

var ce: Node

func _ready() -> void:
    ce = preload("res://addons/causality_engine/ce_client.gd").new()
    ce.host = "127.0.0.1"
    ce.port = 7778
    add_child(ce)

    ce.connected.connect(_on_connected)
    ce.state_updated.connect(_on_state)
    ce.event_received.connect(_on_event)

    ce.connect_to_ce()

func _on_connected(consumer_id: String, timeline_id: String) -> void:
    ce.create_world(42)
    ce.request_snapshot()

func _on_state() -> void:
    # CE is the authority. Render what it reports; never compute it yourself.
    var price: float = ce.grain_price("RF")
    var bridge_up: bool = ce.is_structure_intact("RF", "grain_road")
    print("tick %d  grain %.2f  bridge %s" % [ce.tick, price, bridge_up])

func _on_event(event: Dictionary) -> void:
    print("CE event: ", event.get("type", "?"))

func _on_player_destroys_bridge() -> void:
    ce.submit_intervention("destroy_infrastructure", "grain_road", "infrastructure", "RF")
    ce.advance(5)
    ce.request_snapshot()
```

---

## The authority boundary

| Layer | Owns |
|-------|------|
| **Your game** | rendering, animation, camera, UI, input, audio, presentation |
| **This addon** | intent → intervention, CE state → projection, transport, reconnect |
| **CE** | world state, causal rules, propagation, RNG, events, provenance, persistence, branching, rewind |

**Put no causal rule and no RNG in your game.** If your game decides that
destroying a bridge raises grain prices, CE is no longer the authority and
determinism, attribution, and branching all stop meaning anything.

This addon contains no `randi`, `randf`, `randomize`, or `RandomNumberGenerator`.
Keep it that way.

---

## API

### Configuration

Set before `connect_to_ce()`:

| Property | Default | Meaning |
|----------|---------|---------|
| `host` | `"127.0.0.1"` | CE runtime host |
| `port` | `7778` | CE runtime port |
| `use_tls` | `false` | Use `wss://` |
| `auto_poll` | `true` | Poll socket each frame |
| `auto_reconnect` | `true` | Reconnect after unexpected close |
| `reconnect_delay_seconds` | `2.0` | Wait between attempts |
| `socket_buffer_bytes` | 2 MiB | Raises Godot's ~64 KiB default |
| `verbose` | `false` | Log every frame |
| `event_history_limit` | `100` | Local `recent_events` cap |

### Connection

```gdscript
ce.connect_to_ce()
ce.disconnect_from_ce()
ce.endpoint()          # -> "ws://127.0.0.1:7778"
ce.poll(delta)         # only when auto_poll = false
```

### World

```gdscript
ce.create_world(42)
ce.request_snapshot()      # full projection incl. infrastructure
ce.request_state_sync()    # compact; no infrastructure detail
ce.advance(5)
ce.ping()
```

### Interventions

```gdscript
ce.submit_intervention("destroy_infrastructure", "grain_road", "infrastructure", "RF")
ce.submit_intervention("grant_merchant_subsidy", "RF", "region", "RF")
ce.submit_batch([...])
```

CE decides acceptance. Listen to `intervention_result(ok, errors)`.

### Events

```gdscript
ce.ack(stream_seq)     # at-least-once: acknowledge what you have
ce.resync(sync)        # recover after a gap
```

### Persistence

```gdscript
ce.checkpoint()                              # -> checkpoint_ready signal
ce.restore(payload, delivery_payload)        # -> restored signal
```

### Timelines

```gdscript
ce.fork(checkpoint_id, "B")
ce.rewind(checkpoint_id)
ce.switch_timeline(timeline_id)
ce.list_timelines()
ce.timeline_info(timeline_id)
ce.compare_timelines(a_id, b_id)
```

### Explanation

```gdscript
ce.request_explain(Quantity.price("RF", "grain"))
ce.request_explain(Quantity.hostility("MG"))
ce.request_explain(Quantity.infra("RF", "grain_road"))
```

Answers arrive on `explanation_received(quantity, explanation)`. The explanation
is CE's own causal attribution — this addon never infers causality.

### Reading state

```gdscript
ce.tick                              # int
ce.state_hash                        # physical world identity
ce.trace_hash                        # causal-history identity
ce.timeline_id
ce.regions                           # projected region map
ce.factions                          # projected hostility map
ce.recent_events                     # local convenience buffer

ce.region("RF")
ce.grain_price("RF")
ce.is_structure_intact("RF", "grain_road")
ce.hostility("MG")
```

Treat every one of these as read-only. Writing to them would make your game
disagree with CE about what is true.

### Signals

| Signal | Fires when |
|--------|-----------|
| `connected(consumer_id, timeline_id)` | CE welcomed the client |
| `disconnected(will_retry)` | Socket closed |
| `connection_failed(reason)` | Could not establish |
| `state_updated` | Authoritative state applied |
| `event_received(event)` | One CE fact, canonical order |
| `gap_received(gap)` | Facts evicted before you read them |
| `explanation_received(quantity, explanation)` | explain answered |
| `checkpoint_ready(id, payload, delivery)` | Checkpoint reassembled |
| `restored(tick, state_hash)` | World restored |
| `forked(timeline_id, parent_id)` | New timeline created |
| `rewound(timeline_id, abandoned_id)` | Timeline rewound |
| `switched(timeline_id)` | Observation switched |
| `timelines_received(timelines)` | Registry received |
| `comparison_received(comparison)` | Comparison received |
| `intervention_result(ok, errors)` | CE accepted or rejected |

---

## Gaps are never silent

CE bounds its event record. If facts are evicted before your consumer reads them,
CE reports a **gap** rather than quietly skipping ahead:

```gdscript
func _on_gap(gap: Dictionary) -> void:
    push_warning("missed facts %s..%s" % [gap.get("missingFromSeq"), gap.get("missingToSeq")])
    ce.request_snapshot()   # adopt CE's present
```

The same applies to explanations: an `explanation` with `incomplete: true` is
announcing that its trace may be missing ancestors, not pretending to be whole.

---

## Troubleshooting

**Never connects.** No CE runtime at the endpoint. Check `ce.endpoint()` and that
the runtime is listening. `connection_failed` carries the reason.

**Connects then closes immediately.** Wrong port, or something else is bound to
it. CE's HTTP server and WS server use different ports.

**`create_world` seems ignored.** Frames sent before the socket opens are queued
and flushed on open — this is normal. Wait for `connected` before assuming a
problem.

**Checkpoint payload is empty.** Wait for `checkpoint_ready`, not `state_updated`.
Large checkpoints arrive in chunks and are reassembled first.

**Infrastructure looks intact after destroying it.** `request_state_sync()`
carries no infrastructure detail. Use `request_snapshot()`.

**Sample values differ from the docs.** Different seed, or a different CE version.
Same seed plus same interventions must give the same `state_hash`; if it does not,
report it.

---

## License

Apache-2.0
