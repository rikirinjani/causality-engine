## Causal World Engine — Isometric Vertical Slice (Godot)
##
## Demonstrates the CE-backed gameplay model:
##   Godot   = rendering, camera, animation, UI, input, interpolation
##   Adapter = intent -> intervention, CE state -> projection, event consumption
##   CE      = world state, economy, factions, causal propagation, RNG
##
## The 12-step loop (auto_demo when auto_start=true):
##   1. Observe world    2. Intervention     3. CE accepts
##   4. CE propagates    5. Godot renders    6. Checkpoint
##   7. Rewind           8. Fork             9. Alternate intervention
##  10. Timelines distinct  11. Compare      12. explain()
##
## ZERO causal rules and ZERO simulation RNG in Godot (searchable).

extends Node2D

# -- Adapter -----------------------------------------------------------------
var ce: Node            # ce_ws_adapter.gd (WebSocket transport)

# -- Iso camera --------------------------------------------------------------
var cam: Camera2D
var cam_speed := 600.0
var target_offset := Vector2.ZERO

# -- World layout (deterministic iso grid) -----------------------------------
const TILE_W := 64.0
const TILE_H := 32.0
const TOWN_CENTER := Vector2(4, 6)
const BRIDGE_GRID := Vector2(6, 4)

# -- Nodes -------------------------------------------------------------------
var ground_layer: Node2D
var object_layer: Node2D
var merchant_layer: Node2D

# CE-backed objects (projected from CE state)
var bridge_sprite: ColorRect
var warehouse_sprite: ColorRect
var market_sprite: ColorRect
var town_sprite: ColorRect
var merchants: Array = []

# UI
var info_label: Label
var price_label: Label
var hostility_label: Label
var status_label: Label
var explain_label: RichTextLabel
var hint_label: Label
var destroy_button: Button
var advance_button: Button
var explain_button: Button
var checkpoint_button: Button
var rewind_button: Button
var fork_button: Button
var compare_button: Button
var compare_label: Label

# Causal explanation (from CE explain API via WS)
var last_explanation: Dictionary = {}
var explain_visible := false

# -- P-020 branch gameplay state ---------------------------------------------
var checkpoint_id: String = ""
var timeline_a_id: String = ""
var timeline_b_id: String = ""

# When true, _ready() auto-connects and runs the 12-step demo.
# A driver (iso_verify) can set this to false BEFORE add_child() to own the sequence.
var auto_start := true

func _ready() -> void:
	ce = preload("res://ce_ws_adapter.gd").new()
	add_child(ce)
	ce.ce_state_updated.connect(_on_ce_state_updated)
	ce.ce_event_received.connect(_on_ce_event_received)
	ce.ce_explanation_received.connect(_show_explanation)

	_create_layers()
	_build_isometric_ground()
	_build_ce_objects()
	_create_ui()
	_setup_camera()

	ce.connect_to_ce()
	if not auto_start:
		return
	await get_tree().create_timer(0.8).timeout
	_run_12_step_demo()

# ============================================================================
# 12-Step Auto Demo
# ============================================================================

