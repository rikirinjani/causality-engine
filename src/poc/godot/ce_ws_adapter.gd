## P-017 WebSocket adapter — CE push transport for Godot
##
## Same adapter contract as ce_adapter.gd (HTTP), but over WebSocket push:
##   - submit_intervention / advance_simulation / create_world / state_sync /
##     checkpoint / restore — identical semantics to the HTTP adapter
##   - events are PUSHED by the server after each advance (no per-frame poll)
##   - gap is delivered explicitly (never silent)
##
## The transport is replaceable: Godot code that uses this adapter sees the SAME
## state projection (towns/factions/ce_tick/ce_state_hash) as the HTTP adapter.
## No causal logic, no RNG, no simulation authority lives here.

extends Node

const WS_URL := "ws://127.0.0.1:7778"

var socket: WebSocketPeer
var connected: bool = false
var ce_tick: int = 0
var ce_state_hash: String = ""
var ce_trace_hash: String = ""
var towns: Dictionary = {}
var factions: Dictionary = {}
var recent_events: Array = []
var last_checkpoint: String = ""
var last_delivery: String = ""
var pending_submit_calls: Array = []

signal ce_state_updated
signal ce_event_received(event: Dictionary)

func _ready() -> void:
    socket = WebSocketPeer.new()

func connect_to_ce() -> void:
    var err = socket.connect_to_url(WS_URL)
    if err != OK:
        push_error("WS connect failed: " + str(err))

func _process(_delta: float) -> void:
    if socket.get_ready_state() == WebSocketPeer.STATE_CONNECTING:
        socket.poll()
        return
    if socket.get_ready_state() != WebSocketPeer.STATE_OPEN:
        return
    socket.poll()
    while socket.get_available_packet_count() > 0:
        var packet = socket.get_packet().get_string_from_utf8()
        _on_message(packet)

func create_world(seed_val: int = 42) -> void:
    _send({"type": "create-world", "seed": seed_val})

func submit_intervention(action: String, target_id: String, target_type: String, location: String) -> void:
    var intervention := {
        "id": "godot-ws-" + str(ce_tick) + "-" + action,
        "tick": ce_tick,
        "actor": "player",
        "action": action,
        "target": {"type": target_type, "id": target_id},
        "location": location,
        "magnitude": 1.0,
        "causalDomains": [],
        "provenance": {"submittedAtTick": ce_tick, "sequence": 0}
    }
    _send({"type": "submit", "intervention": intervention})

func advance_simulation(ticks: int = 1) -> void:
    _send({"type": "advance", "ticks": ticks})

func state_sync() -> void:
    _send({"type": "state-sync"})

func get_snapshot() -> void:
    # Full state projection (regions + infrastructure) — mirrors HTTP /snapshot.
    _send({"type": "snapshot"})

func save_state() -> void:
    _send({"type": "checkpoint"})

func restore_state(checkpoint: String, delivery: String) -> void:
    _send({"type": "restore", "checkpoint": checkpoint, "delivery": delivery})

func _send(payload: Dictionary) -> void:
    if socket.get_ready_state() == WebSocketPeer.STATE_OPEN:
        socket.send_text(JSON.stringify(payload))
    else:
        pending_submit_calls.append(payload)

