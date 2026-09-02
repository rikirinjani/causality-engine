## CE Minimal Sample — the smallest complete Causality Engine integration.
##
## Six steps, one screen, no game content:
##
##   connect -> inspect -> intervene -> advance -> event -> render consequence
##
## Everything visible here is a PROJECTION of what CE reported. There is no
## causal rule and no RNG in this file. The bridge disappears because CE says
## its health reached zero, not because this script decided so.
##
## Run with a CE runtime listening on ws://127.0.0.1:7778.

extends Node2D

const ADDON := "res://addons/causality_engine/ce_client.gd"
const QUANTITY := preload("res://addons/causality_engine/quantity.gd")

var ce: Node

# ── Presentation nodes (Godot's job) ───────────────────────────────────────
var status_label: Label
var price_label: Label
var hostility_label: Label
var explain_label: RichTextLabel
var hint_label: Label
var bridge_rect: ColorRect
var market_rect: ColorRect
var act_button: Button
var advance_button: Button
var explain_button: Button

var event_log: Array = []


func _ready() -> void:
	_build_ui()

	# ── Step 1: connect ────────────────────────────────────────────────────
	ce = preload(ADDON).new()
	ce.host = "127.0.0.1"
	ce.port = 7778
	add_child(ce)

	ce.connected.connect(_on_connected)
	ce.connection_failed.connect(_on_connection_failed)
	ce.disconnected.connect(_on_disconnected)
	ce.state_updated.connect(_on_state_updated)
	ce.event_received.connect(_on_event_received)
	ce.gap_received.connect(_on_gap_received)
	ce.explanation_received.connect(_on_explanation)
	ce.intervention_result.connect(_on_intervention_result)

	status_label.text = "Connecting to %s ..." % ce.endpoint()
	ce.connect_to_ce()


# ═══════════════════════════════════════════════════════════════════════════
# CE lifecycle
# ═══════════════════════════════════════════════════════════════════════════

func _on_connected(consumer_id: String, timeline_id: String) -> void:
	status_label.text = "Connected as %s" % consumer_id
	# ── Step 2: create and inspect ─────────────────────────────────────────
	ce.create_world(42)
	ce.request_snapshot()


func _on_connection_failed(reason: String) -> void:
	status_label.text = "Connection failed: %s" % reason
	hint_label.text = "Start a CE runtime, then restart this scene."


func _on_disconnected(will_retry: bool) -> void:
	status_label.text = "Disconnected" + (" — retrying" if will_retry else "")


# ── Step 3: player intervention ────────────────────────────────────────────
func _on_destroy_bridge() -> void:
	# The game says WHAT happened. CE decides what it CAUSES.
	ce.submit_intervention("destroy_infrastructure", "grain_road", "infrastructure", "RF")
	ce.request_snapshot()
	status_label.text = "Sent intervention: destroy grain_road"


# ── Step 4: advance causal time ────────────────────────────────────────────
func _on_advance() -> void:
	# CE never ticks on its own. Nothing happens until the game asks.
	ce.advance(5)
	ce.request_snapshot()


func _on_explain() -> void:
	ce.request_explain(QUANTITY.price("RF", "grain"))


func _on_intervention_result(ok: bool, errors: Array) -> void:
	if not ok:
		status_label.text = "CE rejected the intervention: %s" % ", ".join(errors)


# ── Step 5: consume events ─────────────────────────────────────────────────
func _on_event_received(event: Dictionary) -> void:
	event_log.append(event.get("type", "?"))
	if event_log.size() > 6:
		event_log = event_log.slice(event_log.size() - 6)


func _on_gap_received(gap: Dictionary) -> void:
	# CE reports eviction explicitly. Adopt its present rather than guessing.
	status_label.text = "Gap %s..%s — resyncing" % [
		gap.get("missingFromSeq", "?"), gap.get("missingToSeq", "?")
	]
	ce.request_snapshot()