func _run_12_step_demo() -> void:
	# Step 1: Create world + observe (bridge intact)
	ce.create_world(42)
	await get_tree().create_timer(0.8).timeout
	ce.get_snapshot()
	await get_tree().create_timer(1.0).timeout
	_capture("step_01_observe")

	# Step 6 (early): Checkpoint BEFORE destroying (bridge intact at this point)
	_on_checkpoint()
	await get_tree().create_timer(1.0).timeout

	# Step 2-3: Player intervention (destroy bridge) -> CE accepts
	_on_destroy_bridge()
	await get_tree().create_timer(1.0).timeout

	# Step 4-5: CE propagates -> Godot renders
	_on_advance()
	await get_tree().create_timer(1.5).timeout
	_capture("step_05_consequences")

	# Step 12: explain() -- why is grain expensive?
	_on_explain_price()
	await get_tree().create_timer(1.0).timeout
	_capture("step_12_explanation")

	# Step 7: Rewind to checkpoint (bridge intact again)
	_on_rewind()
	await get_tree().create_timer(1.0).timeout

	# Step 8: Fork Timeline B (bridge intact in both timelines now)
	_on_fork_b()
	await get_tree().create_timer(1.0).timeout

	# Step 9: Alternate intervention on B (subsidy, NOT destroy)
	ce.submit_intervention("grant_merchant_subsidy", "RF", "region", "RF")
	await get_tree().create_timer(0.5).timeout
	_on_advance()
	await get_tree().create_timer(1.5).timeout

	# Step 10-11: Timelines distinct + Compare
	ce.list_timelines()
	await get_tree().create_timer(0.5).timeout
	_on_compare()
	await get_tree().create_timer(1.0).timeout
	_capture("step_11_compare")

	status_label.text = "12-step demo complete"

# ============================================================================
# Screenshot capture
# ============================================================================

## Evidence screenshots are written inside the project, via res://.
## No absolute or developer-machine path appears anywhere in this project.
const SHOT_DIR := "res://shots"

func _capture(name: String) -> void:
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(SHOT_DIR))
	var img: Image = get_viewport().get_texture().get_image()
	if img == null:
		print("[SHOT] skip (headless): ", name)
		return
	img.save_png(ProjectSettings.globalize_path(SHOT_DIR + "/" + name + ".png"))
	print("[SHOT] ", name, " | tick=", ce.ce_tick, " hash=", ce.ce_state_hash.substr(0, 8))

# ============================================================================
# Isometric rendering
# ============================================================================

func iso(gx: float, gy: float) -> Vector2:
	return Vector2((gx - gy) * TILE_W / 2.0, (gx + gy) * TILE_H / 2.0)

func _create_layers() -> void:
	ground_layer = Node2D.new()
	add_child(ground_layer)
	object_layer = Node2D.new()
	add_child(object_layer)
	merchant_layer = Node2D.new()
	add_child(merchant_layer)

func _build_isometric_ground() -> void:
	for gx in range(0, 10):
		for gy in range(0, 9):
			var tile := ColorRect.new()
			var p := iso(gx, gy)
			tile.position = p - Vector2(TILE_W / 2.0, TILE_H / 2.0)
			tile.size = Vector2(TILE_W, TILE_H)
			tile.color = _tile_color(gx, gy)
			ground_layer.add_child(tile)

func _tile_color(gx: int, gy: int) -> Color:
	var in_town := gx >= 2 and gx <= 6 and gy >= 4 and gy <= 7
	var on_road := (gy == 4 and gx >= 2 and gx <= 6)
	if in_town:
		return Color(0.45, 0.35, 0.22)
	if on_road:
		return Color(0.62, 0.52, 0.38)
	return Color(0.32, 0.48, 0.25)

