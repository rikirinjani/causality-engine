# Godot Integration Guide

How to put CE behind a Godot game — and where the line between them sits.

---

## The boundary

```
        PLAYER INPUT
             │
    ┌────────▼─────────┐
    │      GODOT       │  rendering, animation, camera, UI, input, audio
    └────────┬─────────┘
             │  player intent
    ┌────────▼─────────┐
    │    CeClient      │  intent -> intervention, CE state -> projection,
    │    (addon)       │  transport, reconnect, recovery
    └────────┬─────────┘
             │  WebSocket (JSON)
    ┌────────▼─────────┐
    │  CE RUNTIME      │  world state, causal rules, propagation, RNG,
    │                  │  events, provenance, persistence, branching, rewind
    └──────────────────┘
```

Consequences flow back up as CE state and CE events. Godot projects them.

### The rule that makes everything else work

**Godot decides what the player did. CE decides what it caused.**

If your game computes that destroying a bridge raises grain prices, CE is no
longer the authority — and determinism, causal attribution, and branching all
stop meaning anything, because CE's account of the world and your game's account
have diverged.

| Godot may own | Godot must not own |
|---------------|--------------------|
| rendering, animation, camera | causal propagation |
| UI, input, audio | RNG affecting the world |
| visual interpolation | world-state mutation |
| translating player intent | economic or faction consequences |
| presenting CE values | timeline semantics |
| | intervention acceptance rules |

The addon contains no `randi`, `randf`, `randomize`, or `RandomNumberGenerator`.
Keep your integration the same way.

---

## Minimal integration

```gdscript
extends Node2D

var ce: Node
var bridge_sprite: ColorRect

func _ready() -> void:
    ce = preload("res://addons/causality_engine/ce_client.gd").new()
    ce.host = "127.0.0.1"
    ce.port = 7778
    add_child(ce)

    ce.connected.connect(_on_connected)
    ce.state_updated.connect(_on_state_updated)
    ce.event_received.connect(_on_event)

    ce.connect_to_ce()

func _on_connected(_consumer_id: String, _timeline_id: String) -> void:
    ce.create_world(42)
    ce.request_snapshot()

func _on_state_updated() -> void:
    # Project. Never compute.
    bridge_sprite.visible = ce.is_structure_intact("RF", "grain_road")

func _on_event(event: Dictionary) -> void:
    match event.get("type", ""):
        "economy.price_shock": _play_price_sting()
        "faction.hostility_increase": _flash_faction_banner()

func _on_player_destroyed_bridge() -> void:
    ce.submit_intervention("destroy_infrastructure", "grain_road", "infrastructure", "RF")
    ce.advance(5)
    ce.request_snapshot()
```

---

## Cadence

CE has no clock. Nothing happens until you call `advance()`.

```gdscript
# One tick per frame
func _process(_delta: float) -> void:
    ce.advance(1)

# Or turn-based
func _on_end_turn() -> void:
    ce.advance(24)

# Or only after player action
func _on_player_acted() -> void:
    ce.submit_intervention(...)
    ce.advance(5)
```

Three clocks stay independent: CE's tick, the adapter's visibility, and Godot's
render frame. CE never requires real-time sync.

---

## Reading state

Everything on the client is a projection of what CE reported.

```gdscript
ce.tick                                     # int
ce.state_hash                               # physical world identity
ce.trace_hash                               # causal-history identity
ce.timeline_id

ce.grain_price("RF")                        # float
ce.is_structure_intact("RF", "grain_road")  # bool
ce.hostility("MG")                          # float
ce.region("RF")                             # full projected region
```

Treat all of it as read-only. Writing a local value makes your game disagree with
CE about what is true — and CE is right.

`request_snapshot()` includes infrastructure health.
`request_state_sync()` is smaller and does **not**. Use snapshot when structure
state matters.

---

## Interventions

```gdscript
ce.submit_intervention("destroy_infrastructure", "grain_road", "infrastructure", "RF")
ce.submit_intervention("grant_merchant_subsidy", "RF", "region", "RF")
ce.submit_intervention("hold_public_rally", "RF", "region", "RF")
ce.submit_intervention("kill_entity", "a07", "entity", "RF")
```

CE decides acceptance:

```gdscript
ce.intervention_result.connect(func(ok: bool, errors: Array) -> void:
    if not ok:
        show_toast("Cannot do that: " + ", ".join(errors))
)
```

Rejection is normal and meaningful — destroying an already-destroyed bridge is
refused. Surface it; do not suppress it.

Region-scoped actions (`hold_public_rally`, `grant_merchant_subsidy`) require
`location == target_id`.

---

## Events

CE events are **historical facts**, not commands. Ordering is canonical, delivery
is at-least-once, and each fact carries a stable `streamSeq`.

```gdscript
func _on_event(event: Dictionary) -> void:
    var type: String = event.get("type", "")
    var data: Dictionary = event.get("data", {})
    # React presentationally. Do not recompute the consequence.
```

