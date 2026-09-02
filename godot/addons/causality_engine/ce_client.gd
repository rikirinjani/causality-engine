## CeClient — Causality Engine transport client for Godot.
##
## ┌─────────────────────────────────────────────────────────────────────────┐
## │ AUTHORITY BOUNDARY                                                      │
## │                                                                         │
## │ Godot owns   rendering, animation, camera, UI, input, audio,            │
## │              presentation, and translating player intent.               │
## │                                                                         │
## │ This addon   translates intent into CE interventions, projects CE state │
## │ owns         and events into game-facing structures, and handles        │
## │              transport, reconnection, and recovery.                     │
## │                                                                         │
## │ CE owns      world state, causal rules, causal propagation, temporal    │
## │              state, RNG, event generation, provenance, attribution,     │
## │              persistence, branching, rewind, timeline identity.         │
## └─────────────────────────────────────────────────────────────────────────┘
##
## THIS FILE CONTAINS NO CAUSAL RULE AND NO RNG. Searchable: there is no
## randi, randf, randomize, rand_range, or RandomNumberGenerator anywhere in
## this addon. If you find yourself wanting to add one, that decision belongs
## in CE, not here.
##
## ── Usage ────────────────────────────────────────────────────────────────
##
##   var ce := CeClient.new()
##   ce.host = "127.0.0.1"
##   ce.port = 7778
##   add_child(ce)
##
##   ce.connected.connect(_on_ce_connected)
##   ce.state_updated.connect(_on_ce_state)
##   ce.event_received.connect(_on_ce_event)
##
##   ce.connect_to_ce()
##   # after `connected` fires:
##   ce.create_world(42)
##   ce.request_snapshot()
##   ce.submit_intervention("destroy_infrastructure", "grain_road", "infrastructure", "RF")
##   ce.advance(5)
##
## Requires a reachable CE runtime. See RUNTIME-REQUIREMENTS.md.

extends Node
class_name CeClient

# ── Configuration ──────────────────────────────────────────────────────────
# Set these before calling connect_to_ce(). No value here is machine-specific.

## Host running the CE WebSocket runtime.
@export var host: String = "127.0.0.1"

## Port the CE WebSocket runtime listens on.
@export var port: int = 7778

## Use wss:// instead of ws://.
@export var use_tls: bool = false

## Poll the socket automatically each frame. Disable to drive `poll()` yourself
## (useful for headless drivers that control their own cadence).
@export var auto_poll: bool = true

## Reconnect automatically after an unexpected close.
@export var auto_reconnect: bool = true

## Seconds to wait between reconnect attempts.
@export var reconnect_delay_seconds: float = 2.0

## Inbound/outbound socket buffer size. CE checkpoints grow with world size and
## are chunked server-side; this raises Godot's default ~64 KiB ceiling.
@export var socket_buffer_bytes: int = 1 << 21  # 2 MiB

## Print every frame sent and received. Development aid; off by default.
@export var verbose: bool = false

# ── Signals ────────────────────────────────────────────────────────────────

## Socket opened and CE sent its welcome frame.
signal connected(consumer_id: String, timeline_id: String)

## Socket closed. `will_retry` is true when auto_reconnect is enabled.
signal disconnected(will_retry: bool)

## Connection failed to establish.
signal connection_failed(reason: String)

## Any frame carrying authoritative world state was applied. Read `tick`,
## `state_hash`, `regions`, `relations` after this fires.
signal state_updated

## A single CE event (historical fact). Delivered in CE's canonical order.
signal event_received(event: Dictionary)

## CE reported a retention gap: facts were evicted before this consumer read
## them. Never silent. Call `resync()` to recover.
signal gap_received(gap: Dictionary)

## CE answered an explain request.
signal explanation_received(quantity: String, explanation: Dictionary)

## A checkpoint finished transferring (chunks reassembled).
signal checkpoint_ready(checkpoint_id: String, payload: String, delivery: String)

## A world was restored from a checkpoint.
signal restored(tick: int, state_hash: String)