func _build_ce_objects() -> void:
	bridge_sprite = ColorRect.new()
	bridge_sprite.position = iso(BRIDGE_GRID.x, BRIDGE_GRID.y) - Vector2(TILE_W * 0.55, TILE_H * 0.75)
	bridge_sprite.size = Vector2(TILE_W * 1.1, TILE_H * 1.5)
	bridge_sprite.color = Color(0.55, 0.4, 0.25)
	object_layer.add_child(bridge_sprite)

	warehouse_sprite = ColorRect.new()
	warehouse_sprite.position = iso(3, 6) - Vector2(TILE_W * 0.6, TILE_H * 0.8)
	warehouse_sprite.size = Vector2(TILE_W * 1.2, TILE_H * 1.6)
	warehouse_sprite.color = Color(0.75, 0.65, 0.2)
	object_layer.add_child(warehouse_sprite)

	market_sprite = ColorRect.new()
	market_sprite.position = iso(5, 5) - Vector2(TILE_W * 0.5, TILE_H * 0.7)
	market_sprite.size = Vector2(TILE_W, TILE_H * 1.4)
	market_sprite.color = Color(0.8, 0.55, 0.25)
	object_layer.add_child(market_sprite)

	town_sprite = ColorRect.new()
	town_sprite.position = iso(4, 5) - Vector2(TILE_W * 0.7, TILE_H * 0.9)
	town_sprite.size = Vector2(TILE_W * 1.4, TILE_H * 1.8)
	town_sprite.color = Color(0.35, 0.28, 0.2)
	object_layer.add_child(town_sprite)

	var merchant_ids := ["a07", "a08", "a09", "a10", "a11", "a12"]
	for i in range(merchant_ids.size()):
		var m := ColorRect.new()
		var grid := Vector2(3 + i * 0.5, 5.5 + (i % 3) * 0.35)
		var p := iso(grid.x, grid.y)
		m.position = p - Vector2(10, 20)
		m.size = Vector2(20, 40)
		m.color = Color(0.85, 0.25, 0.2)
		merchant_layer.add_child(m)
		merchants.append({"node": m, "id": merchant_ids[i], "grid": grid, "base": p})

# ============================================================================
# UI
# ============================================================================

func _create_ui() -> void:
	info_label = Label.new()
	info_label.position = Vector2(12, 8)
	info_label.add_theme_font_size_override("font_size", 15)
	add_child(info_label)

	price_label = Label.new()
	price_label.position = Vector2(12, 34)
	price_label.add_theme_font_size_override("font_size", 16)
	add_child(price_label)

	hostility_label = Label.new()
	hostility_label.position = Vector2(12, 58)
	hostility_label.add_theme_font_size_override("font_size", 15)
	add_child(hostility_label)

	status_label = Label.new()
	status_label.position = Vector2(12, 84)
	status_label.add_theme_font_size_override("font_size", 13)
	add_child(status_label)

	explain_label = RichTextLabel.new()
	explain_label.position = Vector2(12, 120)
	explain_label.size = Vector2(520, 260)
	explain_label.bbcode_enabled = true
	explain_label.visible = false
	add_child(explain_label)

	hint_label = Label.new()
	hint_label.position = Vector2(12, 690)
	hint_label.add_theme_font_size_override("font_size", 13)
	hint_label.text = "WASD: pan | [B] Destroy | [E] Explain | [Space] Advance | [C] Checkpoint | [R] Rewind | [F] Fork | [V] Compare"
	add_child(hint_label)

	destroy_button = Button.new()
	destroy_button.position = Vector2(1120, 620)
	destroy_button.size = Vector2(160, 44)
	destroy_button.text = "Destroy Bridge"
	destroy_button.pressed.connect(_on_destroy_bridge)
	add_child(destroy_button)

	advance_button = Button.new()
	advance_button.position = Vector2(1120, 560)
	advance_button.size = Vector2(160, 44)
	advance_button.text = "Advance Time"
	advance_button.pressed.connect(_on_advance)
	add_child(advance_button)

	explain_button = Button.new()
	explain_button.position = Vector2(1120, 500)
	explain_button.size = Vector2(160, 44)
	explain_button.text = "Why is grain expensive?"
	explain_button.pressed.connect(_on_explain_price)
	add_child(explain_button)

	checkpoint_button = Button.new()
	checkpoint_button.position = Vector2(1120, 440)
	checkpoint_button.size = Vector2(160, 44)
	checkpoint_button.text = "Checkpoint"
	checkpoint_button.pressed.connect(_on_checkpoint)
	add_child(checkpoint_button)

	rewind_button = Button.new()
	rewind_button.position = Vector2(1120, 380)
	rewind_button.size = Vector2(160, 44)
	rewind_button.text = "Rewind"
	rewind_button.pressed.connect(_on_rewind)
	add_child(rewind_button)

	fork_button = Button.new()
	fork_button.position = Vector2(1120, 320)
	fork_button.size = Vector2(160, 44)
	fork_button.text = "Fork Timeline B"
	fork_button.pressed.connect(_on_fork_b)
	add_child(fork_button)

	compare_button = Button.new()
	compare_button.position = Vector2(1120, 260)
	compare_button.size = Vector2(160, 44)
	compare_button.text = "Compare A vs B"
	compare_button.pressed.connect(_on_compare)
	add_child(compare_button)

	compare_label = Label.new()
	compare_label.position = Vector2(12, 400)
	compare_label.size = Vector2(600, 260)
	compare_label.add_theme_font_size_override("font_size", 14)
	compare_label.visible = false
	add_child(compare_label)

