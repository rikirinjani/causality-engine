## P-017 WebSocket Visual Demo — CE drives a visible Godot world over WS push
##
## Same medieval-town scene as the HTTP demo (main.gd), but events arrive via
## WebSocket push. Godot contains zero causal rules / RNG / simulation authority:
## it receives pushed events + snapshots, projects, renders.

extends Node2D

var ws_adapter: Node

## UI
var info_label: Label
var status_label: Label
var destroy_button: Button
var advance_button: Button

## Visual nodes
var bridge_sprite: ColorRect
var town_sprite: ColorRect
var market_sprite: ColorRect
var storage_sprite: ColorRect
var road_sprite: ColorRect
var merchants: Array[ColorRect] = []

func _ready() -> void:
    ws_adapter = preload("res://ce_ws_adapter.gd").new()
    add_child(ws_adapter)
    ws_adapter.ce_state_updated.connect(_on_ce_state_updated)
    ws_adapter.ce_event_received.connect(_on_ce_event_received)
    _create_ui()
    _create_scene()
    ws_adapter.connect_to_ce()
    await get_tree().create_timer(1.0).timeout
    ws_adapter.create_world(42)
    await get_tree().create_timer(1.0).timeout
    ws_adapter.get_snapshot()
    await get_tree().create_timer(1.0).timeout
    _capture("ws_1_initial")
    # Auto-demo: destroy bridge via WS adapter, advance, capture (visual evidence)
    ws_adapter.submit_intervention("destroy_infrastructure", "grain_road", "infrastructure", "RF")
    await get_tree().create_timer(1.0).timeout
    ws_adapter.advance_simulation(5)
    await get_tree().create_timer(1.5).timeout
    ws_adapter.get_snapshot()
    await get_tree().create_timer(1.0).timeout
    _capture("ws_2_destroyed")
    _print_state()

func _capture(name: String) -> void:
    DirAccess.make_dir_recursive_absolute("/Users/ptpakdefarma/Project_v2/godot-ce-demo/shots")
    var img: Image = get_viewport().get_texture().get_image()
    img.save_png("/Users/ptpakdefarma/Project_v2/godot-ce-demo/shots/" + name + ".png")
    print("[P-017] screenshot saved: ", name)

func _print_state() -> void:
    print("[P-017] tick=", ws_adapter.ce_tick, " hash=", ws_adapter.ce_state_hash.substr(0, 8))
    if ws_adapter.towns.has("RF"):
        var rf = ws_adapter.towns["RF"]
        print("[P-017] RF grain_price=", rf["grain_price"], " route_intact=", rf["trade_route_intact"])
    for fid in ws_adapter.factions:
        print("[P-017] faction ", fid, " hostility=", ws_adapter.factions[fid]["hostility"])

func _create_ui() -> void:
    info_label = Label.new()
    info_label.position = Vector2(10, 10)
    info_label.add_theme_font_size_override("font_size", 16)
    add_child(info_label)
    status_label = Label.new()
    status_label.position = Vector2(10, 680)
    status_label.add_theme_font_size_override("font_size", 14)
    add_child(status_label)
    destroy_button = Button.new()
    destroy_button.position = Vector2(10, 600)
    destroy_button.size = Vector2(200, 40)
    destroy_button.text = "Destroy Bridge (WS)"
    destroy_button.pressed.connect(_on_destroy_bridge)
    add_child(destroy_button)
    advance_button = Button.new()
    advance_button.position = Vector2(220, 600)
    advance_button.size = Vector2(150, 40)
    advance_button.text = "Advance Time"
    advance_button.pressed.connect(_on_advance)
    add_child(advance_button)

func _create_scene() -> void:
    town_sprite = ColorRect.new()
    town_sprite.position = Vector2(500, 300)
    town_sprite.size = Vector2(200, 150)
    town_sprite.color = Color(0.4, 0.3, 0.2)
    add_child(town_sprite)
    road_sprite = ColorRect.new()
    road_sprite.position = Vector2(200, 350)
    road_sprite.size = Vector2(300, 20)
    road_sprite.color = Color(0.5, 0.4, 0.3)
    add_child(road_sprite)
    bridge_sprite = ColorRect.new()
    bridge_sprite.position = Vector2(350, 340)
    bridge_sprite.size = Vector2(60, 40)
    bridge_sprite.color = Color(0.6, 0.5, 0.4)
    add_child(bridge_sprite)
    market_sprite = ColorRect.new()
    market_sprite.position = Vector2(520, 320)
    market_sprite.size = Vector2(60, 40)
    market_sprite.color = Color(0.7, 0.6, 0.2)
    add_child(market_sprite)
    storage_sprite = ColorRect.new()
    storage_sprite.position = Vector2(620, 320)
    storage_sprite.size = Vector2(60, 40)
    storage_sprite.color = Color(0.5, 0.4, 0.1)
    add_child(storage_sprite)
    for i in range(3):
        var merchant := ColorRect.new()
        merchant.position = Vector2(250 + i * 40, 345)
        merchant.size = Vector2(15, 30)
        merchant.color = Color(0.8, 0.2, 0.2)
        add_child(merchant)
        merchants.append(merchant)

func _on_destroy_bridge() -> void:
    ws_adapter.submit_intervention("destroy_infrastructure", "grain_road", "infrastructure", "RF")
    ws_adapter.get_snapshot()

func _on_advance() -> void:
    ws_adapter.advance_simulation(5)
    ws_adapter.get_snapshot()

func _on_ce_state_updated() -> void:
    _update_visuals()

func _on_ce_event_received(event: Dictionary) -> void:
    status_label.text = "WS Event: " + event.get("type", "?")

func _update_visuals() -> void:
    info_label.text = "Tick: " + str(ws_adapter.ce_tick) + " | Hash: " + ws_adapter.ce_state_hash.substr(0, 8) + " [WS]"
    if ws_adapter.towns.has("RF"):
        var rf = ws_adapter.towns["RF"]
        bridge_sprite.visible = rf["trade_route_intact"]
        var unrest = rf["unrest"] as float
        town_sprite.color = Color(0.4 - unrest * 0.1, 0.3, 0.2 + unrest * 0.1)
        var price = rf["grain_price"] as float
        market_sprite.color = Color(0.7, 0.6 - price * 0.01, 0.2)
        for merchant in merchants:
            merchant.visible = rf["trade_route_intact"]
    var faction_text = ""
    for faction_id in ws_adapter.factions:
        var hostility = ws_adapter.factions[faction_id]["hostility"] as float
        faction_text += faction_id + ": " + str(snappedf(hostility, 0.01)) + " "
    if faction_text != "":
        status_label.text = "Factions: " + faction_text