An event may arrive more than once. If your reaction is not idempotent, track
`event.id`.

### Gaps

CE bounds its event record. If facts are evicted before you read them, CE says so:

```gdscript
ce.gap_received.connect(func(gap: Dictionary) -> void:
    push_warning("missed %s..%s" % [gap.get("missingFromSeq"), gap.get("missingToSeq")])
    ce.request_snapshot()   # adopt CE's present
)
```

A gap is never silent, and recovery is never automatic — the game decides how to
handle a hole in its own history.

---

## Checkpoints

```gdscript
ce.checkpoint_ready.connect(func(cid: String, payload: String, delivery: String) -> void:
    var file := FileAccess.open("user://save1.ce", FileAccess.WRITE)
    file.store_string(payload)
    file.close()
    my_checkpoint_id = cid
)

ce.checkpoint()   # then wait for the signal
```

The payload is opaque. Store it; never parse it.

```gdscript
func load_save() -> void:
    var file := FileAccess.open("user://save1.ce", FileAccess.READ)
    ce.restore(file.get_as_text())
    file.close()
```

Large checkpoints arrive in chunks and are reassembled before the signal fires.
Wait for `checkpoint_ready`, not `state_updated`.

---

## Branching and rewind

Save points are also branch points.

```gdscript
# Capture
ce.checkpoint()   # -> checkpoint_ready gives you cid

# Undo: abandon the future, resume the past
ce.rewind(cid)

# What-if: an independent timeline from the same point
ce.fork(cid, "B")
ce.submit_intervention("grant_merchant_subsidy", "RF", "region", "RF")
ce.advance(5)

# Compare
ce.list_timelines()
ce.compare_timelines(timeline_a_id, timeline_b_id)

ce.comparison_received.connect(func(cmp: Dictionary) -> void:
    print("worlds differ: ", not cmp.get("stateHashEqual", true))
    print("histories differ: ", not cmp.get("traceHashEqual", true))
)
```

`stateHashEqual` and `traceHashEqual` are separate. Two branches can converge to
identical physics while keeping different histories. CE never collapses them.

A rewound world takes a **new** timeline identity. Its physics match the
checkpoint exactly, but its `stateHash` differs, because lineage is part of world
identity — a save cannot claim an ancestry it does not have.

---

## Explanation

```gdscript
const Quantity = preload("res://addons/causality_engine/quantity.gd")

ce.request_explain(Quantity.price("RF", "grain"))

ce.explanation_received.connect(func(quantity: String, explanation: Dictionary) -> void:
    if not explanation.get("explained", false):
        show_text("No recorded cause.")
        return
    if explanation.get("incomplete", false):
        show_text("(some history was evicted)")
    for root in explanation.get("roots", []).slice(0, 3):
        var r: Dictionary = root
        show_text("%s on %s at tick %s" % [r.get("action"), r.get("targetId"), r.get("tick")])
)
```

This is CE's causal attribution. The addon never infers causality — if CE cannot
explain something, it says so rather than inventing a reason.

---

## Reconnection

```gdscript
ce.auto_reconnect = true
ce.reconnect_delay_seconds = 2.0

ce.disconnected.connect(func(will_retry: bool) -> void:
    show_banner("CE disconnected" + (" — reconnecting" if will_retry else ""))
)

ce.connected.connect(func(_id: String, _tl: String) -> void:
    hide_banner()
    ce.request_snapshot()   # re-adopt CE's present after any gap
)
```

CE's delivery cursor lives outside world state, so a disconnect never touches the
simulation. On reconnect, CE redelivers from the cursor.

---

## CE state vs presentation state

Keep them separate, and know which is which.

| CE state (authoritative) | Presentation state (yours) |
|--------------------------|----------------------------|
| grain price | market stall colour |
| structure health | bridge sprite visibility |
| faction hostility | banner tint, music stem |
| tick | animation timers |
| timeline identity | camera position |
| event stream | particle bursts |

Right:

```gdscript
market.color = Color(0.8, 0.55 - min(ce.grain_price("RF") - 10.0, 10.0) * 0.03, 0.25)
```

Wrong:

```gdscript
# NEVER. This is a causal rule, and it belongs in CE.
if not ce.is_structure_intact("RF", "grain_road"):
    my_local_price += 3.0
```

---

## Reference implementations

| Project | Purpose |
|---------|---------|
| `godot/sample/minimal_sample.tscn` | Smallest complete loop |
| `godot/sample/verify_integration.tscn` | Headless verification, 23 assertions |
| `godot-iso/` | Medieval town vertical slice (12-step demo) |

---

## Audit your own integration

Before shipping:

```bash
grep -rn 'randi\|randf\|randomize\|RandomNumberGenerator' your-project/*.gd
```

Any hit in code that affects the world is a boundary violation.

Then ask, for each number your game displays: **did CE tell me this, or did I
decide it?** If your game decided a world value, that decision belongs in CE.