## A new timeline was forked. `timeline_id` is now the current timeline.
signal forked(timeline_id: String, parent_timeline_id: String)

## The current timeline was rewound. `abandoned_timeline_id` is referenceable.
signal rewound(timeline_id: String, abandoned_timeline_id: String)

## The current timeline was switched.
signal switched(timeline_id: String)

## The timeline registry was received.
signal timelines_received(timelines: Array)

## A timeline comparison was received.
signal comparison_received(comparison: Dictionary)

## CE accepted or rejected a submitted intervention.
signal intervention_result(ok: bool, errors: Array)

# ── Authoritative CE state (read-only from the game's perspective) ─────────
# Every field here is a PROJECTION of what CE reported. Never write to these
# from game code — CE is the authority, and a local write would be a lie.

## Current CE tick.
var tick: int = 0

## CE's physical world identity (SHA-256).
var state_hash: String = ""

## CE's causal-history identity (SHA-256).
var trace_hash: String = ""

## Timeline the client is currently observing.
var timeline_id: String = ""

## Consumer channel id CE assigned to this client.
var consumer_id: String = ""

## Regions projected from CE snapshots. Shape per region:
##   name, grain_price, grain_stock, unrest, patrol_demand,
##   trade_route_intact, warehouse_intact, prices, stocks, infrastructure
var regions: Dictionary = {}

## Faction hostility projected from CE relations. Shape: { faction_id: {hostility} }
var factions: Dictionary = {}

## Raw CE relations map, e.g. { "MG>RF": 0.42 }.
var relations: Dictionary = {}

## Most recent events received, oldest first. Bounded by `event_history_limit`.
var recent_events: Array = []

## How many events to retain locally for convenience. CE's own retention is
## separate and authoritative.
@export var event_history_limit: int = 100

## Identity of the last checkpoint CE stored.
var last_checkpoint_id: String = ""

## Serialized payload of the last checkpoint (reassembled from chunks).
var last_checkpoint: String = ""

## Serialized delivery cursor captured with the last checkpoint.
var last_delivery: String = ""

## Known timelines, from the last `list_timelines()` call.
var timelines: Array = []

## Last comparison result.
var last_comparison: Dictionary = {}

## True while the socket is open and CE has welcomed this client.
var connection_open: bool = false

# ── Internals ──────────────────────────────────────────────────────────────

var _socket: WebSocketPeer
var _queued_frames: Array = []
var _checkpoint_chunks: Dictionary = {}
var _reconnect_timer: float = 0.0
var _reconnect_pending: bool = false
var _was_connected: bool = false


func _ready() -> void:
	_socket = WebSocketPeer.new()
	_socket.inbound_buffer_size = socket_buffer_bytes
	_socket.outbound_buffer_size = socket_buffer_bytes


## Full endpoint URL derived from host/port/use_tls.
func endpoint() -> String:
	var scheme := "wss" if use_tls else "ws"
	return "%s://%s:%d" % [scheme, host, port]


## Open the connection. Frames submitted before the socket opens are queued.
func connect_to_ce() -> void:
	_reconnect_pending = false
	var err := _socket.connect_to_url(endpoint())
	if err != OK:
		var reason := "connect_to_url failed with error %d for %s" % [err, endpoint()]
		push_warning("[CE] " + reason)
		connection_failed.emit(reason)


## Close the connection. Disables auto-reconnect for this call.
func disconnect_from_ce() -> void:
	_reconnect_pending = false
	if _socket.get_ready_state() != WebSocketPeer.STATE_CLOSED:
		_socket.close()
	connection_open = false


func _process(delta: float) -> void:
	if auto_poll:
		poll(delta)


