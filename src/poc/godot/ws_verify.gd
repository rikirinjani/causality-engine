## P-017 Godot WebSocket verification — causal chain over WS push
##
## Drives the same causal demonstration through the WebSocket transport:
## create world → destroy bridge → advance → events PUSHED → snapshot → verify.
## No causal rules, no RNG, no simulation authority in Godot — only projection.
##
## Run: godot --headless --path ~/Project_v2/godot-ce-demo res://ws_verify.tscn

extends Node

var ws_adapter: Node
var passed: int = 0
var failed: int = 0
var event_types: Array = []
var initial_price: float = -1.0
var final_price: float = -1.0
var route_was_intact: bool = false

func _check(cond: bool, label: String) -> void:
    if cond:
        passed += 1
        print("PASS: ", label)
    else:
        failed += 1
        print("FAIL: ", label)

func _ready() -> void:
    ws_adapter = preload("res://ce_ws_adapter.gd").new()
    add_child(ws_adapter)
    ws_adapter.ce_state_updated.connect(_on_state_updated)
    ws_adapter.ce_event_received.connect(_on_event_received)
    await _run_test()
    _finish()

func _on_state_updated() -> void:
    pass

func _on_event_received(event: Dictionary) -> void:
    event_types.append(event.get("type", "?"))
    print("  [WS event] ", event.get("type", "?"), " @ tick ", event.get("tick", "?"))

func _wait_for_connected() -> void:
    for i in range(100):
        ws_adapter._process(0.016)
        if ws_adapter.connected:
            return
        await get_tree().create_timer(0.02).timeout

func _pump(frames: int = 30) -> void:
    for i in range(frames):
        ws_adapter._process(0.016)
        await get_tree().create_timer(0.01).timeout

func _run_test() -> void:
    print("=== P-017 Godot WebSocket Verification ===")
    print("  Transport: WebSocket push (ws://127.0.0.1:7778)")

    # Connect
    ws_adapter.connect_to_ce()
    await _wait_for_connected()
    _check(ws_adapter.connected, "adapter connected via WebSocket")

    # Create world
    ws_adapter.create_world(42)
    await _pump()
    _check(ws_adapter.ce_tick == 0, "world created, tick 0")

    # Initial snapshot (bridge intact)
    ws_adapter.get_snapshot()
    await _pump()
    _check(ws_adapter.towns.has("RF"), "snapshot projected RF via WS")
    if ws_adapter.towns.has("RF"):
        initial_price = ws_adapter.towns["RF"]["grain_price"]
        route_was_intact = ws_adapter.towns["RF"]["trade_route_intact"]
        print("  initial RF grain price: ", initial_price, " | route intact: ", route_was_intact)
        _check(route_was_intact, "bridge intact at start (game object exists)")

    # Destroy bridge through the WS adapter (Godot-originated intervention)
    ws_adapter.submit_intervention("destroy_infrastructure", "grain_road", "infrastructure", "RF")
    await _pump()
    _check(ws_adapter.ce_state_hash != "", "intervention accepted (WS)")

    # Advance — events are PUSHED, no poll request needed
    ws_adapter.advance_simulation(5)
    await _pump(60)
    _check(ws_adapter.ce_tick == 5, "advanced to tick 5 (WS)")

    # Snapshot after advance (bridge gone, price up)
    ws_adapter.get_snapshot()
    await _pump()
    if ws_adapter.towns.has("RF"):
        final_price = ws_adapter.towns["RF"]["grain_price"]
        print("  final RF grain price: ", final_price, " | route intact: ", ws_adapter.towns["RF"]["trade_route_intact"])
        _check(not ws_adapter.towns["RF"]["trade_route_intact"], "bridge destroyed → route broken (WS)")
        _check(final_price > initial_price, "grain price rose (%.2f → %.2f)" % [initial_price, final_price])

    # Causal chain events received via push
    _check(event_types.has("economy.trade_disruption"), "trade_disruption pushed")
    _check(event_types.has("economy.price_shock"), "price_shock pushed")
    _check(event_types.has("ecology.food_availability"), "food_availability pushed")
    _check(event_types.has("faction.hostility_increase"), "hostility_increase pushed")
    _check(ws_adapter.factions.size() > 0, "faction hostility projected")

    # Determinism: stateHash matches the headless/HTTP reference hash for this scenario
    # (5404d32e… from P-014/P-015 destroy-bridge + 5 ticks, seed 42)
    _check(ws_adapter.ce_state_hash.substr(0, 8) == "5404d32e", "WS stateHash matches HTTP/headless reference (" + ws_adapter.ce_state_hash.substr(0, 8) + ")")

func _finish() -> void:
    print("")
    print("=== WS RESULTS: %d passed, %d failed ===" % [passed, failed])
    get_tree().quit(0 if failed == 0 else 1)
