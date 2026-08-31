## Main Scene — P-014 CE + Godot Feasibility Demo
##
## Demonstrates CE driving a visible game world.
## Player can destroy the bridge, and CE determines all consequences.

extends Node2D

## CE Adapter
var ce_adapter: Node

## UI
var info_label: Label
var status_label: Label
var destroy_button: Button
var advance_button: Button
var save_button: Button
var restore_button: Button

## Visual nodes
var bridge_sprite: ColorRect
var town_sprite: ColorRect
var market_sprite: ColorRect
var storage_sprite: ColorRect
var road_sprite: ColorRect

## Merchant sprites
var merchants: Array[ColorRect] = []

## State
var last_checkpoint: String = ""
var last_delivery: String = ""

## P-015 demo driver state
var fps_samples: Array = []
var demo_active: bool = false
var SHOT_DIR := "/Users/ptpakdefarma/Project_v2/godot-ce-demo/shots"

func _ready() -> void:
    # Create CE adapter
    ce_adapter = preload("ce_adapter.gd").new()
    add_child(ce_adapter)
    ce_adapter.ce_state_updated.connect(_on_ce_state_updated)
    ce_adapter.ce_event_received.connect(_on_ce_event_received)

    # Create UI
    _create_ui()

    # Create visual elements
    _create_scene()

    # Connect to CE server
    ce_adapter.connect_to_ce()

    # Create CE world
    ce_adapter.create_world(42)

    # Initial state update
    ce_adapter.get_snapshot()

    # Start P-015 visual demo (timed causal scenario)
    demo_active = true
    _demo_run()

func _process(_delta: float) -> void:
    if demo_active:
        fps_samples.append(Engine.get_frames_per_second())

func _log(msg: String) -> void:
    print("[P-015] ", msg)

func _capture_shot(name: String) -> void:
    DirAccess.make_dir_recursive_absolute(SHOT_DIR)
    var img: Image = get_viewport().get_texture().get_image()
    var path := SHOT_DIR + "/" + name + ".png"
    img.save_png(path)
    _log("screenshot saved: " + path)

func _print_state(phase: String) -> void:
    _log("--- state after: " + phase + " ---")
    _log("  tick: " + str(ce_adapter.ce_tick))
    _log("  stateHash: " + ce_adapter.ce_state_hash)
    _log("  traceHash: " + ce_adapter.ce_trace_hash)
    if ce_adapter.towns.has("RF"):
        var rf: Dictionary = ce_adapter.towns["RF"]
        _log("  RF grain_price: " + str(rf["grain_price"]))
        _log("  RF trade_route_intact: " + str(rf["trade_route_intact"]))
        _log("  RF grain_stock: " + str(rf["grain_stock"]))
    for faction_id in ce_adapter.factions:
        var h: float = ce_adapter.factions[faction_id]["hostility"]
        _log("  faction " + str(faction_id) + " hostility: " + str(snappedf(h, 0.001)))

func _await_responses(n: int) -> void:
    for i in range(n):
        await ce_adapter.ce_state_updated