func _setup_camera() -> void:
	cam = Camera2D.new()
	add_child(cam)
	cam.make_current()
	cam.zoom = Vector2(1.4, 1.4)
	target_offset = iso(4, 5)

func _process(delta: float) -> void:
	var move := Vector2.ZERO
	if Input.is_key_pressed(KEY_W) or Input.is_key_pressed(KEY_UP): move.y -= 1
	if Input.is_key_pressed(KEY_S) or Input.is_key_pressed(KEY_DOWN): move.y += 1
	if Input.is_key_pressed(KEY_A) or Input.is_key_pressed(KEY_LEFT): move.x -= 1
	if Input.is_key_pressed(KEY_D) or Input.is_key_pressed(KEY_RIGHT): move.x += 1
	if move != Vector2.ZERO:
		target_offset += move.normalized() * cam_speed * delta
	cam.position = target_offset
	ce._process(delta)

func _input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed:
		match event.keycode:
			KEY_B: _on_destroy_bridge()
			KEY_SPACE: _on_advance()
			KEY_E: _on_explain_price()
			KEY_C: _on_checkpoint()
			KEY_R: _on_rewind()
			KEY_F: _on_fork_b()
			KEY_V: _on_compare()

# ============================================================================
# Player interactions -> adapter -> CE
# ============================================================================

func _on_destroy_bridge() -> void:
	status_label.text = "Sending intervention: destroy grain_road..."
	ce.submit_intervention("destroy_infrastructure", "grain_road", "infrastructure", "RF")
	ce.get_snapshot()

func _on_advance() -> void:
	ce.advance_simulation(5)
	ce.get_snapshot()

func _on_explain_price() -> void:
	ce.request_explain("RF:price:grain")

func _on_checkpoint() -> void:
	ce.checkpoint()
	status_label.text = "Checkpoint requested..."

func _on_rewind() -> void:
	if checkpoint_id != "":
		ce.rewind(checkpoint_id)
		status_label.text = "Rewinding to checkpoint..."

func _on_fork_b() -> void:
	if checkpoint_id != "":
		ce.fork(checkpoint_id, "B")
		status_label.text = "Forking Timeline B..."

func _on_compare() -> void:
	if timeline_a_id != "" and timeline_b_id != "":
		ce.compare_timelines(timeline_a_id, timeline_b_id)
		status_label.text = "Comparing A vs B..."

# ============================================================================
# CE state/event -> projection
# ============================================================================

func _on_ce_state_updated() -> void:
	_project_ce_state()
	_update_branch_ui()

func _update_branch_ui() -> void:
	if ce.last_checkpoint_id != "" and checkpoint_id == "":
		checkpoint_id = ce.last_checkpoint_id
		status_label.text = "Checkpoint captured: " + checkpoint_id.substr(0, 12)
	if ce.timelines.size() > 0:
		for t in ce.timelines:
			var td: Dictionary = t
			var tid: String = td.get("timelineId", "")
			if td.get("origin", "") == "genesis" and timeline_a_id == "":
				timeline_a_id = tid
			elif td.get("origin", "") == "fork" and timeline_b_id == "":
				timeline_b_id = tid
	if ce.last_comparison.has("a") and ce.last_comparison.has("b"):
		_render_comparison(ce.last_comparison)

