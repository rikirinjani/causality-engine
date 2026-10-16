## Causal World Engine — 12-Step Verification Driver
##
## Drives the isometric scene end-to-end against the REAL CE WS server:
##   1. Observe world         2. Intervention          3. CE accepts
##   4. CE propagates         5. Godot renders         6. Checkpoint
##   7. Rewind                8. Fork                  9. Alternate intervention
##  10. Timelines distinct   11. Compare              12. explain()
##
## Run: godot --headless --path <this-project> res://iso_verify.tscn

extends Node

var iso: Node
var ce: Node
var passed := 0
var failed := 0

## Evidence written inside the project via res://. No developer-machine path.
const SHOT_DIR := "res://shots"

func _check(cond: bool, label: String) -> void:
	if cond:
		passed += 1
		print("PASS: ", label)
	else:
		failed += 1
		print("FAIL: ", label)

func _ready() -> void:
	iso = preload("res://iso_main.gd").new()
	iso.auto_start = false
	add_child(iso)
	ce = iso.ce
	ce.ce_explanation_received.connect(_on_explanation)
	await _run()
	_finish()

func _shot(name: String) -> void:
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(SHOT_DIR))
	var img: Image = get_viewport().get_texture().get_image()
	if img == null:
		print("[SHOT] skip (headless): ", name)
		return
	img.save_png(ProjectSettings.globalize_path(SHOT_DIR + "/" + name + ".png"))
	print("[SHOT] ", name)

func _pump(ms: float) -> void:
	await get_tree().create_timer(ms / 1000.0).timeout
	ce._process(0.016)

var last_explanation: Dictionary = {}

func _on_explanation(quantity: String, explanation: Dictionary) -> void:
	last_explanation = explanation
	print("[EXP] quantity=", quantity, " explained=", str(explanation.get("explained", false)))

func _run() -> void:
	print("=== CE 12-Step Vertical Slice Verification ===")

	# -- Step 0: Connect + create world (seed 42) ----------------------------
	for i in range(100):
		await _pump(20)
		if ce.connected: break
	_check(ce.connected, "Step 0: WS connected")

	ce.create_world(42)
	await _pump(300)
	ce.get_snapshot()
	await _pump(300)
	_check(ce.towns.has("RF"), "Step 0: snapshot projected RF")

	# -- Step 1: Player observes world (bridge intact) -----------------------
	await _pump(400)
	_shot("verify_step_01_observe")
	var price0: float = ce.towns["RF"]["grain_price"]
	_check(iso.bridge_sprite.visible, "Step 1: bridge visible (CE-backed object)")
	_check(price0 > 0.0, "Step 1: initial grain price %.2f" % price0)

	# -- Step 6 (early): Checkpoint BEFORE destroying (bridge intact) --------
	iso._on_checkpoint()
	await _pump(1000)
	_check(iso.checkpoint_id != "", "Step 6: checkpoint captured (id=%s)" % iso.checkpoint_id.substr(0, 12))

	# -- Step 2-3: Player intervention -> CE accepts -------------------------
	iso._on_destroy_bridge()
	await _pump(400)
	_check(not iso.bridge_sprite.visible, "Step 2-3: bridge destroyed after intervention")

	# -- Step 4-5: CE propagates -> Godot renders ----------------------------
	iso._on_advance()
	await _pump(600)
	_check(ce.ce_tick >= 5, "Step 4-5: advanced to tick %d" % ce.ce_tick)
	var price1: float = ce.towns["RF"]["grain_price"]
	_check(price1 > price0, "Step 4-5: grain price rose (%.2f -> %.2f)" % [price0, price1])
	_check(not ce.towns["RF"]["trade_route_intact"], "Step 4-5: trade route broken")
	_shot("verify_step_05_consequences")

	# -- Step 12: explain() --------------------------------------------------
	ce.request_explain("RF:price:grain")
	await _pump(500)
	_check(last_explanation.has("explained"), "Step 12: explanation received")
	var exp_ok: bool = last_explanation.get("explained", false)
	_check(exp_ok, "Step 12: grain price explained by CE attribution")
	if exp_ok:
		iso._show_explanation("RF:price:grain", last_explanation)
		await _pump(300)
		_shot("verify_step_12_explanation")
		var roots: Array = last_explanation.get("roots", [])
		var has_destroy := false
		for r in roots:
			if str(r.get("action", "")) == "destroy_infrastructure": has_destroy = true
		_check(has_destroy, "Step 12: explanation rooted in destroy_infrastructure")

	# -- Step 7: Rewind to checkpoint (bridge intact again) -----------------
	var tick_before_rewind: int = ce.ce_tick
	iso._on_rewind()
	await _pump(1000)
	_check(ce.ce_tick <= tick_before_rewind, "Step 7: rewound from tick %d to %d" % [tick_before_rewind, ce.ce_tick])

	# -- Step 8: Fork Timeline B (bridge intact in both timelines) -----------
	iso._on_fork_b()
	await _pump(1500)
	_check(iso.timeline_b_id != "", "Step 8: forked Timeline B (id=%s)" % iso.timeline_b_id.substr(0, 12))
	_check(iso.timeline_b_id != iso.timeline_a_id, "Step 8: B differs from A")

	# -- Step 9: Alternate intervention on B (subsidy, NOT destroy) ----------
	ce.submit_intervention("grant_merchant_subsidy", "RF", "region", "RF")
	await _pump(500)
	iso._on_advance()
	await _pump(600)
	var price_b: float = ce.towns["RF"]["grain_price"]
	_check(ce.towns["RF"]["trade_route_intact"], "Step 9: bridge intact in Timeline B")
	print("  Timeline B grain price: ", price_b)

	# -- Step 10: Timelines remain distinct ----------------------------------
	var snap_a_hash: String = ""
	var snap_b_hash: String = ""
	if iso.timeline_a_id != "":
		ce.switch_timeline(iso.timeline_a_id)
		await _pump(500)
		snap_a_hash = ce.ce_state_hash
		ce.switch_timeline(iso.timeline_b_id)
		await _pump(500)
		snap_b_hash = ce.ce_state_hash
		_check(snap_a_hash != snap_b_hash, "Step 10: stateHash differs (A=%s B=%s)" % [snap_a_hash.substr(0, 8), snap_b_hash.substr(0, 8)])

	# -- Step 11: Compare worlds ---------------------------------------------
	ce.list_timelines()
	await _pump(500)
	iso._on_compare()
	await _pump(1000)
	_shot("verify_step_11_compare")
	_check(iso.compare_label.visible, "Step 11: comparison panel rendered")

	# -- Performance ---------------------------------------------------------
	var fps_sum := 0.0
	var fps_n := 0
	for i in range(60):
		await _pump(16)
		fps_sum += Engine.get_frames_per_second()
		fps_n += 1
	var fps_avg: float = fps_sum / max(fps_n, 1)
	print("PERF render FPS avg: %.1f (n=%d)" % [fps_avg, fps_n])
	_check(fps_avg > 30.0, "Performance: render FPS %.1f" % fps_avg)

func _finish() -> void:
	print("")
	print("=== CE 12-STEP RESULTS: %d passed, %d failed ===" % [passed, failed])
	get_tree().quit(0 if failed == 0 else 1)