func _demo_run() -> void:
    # Wait for initial connection + snapshot to land
    await get_tree().create_timer(2.0).timeout
    _print_state("INITIAL")
    _capture_shot("shot_1_initial")

    # ── Phase 2: Godot UI-originated intervention ──────────────────────────
    # Press the real Destroy Bridge button → adapter → CE intervention.
    # CE (NOT Godot) decides all downstream consequences.
    var t0: int = Time.get_ticks_msec()
    destroy_button.pressed.emit()
    await _await_responses(2)  # submit + snapshot responses
    var roundtrip_ms: int = Time.get_ticks_msec() - t0
    _log("bridge destroy UI round-trip (Godot->CE->Godot): " + str(roundtrip_ms) + " ms")

    await get_tree().create_timer(1.0).timeout
    _print_state("BRIDGE_DESTROYED")
    _capture_shot("shot_2_destroyed")

    # ── Phase 3: advance time ───────────────────────────────────────────────
    t0 = Time.get_ticks_msec()
    advance_button.pressed.emit()  # advance 5 + snapshot + poll (3 requests)
    await _await_responses(3)
    roundtrip_ms = Time.get_ticks_msec() - t0
    _log("advance UI round-trip: " + str(roundtrip_ms) + " ms")

    await get_tree().create_timer(1.0).timeout
    _print_state("ADVANCED_5")
    _capture_shot("shot_3_advanced")

    # ── Phase 4: summary ────────────────────────────────────────────────────
    _log("--- latency summary (per HTTP request) ---")
    var total: float = 0.0
    var count: int = 0
    var max_lat: float = 0.0
    var by_url: Dictionary = {}
    for entry in ce_adapter.request_latencies:
        var url: String = entry["url"]
        var ms: float = entry["ms"]
        total += ms
        count += 1
        max_lat = max(max_lat, ms)
        if not by_url.has(url):
            by_url[url] = []
        by_url[url].append(ms)
    _log("  total requests: " + str(count))
    if count > 0:
        _log("  avg latency: %.1f ms | max: %.1f ms" % [total / count, max_lat])
    for url in by_url:
        var arr: Array = by_url[url]
        var u_total: float = 0.0
        for m in arr: u_total += m
        _log("  " + url + ": avg %.1f ms (n=%d)" % [u_total / arr.size(), arr.size()])

    _log("--- render FPS (sampled per frame) ---")
    var fps_total: float = 0.0
    var fps_max: float = 0.0
    var fps_min: float = 1e9
    for f in fps_samples:
        fps_total += f
        fps_max = max(fps_max, f)
        fps_min = min(fps_min, f)
    _log("  frames sampled: " + str(fps_samples.size()))
    if fps_samples.size() > 0:
        _log("  avg FPS: %.1f | min: %.1f | max: %.1f" % [fps_total / fps_samples.size(), fps_min, fps_max])

    _log("--- events received ---")
    for ev in ce_adapter.recent_events:
        var e: Dictionary = ev
        _log("  " + str(e.get("type", "?")) + " @ tick " + str(e.get("tick", "?")))

    _log("DEMO COMPLETE — application remains running for interactive use")

func _create_ui() -> void:
    # Info label (top-left)
    info_label = Label.new()
    info_label.position = Vector2(10, 10)
    info_label.add_theme_font_size_override("font_size", 16)
    add_child(info_label)

    # Status label (bottom)
    status_label = Label.new()
    status_label.position = Vector2(10, 680)
    status_label.add_theme_font_size_override("font_size", 14)
    add_child(status_label)

    # Destroy Bridge button
    destroy_button = Button.new()
    destroy_button.position = Vector2(10, 600)
    destroy_button.size = Vector2(200, 40)
    destroy_button.text = "Destroy Bridge (B)"
    destroy_button.pressed.connect(_on_destroy_bridge)
    add_child(destroy_button)

    # Advance button
    advance_button = Button.new()
    advance_button.position = Vector2(220, 600)
    advance_button.size = Vector2(150, 40)
    advance_button.text = "Advance Time"
    advance_button.pressed.connect(_on_advance)
    add_child(advance_button)

    # Save button
    save_button = Button.new()
    save_button.position = Vector2(380, 600)
    save_button.size = Vector2(100, 40)
    save_button.text = "Save"
    save_button.pressed.connect(_on_save)
    add_child(save_button)

    # Restore button
    restore_button = Button.new()
    restore_button.position = Vector2(490, 600)
    restore_button.size = Vector2(100, 40)
    restore_button.text = "Restore"
    restore_button.pressed.connect(_on_restore)
    add_child(restore_button)

