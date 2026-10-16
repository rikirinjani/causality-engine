#!/usr/bin/env python3
"""Patch ce_ws_adapter.gd to auto-fetch timelines after fork/rewind/switch."""
import re

path = "/Users/ptpakdefarma/Project_v2/godot-ce-demo/ce_ws_adapter.gd"
with open(path, "r") as f:
    content = f.read()

# After "forked" handler, add list_timelines() call
old_forked = '''        "forked":
            current_timeline_id = msg.get("timelineId", "") as String
            ce_tick = msg.get("tick", ce_tick) as int
            ce_state_hash = msg.get("stateHash", ce_state_hash) as String
            ce_state_updated.emit()'''

new_forked = '''        "forked":
            current_timeline_id = msg.get("timelineId", "") as String
            ce_tick = msg.get("tick", ce_tick) as int
            ce_state_hash = msg.get("stateHash", ce_state_hash) as String
            list_timelines()
            ce_state_updated.emit()'''

# After "rewound" handler, add list_timelines() call
old_rewound = '''        "rewound":
            current_timeline_id = msg.get("timelineId", "") as String
            ce_tick = msg.get("tick", ce_tick) as int
            ce_state_hash = msg.get("stateHash", ce_state_hash) as String
            ce_state_updated.emit()'''

new_rewound = '''        "rewound":
            current_timeline_id = msg.get("timelineId", "") as String
            ce_tick = msg.get("tick", ce_tick) as int
            ce_state_hash = msg.get("stateHash", ce_state_hash) as String
            list_timelines()
            ce_state_updated.emit()'''

# After "switched" handler, add list_timelines() call
old_switched = '''        "switched":
            current_timeline_id = msg.get("timelineId", "") as String
            ce_tick = msg.get("tick", ce_tick) as int
            ce_state_hash = msg.get("stateHash", ce_state_hash) as String
            ce_state_updated.emit()'''

new_switched = '''        "switched":
            current_timeline_id = msg.get("timelineId", "") as String
            ce_tick = msg.get("tick", ce_tick) as int
            ce_state_hash = msg.get("stateHash", ce_state_hash) as String
            list_timelines()
            ce_state_updated.emit()'''

content = content.replace(old_forked, new_forked)
content = content.replace(old_rewound, new_rewound)
content = content.replace(old_switched, new_switched)

with open(path, "w") as f:
    f.write(content)

print("Patched ce_ws_adapter.gd: added list_timelines() after fork/rewind/switch")