## Pump the socket. Call this yourself when `auto_poll` is false.
func poll(delta: float = 0.0) -> void:
	if _reconnect_pending:
		_reconnect_timer -= delta
		if _reconnect_timer <= 0.0:
			_reconnect_pending = false
			connect_to_ce()
		return

	var state := _socket.get_ready_state()

	if state == WebSocketPeer.STATE_CONNECTING:
		_socket.poll()
		return

	if state == WebSocketPeer.STATE_OPEN:
		_flush_queue()
		_socket.poll()
		while _socket.get_available_packet_count() > 0:
			_handle_frame(_socket.get_packet().get_string_from_utf8())
		return

	if state == WebSocketPeer.STATE_CLOSING:
		_socket.poll()
		return

	# STATE_CLOSED
	if _was_connected:
		_was_connected = false
		connection_open = false
		disconnected.emit(auto_reconnect)
		if auto_reconnect:
			_reconnect_pending = true
			_reconnect_timer = reconnect_delay_seconds


# ═══════════════════════════════════════════════════════════════════════════
# WORLD LIFECYCLE
# ═══════════════════════════════════════════════════════════════════════════

## Ask CE to create a fresh world. Same seed always produces the same world.
func create_world(seed_value: int = 42) -> void:
	_send({"type": "create-world", "seed": seed_value})


## Request a full state projection (regions, prices, stocks, infrastructure).
func request_snapshot() -> void:
	_send({"type": "snapshot"})


## Request a compact state sync. Carries no infrastructure detail; use
## `request_snapshot()` when you need structure health.
func request_state_sync() -> void:
	_send({"type": "state-sync"})


## Advance causal time by `ticks`. CE never ticks on its own — nothing happens
## in the world until the game asks for it.
func advance(ticks: int = 1) -> void:
	_send({"type": "advance", "ticks": ticks})


## Liveness check. CE replies with a pong carrying tick and state hash.
func ping() -> void:
	_send({"type": "ping"})


# ═══════════════════════════════════════════════════════════════════════════
# INTERVENTIONS
# ═══════════════════════════════════════════════════════════════════════════

## Submit a player action.
##
## `causalDomains` is deliberately EMPTY. Causal pressure is authored
## exclusively by CE's action schemas. If this addon populated it, causal
## physics would have leaked out of the engine and into presentation code.
##
## `action`      CE action name, e.g. "destroy_infrastructure"
## `target_id`   what is acted upon, e.g. "grain_road"
## `target_type` "infrastructure" | "entity" | "region"
## `location`    region the action happens in, e.g. "RF"
## `magnitude`   normalised strength in [0, 1]
## `actor`       who did it
func submit_intervention(
	action: String,
	target_id: String,
	target_type: String,
	location: String,
	magnitude: float = 1.0,
	actor: String = "player"
) -> void:
	var intervention := {
		"id": "%s-%d-%s" % [actor, tick, action],
		"tick": tick,
		"actor": actor,
		"action": action,
		"target": {"type": target_type, "id": target_id},
		"location": location,
		"magnitude": magnitude,
		"causalDomains": [],
		"provenance": {"submittedAtTick": tick, "sequence": 0},
	}
	_send({"type": "submit", "intervention": intervention})


## Submit several interventions in one round trip. CE resolves them under the
## same canonical ordering rules as individual submissions.
func submit_batch(interventions: Array) -> void:
	_send({"type": "submit-batch", "interventions": interventions})


# ═══════════════════════════════════════════════════════════════════════════
# EVENT DELIVERY
# ═══════════════════════════════════════════════════════════════════════════

## Acknowledge facts through a stream sequence number.
##
## CE delivers at-least-once. Acknowledging is how a consumer says "I have
## these"; until then CE may redeliver. Cursors never move backwards.
func ack(through_stream_seq: int) -> void:
	_send({"type": "ack", "streamSeq": through_stream_seq})


## Recover from a gap by adopting CE's present position.
##
## This does not pretend the gap did not happen — `gap_received` already fired.
## It repositions the cursor past the unreachable backlog.
func resync(sync: Dictionary) -> void:
	_send({"type": "resync", "sync": sync})


# ═══════════════════════════════════════════════════════════════════════════
# PERSISTENCE
# ═══════════════════════════════════════════════════════════════════════════