func _render_comparison(cmp: Dictionary) -> void:
	var a: Dictionary = cmp["a"]
	var b: Dictionary = cmp["b"]
	compare_label.visible = true
	var txt := "TIMELINE A (%s)          TIMELINE B (%s)\n" % [str(a.get("timelineId", "")).substr(0, 10), str(b.get("timelineId", "")).substr(0, 10)]
	txt += "Grain price    %6.2f          %6.2f\n" % [a.get("grainPrice", 0.0), b.get("grainPrice", 0.0)]
	txt += "Grain stock    %6.1f          %6.1f\n" % [a.get("grainStock", 0.0), b.get("grainStock", 0.0)]
	txt += "MG hostility   %6.2f          %6.2f\n" % [a.get("hostility", 0.0), b.get("hostility", 0.0)]
	txt += "Bridge         %s          %s\n" % ["intact" if a.get("bridgeIntact", false) else "destroyed", "intact" if b.get("bridgeIntact", false) else "destroyed"]
	txt += "Events         %d          %d\n" % [a.get("eventCount", 0), b.get("eventCount", 0)]
	txt += "\nstateHash equal: %s | traceHash equal: %s | physics equal: %s\n" % [str(cmp.get("stateHashEqual", false)), str(cmp.get("traceHashEqual", false)), str(cmp.get("physicsEqual", false))]
	if cmp.get("physicsEqual", false) and not cmp.get("stateHashEqual", false):
		txt += "=> Same effective state, DIFFERENT history (distinct timelines)"
	elif not cmp.get("stateHashEqual", false):
		txt += "=> Effective worlds differ (different causal histories)"
	else:
		txt += "=> Identical worlds"
	compare_label.text = txt

func _on_ce_event_received(event: Dictionary) -> void:
	status_label.text = "Event: " + event.get("type", "?")

func _project_ce_state() -> void:
	info_label.text = "Tick: %d | Hash: %s [WS]" % [ce.ce_tick, ce.ce_state_hash.substr(0, 8)]
	if ce.towns.has("RF"):
		var rf = ce.towns["RF"]
		var price: float = rf["grain_price"]
		price_label.text = "Grain price: %.2f" % price
		bridge_sprite.visible = rf["trade_route_intact"]
		for m in merchants:
			m["node"].visible = rf["trade_route_intact"]
		market_sprite.color = Color(0.8, 0.55 - min(price - 10.0, 10.0) * 0.03, 0.25)
		warehouse_sprite.visible = rf["warehouse_intact"]
		status_label.text += " | stock: %.1f" % rf["grain_stock"]
	var ftxt := ""
	for fid in ce.factions:
		var h: float = ce.factions[fid]["hostility"]
		ftxt += "%s: %.2f  " % [fid, h]
	if ftxt != "":
		hostility_label.text = "Hostility: " + ftxt

func _show_explanation(quantity: String, explanation: Dictionary) -> void:
	explain_visible = true
	explain_label.visible = true
	var body := "[b]WHY IS %s EXPENSIVE?[/b]\n\n" % quantity
	if not explanation.get("explained", false):
		body += "No recorded cause found (explanation unavailable).\n"
	else:
		var paths = explanation.get("paths", []) as Array
		if paths.size() > 0:
			for path in paths.slice(0, 3):
				var chain := ""
				for step in path:
					chain += "  %s\n" % str(step)
				body += chain + "\n"
		var roots = explanation.get("roots", []) as Array
		if roots.size() > 0:
			body += "[b]Originating actions:[/b]\n"
			for r in roots.slice(0, 3):
				body += "  %s (tick %s)\n" % [str(r.get("action", "?")), str(r.get("tick", "?"))]
	explain_label.text = body

func set_target_offset(off: Vector2) -> void:
	target_offset = off
