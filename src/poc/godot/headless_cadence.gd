## P-014 Headless Game-Loop Cadence + Persistence Test
##
## 1. Simulates a 60 fps game loop interacting with CE: poll each frame,
##    advance every N frames, measure per-frame and per-advance overhead.
## 2. Tests checkpoint/restore round-trip: save, advance past, restore, verify.
## 3. Tests deterministic replay: identical seed + intervention -> identical hash.
##
## Run: godot --headless --path ~/Project_v2/godot-ce-demo res://headless_cadence.tscn

extends Node

var ce_adapter: Node
var passed: int = 0
var failed: int = 0

var frames_run: int = 0
var poll_times_ms: Array = []
var advance_times_ms: Array = []
var tick_times_ms: Array = []

const FRAME_TARGET_MS := 16.67  # 60 fps
const ADVANCE_EVERY_FRAMES := 10  # CE advances once per 10 frames (6 ticks/sec)

var last_checkpoint: String = ""
var last_delivery: String = ""

func _check(cond: bool, label: String) -> void:
    if cond:
        passed += 1
        print("PASS: ", label)
    else:
        failed += 1
        print("FAIL: ", label)

func _ready() -> void:
    ce_adapter = preload("res://ce_adapter.gd").new()
    add_child(ce_adapter)
    ce_adapter.ce_state_updated.connect(_on_state_updated)
    await _run_all()
    _finish()

func _on_state_updated() -> void:
    pass

# ── Test 1: Game loop cadence ──────────────────────────────────────────────
func _test_game_loop() -> void:
    print("--- Test 1: Game loop cadence (60 fps target) ---")
    ce_adapter.create_world(42)
    await ce_adapter.ce_state_updated
    ce_adapter.get_snapshot()
    await ce_adapter.ce_state_updated

    var destroyed := false
    for frame in range(120):
        frames_run += 1

        # Poll events every frame (cheap)
        var t0: int = Time.get_ticks_usec()
        ce_adapter.poll_events()
        await ce_adapter.ce_state_updated
        poll_times_ms.append((Time.get_ticks_usec() - t0) / 1000.0)

        # Destroy bridge once, mid-loop
        if frame == 20 and not destroyed:
            ce_adapter.submit_intervention("destroy_infrastructure", "grain_road", "infrastructure", "RF")
            await ce_adapter.ce_state_updated
            destroyed = true

        # Advance CE every ADVANCE_EVERY_FRAMES frames
        if frame % ADVANCE_EVERY_FRAMES == 0:
            var t1: int = Time.get_ticks_usec()
            ce_adapter.advance_simulation(1)
            await ce_adapter.ce_state_updated
            advance_times_ms.append((Time.get_ticks_usec() - t1) / 1000.0)

    _check(frames_run == 120, "ran 120 game frames")
    _check(poll_times_ms.size() == 120, "polled every frame (%d polls)" % poll_times_ms.size())
    _check(advance_times_ms.size() == 12, "advanced 12 times (%d advances)" % advance_times_ms.size())
    _check(ce_adapter.ce_tick == 12, "CE reached tick 12 (got %d)" % ce_adapter.ce_tick)

    var avg_poll: float = 0.0
    for t in poll_times_ms: avg_poll += t
    avg_poll /= poll_times_ms.size()
    var avg_advance: float = 0.0
    for t in advance_times_ms: avg_advance += t
    avg_advance /= advance_times_ms.size()
    var max_poll: float = 0.0
    for t in poll_times_ms: max_poll = max(max_poll, t)

    print("  avg poll latency: %.2f ms" % avg_poll)
    print("  max poll latency: %.2f ms" % max_poll)
    print("  avg advance latency: %.2f ms" % avg_advance)
    print("  budget: %.1f ms/frame at 60fps" % FRAME_TARGET_MS)

    _check(avg_poll < FRAME_TARGET_MS, "avg poll fits in frame budget")
    _check(max_poll < FRAME_TARGET_MS * 4, "max poll within 4-frame budget (%.2f ms)" % max_poll)

# ── Test 2: Checkpoint / restore ───────────────────────────────────────────
func _test_checkpoint_restore() -> void:
    print("--- Test 2: Checkpoint / restore ---")
    var hash_before: String = ce_adapter.ce_state_hash
    var tick_before: int = ce_adapter.ce_tick
    print("  state at tick %d, hash %s" % [tick_before, hash_before.substr(0, 8)])

    # Save (adapter now captures the checkpoint payload)
    ce_adapter.save_state()
    await ce_adapter.ce_state_updated
    _check(ce_adapter.last_checkpoint != "", "checkpoint payload captured by adapter")
    _check(ce_adapter.ce_state_hash == hash_before, "state unchanged by save")

    # Advance further (mutate state past the checkpoint)
    ce_adapter.advance_simulation(3)
    await ce_adapter.ce_state_updated
    var hash_mid: String = ce_adapter.ce_state_hash
    _check(ce_adapter.ce_tick == tick_before + 3, "advanced 3 more ticks (tick %d)" % ce_adapter.ce_tick)
    print("  advanced to tick %d, hash %s" % [ce_adapter.ce_tick, hash_mid.substr(0, 8)])
    _check(hash_mid != hash_before, "state diverged after extra advance (expected)")

    # Restore from the captured checkpoint
    ce_adapter.restore_state(ce_adapter.last_checkpoint, ce_adapter.last_delivery)
    await ce_adapter.ce_state_updated
    _check(ce_adapter.ce_tick == tick_before, "restored to tick %d (got %d)" % [tick_before, ce_adapter.ce_tick])
    _check(ce_adapter.ce_state_hash == hash_before, "restored state hash matches checkpoint (%s)" % ce_adapter.ce_state_hash.substr(0, 8))

    # Resume deterministically after restore: same advance -> same hash as before
    ce_adapter.advance_simulation(3)
    await ce_adapter.ce_state_updated
    _check(ce_adapter.ce_state_hash == hash_mid, "replay after restore reproduces prior hash (%s)" % ce_adapter.ce_state_hash.substr(0, 8))

# ── Test 3: Deterministic replay ───────────────────────────────────────────
func _test_determinism() -> void:
    print("--- Test 3: Deterministic replay ---")
    var expected_hash: String = "5404d32e6ca92e9eed3ca0805c16929b1a7b0336718a5103b4b0f291e8b01e2c"
    print("  expected hash (from prior run): ", expected_hash.substr(0, 8))

    ce_adapter.create_world(42)
    await ce_adapter.ce_state_updated
    ce_adapter.submit_intervention("destroy_infrastructure", "grain_road", "infrastructure", "RF")
    await ce_adapter.ce_state_updated
    ce_adapter.advance_simulation(5)
    await ce_adapter.ce_state_updated
    ce_adapter.get_snapshot()
    await ce_adapter.ce_state_updated

    var actual_hash: String = ce_adapter.ce_state_hash
    _check(actual_hash == expected_hash, "replay hash matches (%s == %s)" % [actual_hash.substr(0, 8), expected_hash.substr(0, 8)])

func _run_all() -> void:
    await _test_game_loop()
    await _test_checkpoint_restore()
    await _test_determinism()

func _finish() -> void:
    print("")
    print("=== RESULTS: %d passed, %d failed ===" % [passed, failed])
    get_tree().quit(0 if failed == 0 else 1)