## Ask CE to capture a checkpoint. CE stores it and streams the payload back in
## chunks; `checkpoint_ready` fires once reassembled.
func checkpoint() -> void:
	_send({"type": "checkpoint"})


## Restore a world from a checkpoint payload.
func restore(checkpoint_payload: String, delivery_payload: String = "") -> void:
	_send({"type": "restore", "checkpoint": checkpoint_payload, "delivery": delivery_payload})


# ═══════════════════════════════════════════════════════════════════════════
# TIMELINES — branching and rewind are CE operations, not save-file tricks
# ═══════════════════════════════════════════════════════════════════════════

## Fork an independent timeline from a stored checkpoint and switch to it.
func fork(checkpoint_id: String, discriminator: String = "B") -> void:
	_send({"type": "fork", "checkpointId": checkpoint_id, "discriminator": discriminator})


## Rewind the current timeline to a stored checkpoint. The abandoned future
## stays referenceable.
func rewind(checkpoint_id: String) -> void:
	_send({"type": "rewind", "checkpointId": checkpoint_id})


## Switch observation to an existing timeline.
func switch_timeline(target_timeline_id: String) -> void:
	_send({"type": "switch-timeline", "timelineId": target_timeline_id})


## Request the timeline registry.
func list_timelines() -> void:
	_send({"type": "list-timelines"})


## Request lineage detail for one timeline.
func timeline_info(target_timeline_id: String) -> void:
	_send({"type": "timeline-info", "timelineId": target_timeline_id})


## Compare two timelines side by side.
func compare_timelines(a_timeline_id: String, b_timeline_id: String) -> void:
	_send({"type": "compare-timelines", "a": a_timeline_id, "b": b_timeline_id})


# ═══════════════════════════════════════════════════════════════════════════
# EXPLANATION
# ═══════════════════════════════════════════════════════════════════════════

## Ask CE why a quantity has its current value.
##
## The answer is CE's own causal attribution. This addon never computes,
## infers, or guesses causality.
##
## Quantity keys follow CE's format, e.g.
##   "RF:price:grain"   "RF:stock:grain"   "MG:hostility"
##   "RF:unrest"        "RF:infra:grain_road"
## Use the `Quantity` helper to build them safely.
func request_explain(quantity: String) -> void:
	_send({"type": "explain", "quantity": quantity})


# ═══════════════════════════════════════════════════════════════════════════
# CONVENIENCE READERS
# ═══════════════════════════════════════════════════════════════════════════

## Projected region, or an empty Dictionary when unknown.
func region(region_id: String) -> Dictionary:
	return regions.get(region_id, {})


## Grain price in a region, or `default` when unknown.
func grain_price(region_id: String, default: float = 0.0) -> float:
	return region(region_id).get("grain_price", default)


## Whether CE reports a structure as intact. Presentation should follow this,
## never a local guess.
func is_structure_intact(region_id: String, structure_id: String) -> bool:
	var infra: Dictionary = region(region_id).get("infrastructure", {})
	var structure: Dictionary = infra.get(structure_id, {})
	return structure.get("health", 0.0) > 0.0


## Hostility of a faction toward the player's side, or `default`.
func hostility(faction_id: String, default: float = 0.0) -> float:
	return factions.get(faction_id, {}).get("hostility", default)


# ═══════════════════════════════════════════════════════════════════════════
# TRANSPORT INTERNALS
# ═══════════════════════════════════════════════════════════════════════════

func _send(payload: Dictionary) -> void:
	if _socket.get_ready_state() == WebSocketPeer.STATE_OPEN:
		if verbose:
			print("[CE][send] ", JSON.stringify(payload).substr(0, 80))
		_socket.send_text(JSON.stringify(payload))
	else:
		if verbose:
			print("[CE][queue] ", JSON.stringify(payload).substr(0, 80))
		_queued_frames.append(payload)


func _flush_queue() -> void:
	if _queued_frames.is_empty():
		return
	var pending: Array = _queued_frames.duplicate()
	_queued_frames.clear()
	for payload in pending:
		_socket.send_text(JSON.stringify(payload))