func _on_message(raw: String) -> void:
    var json := JSON.new()
    if json.parse(raw) != OK:
        return
    var data = json.data
    if data == null or not data is Dictionary:
        return
    var msg := data as Dictionary
    var type: String = msg.get("type", "")
    # Any message may carry authoritative tick/stateHash (welcome, result, advanced, snapshot…)
    if msg.has("tick"):
        ce_tick = msg["tick"] as int
    if msg.has("stateHash"):
        ce_state_hash = msg["stateHash"] as String
    match type:
        "welcome":
            connected = true
            ce_tick = msg.get("tick", 0) as int
            ce_state_hash = msg.get("stateHash", "") as String
            # Deliver any retained events on connect (catch-up / replay)
            ce_state_updated.emit()
        "events":
            var events_array = msg.get("events", []) as Array
            for e in events_array:
                var env := e as Dictionary
                # WS wraps the event: {eventId, attempt, streamSeq, event:{...}}
                var ev := env.get("event", env) as Dictionary
                recent_events.append(ev)
                ce_event_received.emit(ev)
            ce_state_updated.emit()
        "gap":
            var gap := msg.get("gap", {}) as Dictionary
            recent_events.append({"type": "gap", "missingFromSeq": gap.get("missingFromSeq", -1), "missingToSeq": gap.get("missingToSeq", -1), "remedy": gap.get("remedy", "")})
            ce_state_updated.emit()
        "advanced":
            ce_tick = msg.get("tick", ce_tick) as int
            ce_state_hash = msg.get("stateHash", ce_state_hash) as String
            ce_trace_hash = msg.get("traceHash", ce_trace_hash) as String
            # events frame follows this in the same tick loop
        "sync":
            var sync := msg.get("sync", {}) as Dictionary
            if sync.has("stateHash"):
                ce_state_hash = sync["stateHash"] as String
            if sync.has("tick"):
                ce_tick = sync["tick"] as int
            if sync.has("regions"):
                _project_state_sync(sync)
            ce_state_updated.emit()
        "snapshot":
            ce_tick = msg.get("tick", ce_tick) as int
            ce_state_hash = msg.get("stateHash", ce_state_hash) as String
            ce_trace_hash = msg.get("traceHash", ce_trace_hash) as String
            if msg.has("regions"):
                _project_state(msg)
            ce_state_updated.emit()
        "checkpointed":
            last_checkpoint = msg.get("checkpoint", "") as String
            last_delivery = msg.get("delivery", "") as String
            ce_state_updated.emit()
        "restored":
            ce_tick = msg.get("tick", ce_tick) as int
            ce_state_hash = msg.get("stateHash", ce_state_hash) as String
            ce_state_updated.emit()
        "result", "pong":
            ce_state_updated.emit()

func _project_state(snapshot_msg: Dictionary) -> void:
    towns.clear()
    var regions := snapshot_msg.get("regions", {}) as Dictionary
    for town_id in regions:
        var region := regions[town_id] as Dictionary
        var route_health := 0.0
        if region.has("infrastructure"):
            var infra := region["infrastructure"] as Dictionary
            if infra.has("grain_road"):
                var rd := infra["grain_road"] as Dictionary
                route_health = rd.get("health", 0.0)
        towns[town_id] = {
            "name": region.get("name", town_id),
            "grain_price": (region.get("prices", {}) as Dictionary).get("grain", 0.0),
            "grain_stock": (region.get("stocks", {}) as Dictionary).get("grain", 0.0),
            "unrest": region.get("unrest", 0.0),
            "patrol_demand": region.get("patrolDemand", 0.0),
            "trade_route_intact": route_health > 0,
        }
    factions.clear()
    var relations := snapshot_msg.get("relations", {}) as Dictionary
    for key in relations:
        var key_str = key as String
        var parts = key_str.split(">")
        if parts.size() == 2:
            var faction_id = parts[0] as String
            if not factions.has(faction_id):
                factions[faction_id] = {"hostility": 0.0}
            var faction_data = factions[faction_id] as Dictionary
            faction_data["hostility"] = relations[key]

func _project_state_sync(sync: Dictionary) -> void:
    towns.clear()
    var regions := sync.get("regions", {}) as Dictionary
    for town_id in regions:
        var region := regions[town_id] as Dictionary
        towns[town_id] = {
            "name": town_id,
            "grain_price": region.get("grainPrice", 0.0),
            "grain_stock": region.get("grainStock", 0.0),
            "unrest": region.get("unrest", 0.0),
            "patrol_demand": region.get("patrolDemand", 0.0),
            "trade_route_intact": true, # stateSync carries no infrastructure; snapshot does
        }
    factions.clear()
    var relations := sync.get("relations", {}) as Dictionary
    for key in relations:
        var key_str = key as String
        var parts = key_str.split(">")
        if parts.size() == 2:
            var faction_id = parts[0] as String
            if not factions.has(faction_id):
                factions[faction_id] = {"hostility": 0.0}
            var faction_data = factions[faction_id] as Dictionary
            faction_data["hostility"] = relations[key]