# ── Step 6: render the consequence ─────────────────────────────────────────
func _on_state_updated() -> void:
	price_label.text = "Grain price: %.2f" % ce.grain_price("RF")

	# CE says whether the bridge stands. Presentation follows.
	bridge_rect.visible = ce.is_structure_intact("RF", "grain_road")

	# Market colour tracks the authoritative price. This is presentation of a
	# CE value, not a causal rule.
	var price: float = ce.grain_price("RF")
	market_rect.color = Color(0.80, clampf(0.55 - (price - 10.0) * 0.03, 0.1, 0.55), 0.25)

	var hostility_text := ""
	for faction_id in ce.factions:
		hostility_text += "%s %.2f  " % [faction_id, ce.hostility(faction_id)]
	hostility_label.text = "Hostility: " + hostility_text

	var suffix := ""
	if not event_log.is_empty():
		suffix = "  |  events: " + ", ".join(event_log)
	status_label.text = "tick %d  hash %s%s" % [ce.tick, ce.state_hash.substr(0, 8), suffix]


func _on_explanation(quantity: String, explanation: Dictionary) -> void:
	explain_label.visible = true
	var body := "[b]Why is %s what it is?[/b]\n\n" % quantity

	if not explanation.get("explained", false):
		body += "CE found no recorded cause.\n"
		body += "This is CE's answer, not a guess made here."
	else:
		if explanation.get("incomplete", false):
			body += "[i](trace incomplete — some ancestors were evicted)[/i]\n\n"
		var roots: Array = explanation.get("roots", [])
		body += "[b]Originating actions:[/b]\n"
		for root in roots.slice(0, 3):
			var r: Dictionary = root
			body += "  %s on %s (tick %s)\n" % [
				r.get("action", "?"), r.get("targetId", "?"), r.get("tick", "?")
			]

	explain_label.text = body


# ═══════════════════════════════════════════════════════════════════════════
# UI construction (pure presentation)
# ═══════════════════════════════════════════════════════════════════════════

func _build_ui() -> void:
	var backdrop := ColorRect.new()
	backdrop.position = Vector2.ZERO
	backdrop.size = Vector2(900, 520)
	backdrop.color = Color(0.12, 0.13, 0.16)
	add_child(backdrop)

	status_label = _label(Vector2(20, 16), 15)
	price_label = _label(Vector2(20, 44), 20)
	hostility_label = _label(Vector2(20, 76), 15)

	# Two CE-backed objects: a bridge and a market.
	bridge_rect = ColorRect.new()
	bridge_rect.position = Vector2(120, 200)
	bridge_rect.size = Vector2(180, 40)
	bridge_rect.color = Color(0.55, 0.40, 0.25)
	add_child(bridge_rect)

	var bridge_caption := _label(Vector2(120, 248), 13)
	bridge_caption.text = "grain_road (CE-backed)"

	market_rect = ColorRect.new()
	market_rect.position = Vector2(420, 180)
	market_rect.size = Vector2(90, 90)
	market_rect.color = Color(0.80, 0.55, 0.25)
	add_child(market_rect)

	var market_caption := _label(Vector2(420, 278), 13)
	market_caption.text = "market (colour tracks CE price)"

	explain_label = RichTextLabel.new()
	explain_label.position = Vector2(20, 320)
	explain_label.size = Vector2(560, 170)
	explain_label.bbcode_enabled = true
	explain_label.visible = false
	add_child(explain_label)

	act_button = _button(Vector2(660, 180), "Destroy bridge", _on_destroy_bridge)
	advance_button = _button(Vector2(660, 236), "Advance 5 ticks", _on_advance)
	explain_button = _button(Vector2(660, 292), "Why this price?", _on_explain)

	hint_label = _label(Vector2(20, 494), 13)
	hint_label.text = "CE owns causality. This scene only renders what CE reports."


func _label(pos: Vector2, size: int) -> Label:
	var label := Label.new()
	label.position = pos
	label.add_theme_font_size_override("font_size", size)
	add_child(label)
	return label


func _button(pos: Vector2, text: String, handler: Callable) -> Button:
	var button := Button.new()
	button.position = pos
	button.size = Vector2(200, 44)
	button.text = text
	button.pressed.connect(handler)
	add_child(button)
	return button