func _record_event(event: Dictionary) -> void:
	recent_events.append(event)
	if recent_events.size() > event_history_limit:
		recent_events = recent_events.slice(recent_events.size() - event_history_limit)


func _handle_frame(raw: String) -> void:
	var json := JSON.new()
	if json.parse(raw) != OK:
		push_warning("[CE] unparseable frame discarded")
		return
	var data: Variant = json.data
	if data == null or not data is Dictionary:
		return

	var msg: Dictionary = data
	var frame_type: String = msg.get("type", "")
	if verbose:
		print("[CE][recv] ", frame_type)

	# Any frame may carry authoritative position. CE is the authority for both.
	if msg.has("tick"):
		tick = int(msg["tick"])
	if msg.has("stateHash"):
		state_hash = String(msg["stateHash"])
	if msg.has("traceHash"):
		trace_hash = String(msg["traceHash"])

	match frame_type:
		"welcome":
			connection_open = true
			_was_connected = true
			consumer_id = String(msg.get("consumerId", ""))
			timeline_id = String(msg.get("timelineId", ""))
			connected.emit(consumer_id, timeline_id)
			state_updated.emit()

		"events":
			var envelopes: Array = msg.get("events", [])
			for envelope in envelopes:
				var wrapper: Dictionary = envelope
				# CE wraps each fact: {eventId, attempt, streamSeq, event:{...}}
				var event: Dictionary = wrapper.get("event", wrapper)
				_record_event(event)
				event_received.emit(event)
			state_updated.emit()

		"gap":
			# Never silent. A gap means facts were evicted before this consumer
			# read them; the game decides how to recover.
			var gap: Dictionary = msg.get("gap", {})
			_record_event({"type": "ce.gap", "gap": gap})
			gap_received.emit(gap)
			state_updated.emit()

		"advanced":
			state_updated.emit()

		"snapshot":
			if msg.has("regions"):
				_project_snapshot(msg)
			state_updated.emit()

		"sync":
			var sync: Dictionary = msg.get("sync", {})
			if sync.has("stateHash"):
				state_hash = String(sync["stateHash"])
			if sync.has("tick"):
				tick = int(sync["tick"])
			if sync.has("regions"):
				_project_state_sync(sync)
			state_updated.emit()

		"explanation":
			explanation_received.emit(String(msg.get("quantity", "")), msg.get("explanation", {}))

		"checkpoint-part":
			_collect_checkpoint_chunk(msg)

		"checkpointed":
			_finish_checkpoint(msg)

		"restored":
			restored.emit(tick, state_hash)
			state_updated.emit()

		"forked":
			timeline_id = String(msg.get("timelineId", ""))
			forked.emit(timeline_id, String(msg.get("parentTimelineId", "")))
			list_timelines()
			state_updated.emit()

		"rewound":
			timeline_id = String(msg.get("timelineId", ""))
			rewound.emit(timeline_id, String(msg.get("abandonedTimelineId", "")))
			list_timelines()
			state_updated.emit()

		"switched":
			timeline_id = String(msg.get("timelineId", ""))
			switched.emit(timeline_id)
			list_timelines()
			state_updated.emit()

		"timelines":
			timelines = msg.get("timelines", [])
			timelines_received.emit(timelines)
			state_updated.emit()

		"timeline-info":
			timeline_id = String(msg.get("timelineId", timeline_id))
			state_updated.emit()

		"comparison":
			last_comparison = msg
			comparison_received.emit(msg)
			state_updated.emit()

		"result":
			intervention_result.emit(bool(msg.get("ok", false)), msg.get("errors", []))
			state_updated.emit()

		"pong":
			state_updated.emit()

		_:
			if verbose:
				print("[CE] unhandled frame type: ", frame_type)


