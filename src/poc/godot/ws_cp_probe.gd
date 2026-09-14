## P-018: minimal Godot WS checkpoint isolation probe
## Tests whether the checkpointed reply (~34KB) survives Godot's WebSocketPeer.
## Run: godot --headless --path ~/Project_v2/godot-ce-demo res://ws_cp_probe.tscn

extends Node

var adapter: Node

func _ready() -> void:
    adapter = preload("res://ce_ws_adapter.gd").new()
    add_child(adapter)
    adapter.ce_state_updated.connect(_on_state)
    await _run()
    get_tree().quit()

func _pump(ms: float) -> void:
    await get_tree().create_timer(ms / 1000.0).timeout
    adapter._process(0.016)

func _on_state() -> void:
    pass

func _run() -> void:
    print("=== WS checkpoint isolation probe ===")
    adapter.connect_to_ce()
    for i in range(100):
        await _pump(20)
        if adapter.connected: break
    print("connected: ", adapter.connected)
    adapter.create_world(42)
    await _pump(300)
    adapter.submit_intervention("destroy_infrastructure", "grain_road", "infrastructure", "RF")
    await _pump(300)
    adapter.advance_simulation(5)
    await _pump(500)
    print("tick before checkpoint: ", adapter.ce_tick)
    # Reproduce the iso_verify cadence burst (advance 10) before checkpoint
    adapter.advance_simulation(10)
    await _pump(600)
    print("tick after burst: ", adapter.ce_tick, " socket=", adapter.socket.get_ready_state())
    adapter.save_state()
    for i in range(50):
        await _pump(40)
        print("  wait ", i, " last_checkpoint len=", adapter.last_checkpoint.length(), " socket=", adapter.socket.get_ready_state())
        if adapter.last_checkpoint != "": break
    print("final last_checkpoint len=", adapter.last_checkpoint.length())
    print("PROBE DONE")
