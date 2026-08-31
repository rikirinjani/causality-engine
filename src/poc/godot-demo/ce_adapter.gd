extends Node

const CE_URL := "http://127.0.0.1:7777"

var http_request: HTTPRequest
var ce_tick: int = 0
var ce_state_hash: String = ""
var ce_trace_hash: String = ""
var towns: Dictionary = {}
var factions: Dictionary = {}
var recent_events: Array = []
var connected: bool = false
var pending_requests: Array = []

signal ce_state_updated
signal ce_event_received(event: Dictionary)

func _ready() -> void:
    http_request = HTTPRequest.new()
    add_child(http_request)
    http_request.request_completed.connect(_on_http_completed)

func connect_to_ce() -> void:
    _queue_request(CE_URL + "/health")

func create_world(seed_val: int = 42) -> void:
    var body := JSON.stringify({"seed": seed_val})
    _queue_request(CE_URL + "/create-world", ["Content-Type: application/json"], HTTPClient.METHOD_POST, body)

func submit_intervention(action: String, target_id: String, target_type: String, location: String) -> void:
    var intervention := {
        "id": "godot-" + str(ce_tick) + "-" + action,
        "tick": ce_tick,
        "actor": "player",
        "action": action,
        "target": {"type": target_type, "id": target_id},
        "location": location,
        "magnitude": 1.0,
        "causalDomains": [],
        "provenance": {"submittedAtTick": ce_tick, "sequence": 0}
    }
    var body := JSON.stringify({"intervention": intervention})
    _queue_request(CE_URL + "/submit", ["Content-Type: application/json"], HTTPClient.METHOD_POST, body)

func advance_simulation(ticks: int = 1) -> void:
    var body := JSON.stringify({"ticks": ticks})
    _queue_request(CE_URL + "/advance", ["Content-Type: application/json"], HTTPClient.METHOD_POST, body)

func poll_events() -> void:
    _queue_request(CE_URL + "/poll")

func get_snapshot() -> void:
    _queue_request(CE_URL + "/snapshot")

func save_state() -> void:
    _queue_request(CE_URL + "/checkpoint", ["Content-Type: application/json"], HTTPClient.METHOD_POST, "{}")

func restore_state(checkpoint: String, delivery: String) -> void:
    var body := JSON.stringify({"checkpoint": checkpoint, "delivery": delivery})
    _queue_request(CE_URL + "/restore", ["Content-Type: application/json"], HTTPClient.METHOD_POST, body)

func _queue_request(url: String, headers: PackedStringArray = PackedStringArray(), method: int = HTTPClient.METHOD_GET, body: String = "") -> void:
    var status = http_request.get_http_client_status()
    if status == HTTPClient.STATUS_REQUESTING or status == HTTPClient.STATUS_RESOLVING or status == HTTPClient.STATUS_CONNECTING:
        pending_requests.append({"url": url, "headers": headers, "method": method, "body": body})
    else:
        http_request.request(url, headers, method, body)

func _on_http_completed(result: int, response_code: int, headers: PackedStringArray, body: PackedByteArray) -> void:
    if result != HTTPRequest.RESULT_SUCCESS:
        _process_next_request()
        return
    var json := JSON.new()
    var error := json.parse(body.get_string_from_utf8())
    if error != OK:
        _process_next_request()
        return
    var data = json.data
    if data == null or not data is Dictionary:
        _process_next_request()
        return
    var data_dict = data as Dictionary
    if data_dict.has("tick"):
        ce_tick = data_dict["tick"] as int
    if data_dict.has("stateHash"):
        ce_state_hash = data_dict["stateHash"] as String
    if data_dict.has("traceHash"):
        ce_trace_hash = data_dict["traceHash"] as String
    if data_dict.has("regions"):
        _project_state(data_dict)
    if data_dict.has("events"):
        var events_array = data_dict["events"] as Array
        for event in events_array:
            var event_dict = event as Dictionary
            recent_events.append(event_dict)
            ce_event_received.emit(event_dict)
    ce_state_updated.emit()
    _process_next_request()

func _process_next_request() -> void:
    if pending_requests.size() > 0:
        var next = pending_requests.pop_front() as Dictionary
        http_request.request(next["url"] as String, next["headers"] as PackedStringArray, next["method"] as int, next["body"] as String)

func _project_state(data: Dictionary) -> void:
    towns.clear()
    var regions := data["regions"] as Dictionary
    for town_id in regions:
        var region := regions[town_id] as Dictionary
        var infra := region["infrastructure"] as Dictionary
        var route_health := 0.0
        if infra.has("grain_road"):
            var route_data = infra["grain_road"] as Dictionary
            route_health = route_data["health"] as float
        var warehouse_health := 0.0
        if infra.has("grain_warehouse"):
            var warehouse_data = infra["grain_warehouse"] as Dictionary
            warehouse_health = warehouse_data["health"] as float
        towns[town_id] = {
            "name": region["name"],
            "grain_price": region["prices"]["grain"],
            "grain_stock": region["stocks"]["grain"],
            "unrest": region["unrest"],
            "patrol_demand": region["patrol_demand"],
            "trade_route_intact": route_health > 0,
            "warehouse_intact": warehouse_health > 0,
        }
    factions.clear()
    var relations := data["relations"] as Dictionary
    for key in relations:
        var key_str = key as String
        var parts = key_str.split(">")
        if parts.size() == 2:
            var faction_id = parts[0] as String
            if not factions.has(faction_id):
                factions[faction_id] = {"hostility": 0.0}
            var faction_data = factions[faction_id] as Dictionary
            faction_data["hostility"] = relations[key]