func _collect_checkpoint_chunk(msg: Dictionary) -> void:
	# CE splits large checkpoints because Godot's WebSocketPeer drops oversized
	# messages. Reassembly is transport bookkeeping, not world logic.
	var cid: String = msg.get("cid", "")
	if cid == "":
		return
	if not _checkpoint_chunks.has(cid):
		_checkpoint_chunks[cid] = {"total": int(msg.get("total", 0)), "parts": {}}
	var entry: Dictionary = _checkpoint_chunks[cid]
	entry["parts"][int(msg.get("index", 0))] = String(msg.get("part", ""))


func _finish_checkpoint(msg: Dictionary) -> void:
	var cid: String = msg.get("cid", "")

	if cid != "" and _checkpoint_chunks.has(cid):
		var entry: Dictionary = _checkpoint_chunks[cid]
		var assembled := ""
		for index in range(int(entry["total"])):
			assembled += String(entry["parts"].get(index, ""))
		last_checkpoint = assembled
		_checkpoint_chunks.erase(cid)
	elif msg.has("checkpoint"):
		# Small worlds arrive in a single frame.
		last_checkpoint = String(msg.get("checkpoint", ""))

	last_delivery = String(msg.get("delivery", ""))
	last_checkpoint_id = cid
	checkpoint_ready.emit(last_checkpoint_id, last_checkpoint, last_delivery)
	state_updated.emit()


# ── Projection: CE state -> game-facing structures ────────────────────────
# Reshaping only. Every value originates in CE; none is computed here.

func _project_snapshot(msg: Dictionary) -> void:
	regions.clear()
	var incoming: Dictionary = msg.get("regions", {})

	for region_id in incoming:
		var source: Dictionary = incoming[region_id]
		var infrastructure: Dictionary = source.get("infrastructure", {})

		var route_health := 0.0
		if infrastructure.has("grain_road"):
			route_health = float((infrastructure["grain_road"] as Dictionary).get("health", 0.0))

		var warehouse_health := 0.0
		if infrastructure.has("grain_warehouse"):
			warehouse_health = float((infrastructure["grain_warehouse"] as Dictionary).get("health", 0.0))

		var prices: Dictionary = source.get("prices", {})
		var stocks: Dictionary = source.get("stocks", {})

		regions[region_id] = {
			"name": source.get("name", region_id),
			"prices": prices,
			"stocks": stocks,
			"infrastructure": infrastructure,
			"grain_price": prices.get("grain", 0.0),
			"grain_stock": stocks.get("grain", 0.0),
			"unrest": source.get("unrest", 0.0),
			"patrol_demand": source.get("patrolDemand", 0.0),
			"trade_investment": source.get("tradeInvestment", 0.0),
			"trade_route_intact": route_health > 0.0,
			"warehouse_intact": warehouse_health > 0.0,
		}

	_project_relations(msg.get("relations", {}))


func _project_state_sync(sync: Dictionary) -> void:
	regions.clear()
	var incoming: Dictionary = sync.get("regions", {})

	for region_id in incoming:
		var source: Dictionary = incoming[region_id]
		regions[region_id] = {
			"name": region_id,
			"prices": {"grain": source.get("grainPrice", 0.0)},
			"stocks": {"grain": source.get("grainStock", 0.0)},
			"infrastructure": {},
			"grain_price": source.get("grainPrice", 0.0),
			"grain_stock": source.get("grainStock", 0.0),
			"unrest": source.get("unrest", 0.0),
			"patrol_demand": source.get("patrolDemand", 0.0),
			"trade_investment": source.get("tradeInvestment", 0.0),
			# state-sync carries no infrastructure detail. Do not infer it —
			# request a snapshot when structure health matters.
			"trade_route_intact": true,
			"warehouse_intact": true,
		}

	_project_relations(sync.get("relations", {}))


func _project_relations(incoming: Dictionary) -> void:
	relations = incoming.duplicate()
	factions.clear()
	for relation_key in incoming:
		var parts: PackedStringArray = String(relation_key).split(">")
		if parts.size() != 2:
			continue
		var faction_id: String = parts[0]
		if not factions.has(faction_id):
			factions[faction_id] = {"hostility": 0.0}
		(factions[faction_id] as Dictionary)["hostility"] = incoming[relation_key]
