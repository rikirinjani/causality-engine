@tool
## Causality Engine — Godot editor plugin.
##
## The addon works without being enabled: CeClient is a plain Node script you can
## instantiate directly. Enabling the plugin only registers the custom node type
## so CeClient appears in the Add Node dialog.
extends EditorPlugin

const CLIENT_SCRIPT := "res://addons/causality_engine/ce_client.gd"
const CLIENT_ICON := "res://addons/causality_engine/icon.svg"


func _enter_tree() -> void:
	var script: Script = load(CLIENT_SCRIPT)
	var icon: Texture2D = load(CLIENT_ICON) if ResourceLoader.exists(CLIENT_ICON) else null
	add_custom_type("CeClient", "Node", script, icon)


func _exit_tree() -> void:
	remove_custom_type("CeClient")
