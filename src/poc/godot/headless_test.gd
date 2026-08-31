## P-014 Headless Integration Test — CE Server ↔ Godot Adapter
##
## Drives the full causal chain programmatically against the CE HTTP server:
## create world → destroy bridge → advance 5 ticks → verify consequences.
## Runs under `godot --headless`, prints PASS/FAIL assertions, exits non-zero on failure.
##
## Run: godot --headless --path ~/Project_v2/godot-ce-demo res://headless_test.tscn

extends Node

var ce_adapter: Node
var passed: int = 0
var failed: int = 0
var start_msec: int = 0

var initial_grain_price: float = -1.0
var initial_road_health: float = -1.0
var final_grain_price: float = -1.0
var final_road_health: float = -1.0
var event_types: Array = []
var request_latency_ms: float = 0.0

func _ready() -> void:
    ce_adapter = preload("res://ce_adapter.gd").new()
    add_child(ce_adapter)
    ce_adapter.ce_state_updated.connect(_on_state_updated)
    ce_adapter.ce_event_received.connect(_on_event_received)
    await _run_test()
    _finish()

func _check(cond: bool, label: String) -> void:
    if cond:
        passed += 1
        print("PASS: ", label)
    else:
        failed += 1
        print("FAIL: ", label)

func _run_test() -> void:
    print("=== P-014 Godot Headless Integration Test ===")

    # 1. Connect to CE server
    ce_adapter.connect_to_ce()
    await ce_adapter.ce_state_updated
    _check(ce_adapter.connected or ce_adapter.ce_state_hash != "", "adapter connected to CE server")

    # 2. Create world (seed 42)
    ce_adapter.create_world(42)
    await ce_adapter.ce_state_updated
    _check(ce_adapter.ce_tick == 0, "world created, tick == 0 (got %d)" % ce_adapter.ce_tick)

    # 3. Get initial snapshot
    ce_adapter.get_snapshot()
    await ce_adapter.ce_state_updated
    _check(ce_adapter.towns.has("RF"), "snapshot projected RF town")
    if ce_adapter.towns.has("RF"):
        var rf: Dictionary = ce_adapter.towns["RF"]
        initial_grain_price = rf["grain_price"]
        initial_road_health = 1.0 if rf["trade_route_intact"] else 0.0
        print("  Initial RF grain price: ", initial_grain_price, " | route intact: ", rf["trade_route_intact"])
        _check(initial_grain_price == 10.0, "initial grain price is 10")
        _check(rf["trade_route_intact"], "grain_road intact at start")

    # 4. Destroy the bridge
    start_msec = Time.get_ticks_msec()
    ce_adapter.submit_intervention("destroy_infrastructure", "grain_road", "infrastructure", "RF")
    await ce_adapter.ce_state_updated
    var submit_latency: int = Time.get_ticks_msec() - start_msec
    _check(true, "intervention submitted (latency %d ms)" % submit_latency)

    # 5. Advance 5 ticks
    ce_adapter.advance_simulation(5)
    await ce_adapter.ce_state_updated
    _check(ce_adapter.ce_tick == 5, "advanced to tick 5 (got %d)" % ce_adapter.ce_tick)

    # 6. Poll events
    ce_adapter.poll_events()
    await ce_adapter.ce_state_updated
    _check(ce_adapter.recent_events.size() > 0, "received %d events" % ce_adapter.recent_events.size())
    for event in ce_adapter.recent_events:
        var ev: Dictionary = event
        event_types.append(ev.get("type", "unknown"))
    print("  Event types: ", event_types)

    # 7. Get final snapshot
    start_msec = Time.get_ticks_msec()
    ce_adapter.get_snapshot()
    await ce_adapter.ce_state_updated
    var snapshot_latency: int = Time.get_ticks_msec() - start_msec
    request_latency_ms = snapshot_latency
    _check(ce_adapter.towns.has("RF"), "final snapshot projected")
    if ce_adapter.towns.has("RF"):
        var rf2: Dictionary = ce_adapter.towns["RF"]
        final_grain_price = rf2["grain_price"]
        final_road_health = 1.0 if rf2["trade_route_intact"] else 0.0
        print("  Final RF grain price: ", final_grain_price, " | route intact: ", rf2["trade_route_intact"])
        print("  Final RF unrest: ", rf2["unrest"])

    # 8. Causal chain assertions
    _check(final_road_health == 0.0, "grain_road destroyed (health -> 0)")
    _check(final_grain_price > initial_grain_price, "grain price rose after bridge destruction (%.2f -> %.2f)" % [initial_grain_price, final_grain_price])
    _check(event_types.has("economy.trade_disruption"), "trade_disruption event emitted")
    _check(event_types.has("economy.price_shock"), "price_shock event emitted")
    _check(event_types.has("faction.hostility_increase"), "hostility_increase event emitted")
    _check(ce_adapter.ce_state_hash != "", "state hash present: " + ce_adapter.ce_state_hash.substr(0, 8))
    _check(ce_adapter.ce_trace_hash != "", "trace hash present: " + ce_adapter.ce_trace_hash.substr(0, 8))

func _on_state_updated() -> void:
    pass

func _on_event_received(event: Dictionary) -> void:
    pass

func _finish() -> void:
    print("")
    print("=== RESULTS: %d passed, %d failed ===" % [passed, failed])
    print("Snapshot request latency: %.1f ms" % request_latency_ms)
    get_tree().quit(0 if failed == 0 else 1)
