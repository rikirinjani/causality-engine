## P-018: Vertical Slice headless verification driver
##
## Drives the isometric scene end-to-end against the REAL CE WS server:
##   initial -> destroy bridge -> advance -> explanation -> save/restore ->
##   cadence demonstration -> performance summary.
## Captures viewport screenshots at each phase for visual evidence.
##
## Run: godot --headless --path ~/Project_v2/godot-ce-demo res://iso_verify.tscn

extends Node

var iso: Node            # instance of iso_main.gd (shares adapter + projection)
var ce: Node
var passed := 0
var failed := 0
var SHOT_DIR := "/Users/ptpakdefarma/Project_v2/godot-ce-demo/shots"

# Performance collection
var fps_samples: Array = []
var rt_samples: Array = []      # intervention round-trip ms
var tick_times_ms: Array = []

func _check(cond: bool, label: String) -> void:
    if cond:
        passed += 1
        print("PASS: ", label)
    else:
        failed += 1
        print("FAIL: ", label)

func _ready() -> void:
    iso = preload("res://iso_main.gd").new()
    iso.auto_start = false   # iso_verify owns connect/create_world/sequence
    add_child(iso)
    ce = iso.ce
    ce.ce_explanation_received.connect(_on_explanation)
    await _run()
    _finish()

func _shot(name: String) -> void:
    DirAccess.make_dir_recursive_absolute(SHOT_DIR)
    var img: Image = get_viewport().get_texture().get_image()
    if img == null:
        print("SHOT-SKIP: ", name, " (headless: no render texture — GUI run provides visuals)")
        return
    img.save_png(SHOT_DIR + "/" + name + ".png")
    print("SHOT: ", name)

func _pump(ms: float) -> void:
    await get_tree().create_timer(ms / 1000.0).timeout
    ce._process(0.016)

var last_explanation: Dictionary = {}

func _on_explanation(quantity: String, explanation: Dictionary) -> void:
    last_explanation = explanation
    print("[EXP] quantity=", quantity, " explained=", str(explanation.get("explained", false)))

func _run() -> void:
    print("=== P-018 Vertical Slice Verification (WebSocket runtime) ===")

    # ── Connect + create world (seed 42) ────────────────────────────────────
    # NOTE: iso_main._ready() already connected; just wait for the socket.
    for i in range(100):
        await _pump(20)
        if ce.connected: break
    _check(ce.connected, "WS connected")

    ce.create_world(42)
    await _pump(300)
    ce.get_snapshot()
    await _pump(300)
    _check(ce.towns.has("RF"), "snapshot projected RF")

    # Evidence A + B: initial town, bridge intact
    await _pump(400)
    _shot("iso_A_initial_town")
    _check(iso.bridge_sprite.visible, "A/B: bridge visible initially (CE-backed object)")
    var price0: float = ce.towns["RF"]["grain_price"]
    print("  initial grain price: ", price0)

    # ── Player intervention: destroy bridge ─────────────────────────────────
    var t0 := Time.get_ticks_msec()
    iso._on_destroy_bridge()
    await _pump(400)
    rt_samples.append(Time.get_ticks_msec() - t0)
    await _pump(200)
    _check(not iso.bridge_sprite.visible, "C: bridge visually destroyed after intervention")

    # ── Advance (CE determines consequences) ────────────────────────────────
    var adv_t0 := Time.get_ticks_msec()
    iso._on_advance()
    await _pump(600)
    tick_times_ms.append(Time.get_ticks_msec() - adv_t0)
    _check(ce.ce_tick >= 5, "advanced to tick %d" % ce.ce_tick)

    var price1: float = ce.towns["RF"]["grain_price"]
    var h0: float = ce.factions.get("MG", {}).get("hostility", 0.0) if ce.factions.has("MG") else 0.0
    print("  post-destroy grain price: ", price1, " | MG hostility: ", h0)

    # Evidence D: downstream consequences
    await _pump(400)
    _shot("iso_D_consequences")
    _check(price1 > price0, "D: grain price rose (%.2f -> %.2f) from CE state" % [price0, price1])
    _check(ce.factions.has("MG"), "D: MG faction hostility projected")
    _check(not ce.towns["RF"]["trade_route_intact"], "merchants cannot cross (route broken)")

    # ── Evidence E: causal explanation (CE explain API via WS) ──────────────
    ce.request_explain("RF:price:grain")
    await _pump(500)
    _check(last_explanation.has("explained"), "E: explanation received from CE")
    var exp_ok: bool = last_explanation.get("explained", false)
    _check(exp_ok, "E: grain price is explained by CE attribution")
    if exp_ok:
        iso._show_explanation("RF:price:grain", last_explanation)
        await _pump(300)
        _shot("iso_E_explanation")
        var roots: Array = last_explanation.get("roots", [])
        var has_destroy := false
        for r in roots:
            if str(r.get("action", "")) == "destroy_infrastructure": has_destroy = true
        _check(has_destroy, "E: explanation rooted in destroy_infrastructure")

    # ── Cadence: multi CE ticks per frame + frames with no tick ─────────────
    ce.advance_simulation(10)   # several ticks, one adapter round
    await _pump(400)
    var tick_after_batch: int = ce.ce_tick
    _check(tick_after_batch >= 15, "cadence: 10 CE ticks in one round (tick=%d)" % tick_after_batch)
    # frames with no CE tick: just pump, no advance; world hash must not change
    var h_before: String = ce.ce_state_hash
    for i in range(30):
        await _pump(16)
    _check(ce.ce_state_hash == h_before, "cadence: 30 frames with no CE tick -> hash unchanged")

    # ── Save / restore (deterministic continuation) ─────────────────────────
    ce.save_state()
    for i in range(50):   # wait until the checkpointed reply arrives (bounded)
        await _pump(40)
        if ce.last_checkpoint != "": break
    _check(ce.last_checkpoint != "", "save: checkpoint captured")
    var h_saved: String = ce.ce_state_hash
    ce.advance_simulation(3)          # mutate past save point
    await _pump(400)
    ce.restore_state(ce.last_checkpoint, ce.last_delivery)
    for i in range(50):   # wait until the restore reply lands
        await _pump(40)
        if ce.ce_state_hash == h_saved: break
    _check(ce.ce_state_hash == h_saved, "restore: hash matches saved state")

    # Evidence F: restored world
    await _pump(300)
    _shot("iso_F_restored")

    # ── Performance summary ──────────────────────────────────────────────────
    for i in range(120):
        await _pump(16)
        fps_samples.append(Engine.get_frames_per_second())
    var fps_sum := 0.0
    for f in fps_samples: fps_sum += f
    var fps_avg: float = fps_sum / max(fps_samples.size(), 1)
    print("PERF render FPS avg: %.1f (n=%d)" % [fps_avg, fps_samples.size()])
    if rt_samples.size() > 0:
        print("PERF intervention round-trip avg: %.1f ms" % (rt_samples.reduce(func(a,b): return a+b, 0.0) / rt_samples.size()))
    if tick_times_ms.size() > 0:
        print("PERF advance round-trip: %.1f ms" % tick_times_ms[0])
    _check(fps_avg > 30.0, "performance: render FPS %.1f comfortably playable" % fps_avg)

func _finish() -> void:
    print("")
    print("=== P-018 RESULTS: %d passed, %d failed ===" % [passed, failed])
    get_tree().quit(0 if failed == 0 else 1)