func _create_scene() -> void:
    # Town (center)
    town_sprite = ColorRect.new()
    town_sprite.position = Vector2(500, 300)
    town_sprite.size = Vector2(200, 150)
    town_sprite.color = Color(0.4, 0.3, 0.2)
    add_child(town_sprite)

    # Road (left)
    road_sprite = ColorRect.new()
    road_sprite.position = Vector2(200, 350)
    road_sprite.size = Vector2(300, 20)
    road_sprite.color = Color(0.5, 0.4, 0.3)
    add_child(road_sprite)

    # Bridge (on road)
    bridge_sprite = ColorRect.new()
    bridge_sprite.position = Vector2(350, 340)
    bridge_sprite.size = Vector2(60, 40)
    bridge_sprite.color = Color(0.6, 0.5, 0.4)
    add_child(bridge_sprite)

    # Market (in town)
    market_sprite = ColorRect.new()
    market_sprite.position = Vector2(520, 320)
    market_sprite.size = Vector2(60, 40)
    market_sprite.color = Color(0.7, 0.6, 0.2)
    add_child(market_sprite)

    # Grain storage (in town)
    storage_sprite = ColorRect.new()
    storage_sprite.position = Vector2(620, 320)
    storage_sprite.size = Vector2(60, 40)
    storage_sprite.color = Color(0.5, 0.4, 0.1)
    add_child(storage_sprite)

    # Merchants (on road)
    for i in range(3):
        var merchant := ColorRect.new()
        merchant.position = Vector2(250 + i * 40, 345)
        merchant.size = Vector2(15, 30)
        merchant.color = Color(0.8, 0.2, 0.2)
        add_child(merchant)
        merchants.append(merchant)

func _input(event: InputEvent) -> void:
    if event is InputEventKey and event.pressed:
        if event.keycode == KEY_B:
            _on_destroy_bridge()
        elif event.keycode == KEY_SPACE:
            _on_advance()

func _on_destroy_bridge() -> void:
    ce_adapter.submit_intervention(
        "destroy_infrastructure",
        "grain_road",
        "infrastructure",
        "RF"
    )
    ce_adapter.get_snapshot()

func _on_advance() -> void:
    ce_adapter.advance_simulation(5)
    ce_adapter.get_snapshot()
    ce_adapter.poll_events()

func _on_save() -> void:
    ce_adapter.save_state()

func _on_restore() -> void:
    if ce_adapter.last_checkpoint != "":
        ce_adapter.restore_state(ce_adapter.last_checkpoint, ce_adapter.last_delivery)
        ce_adapter.get_snapshot()

func _on_ce_state_updated() -> void:
    _update_visuals()

func _on_ce_event_received(event: Dictionary) -> void:
    status_label.text = "Event: " + event.get("type", "unknown")

func _update_visuals() -> void:
    # Update info label
    info_label.text = "Tick: " + str(ce_adapter.ce_tick) + " | Hash: " + ce_adapter.ce_state_hash.substr(0, 8)

    # Update bridge visibility based on CE state
    if ce_adapter.towns.has("RF"):
        var rf_town = ce_adapter.towns["RF"]
        bridge_sprite.visible = rf_town["trade_route_intact"]
        storage_sprite.visible = rf_town["warehouse_intact"]

        # Update town color based on unrest
        var unrest = rf_town["unrest"] as float
        town_sprite.color = Color(0.4 - unrest * 0.1, 0.3, 0.2 + unrest * 0.1)

        # Update market based on trade
        var price = rf_town["grain_price"] as float
        market_sprite.color = Color(0.7, 0.6 - price * 0.01, 0.2)

        # Update merchant visibility based on trade route
        for merchant in merchants:
            merchant.visible = rf_town["trade_route_intact"]

    # Update status
    var faction_text = ""
    for faction_id in ce_adapter.factions:
        var hostility = ce_adapter.factions[faction_id]["hostility"] as float
        faction_text += faction_id + ": " + str(snappedf(hostility, 0.01)) + " "
    status_label.text = "Factions: " + faction_text
