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
    if last_checkpoint != "":
        ce_adapter.restore_state(last_checkpoint, last_delivery)
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
