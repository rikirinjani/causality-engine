# CE Causal World Demo

Isometric medieval town driven by the Causality Engine (CE).
CE is the **sole causal authority**. Godot renders; the adapter translates.

## Architecture

```
PLAYER INPUT (keyboard/button)
       |
   Godot iso_main.gd          (rendering, camera, UI, input)
       |
   ce_ws_adapter.gd           (intent -> CE intervention, CE state -> projection)
       |
   WebSocket (ws://127.0.0.1:7778)
       |
   ce-ws-server.ts            (CE push server, multi-timeline registry)
       |
   Causality Engine            (world state, causal propagation, RNG, explain)
```

**Boundary invariant**: Zero causal rules and zero RNG in Godot or the adapter.
CE decides everything. Godot only renders.

## The 12-Step Loop

| Step | What happens | Who decides |
|------|-------------|-------------|
| 1. Observe | Player sees town, bridge, grain price, merchants | CE state -> Godot projection |
| 2. Intervention | Player presses [B] to destroy bridge | Godot input -> adapter |
| 3. CE accepts | Adapter sends intervention over WS | CE validates |
| 4. CE propagates | Causal consequences computed | CE engine |
| 5. Godot renders | Bridge disappears, price rises, merchants hide | CE state -> projection |
| 6. Checkpoint | Player presses [C] | CE creates checkpoint |
| 7. Rewind | Player presses [R] | CE rewinds to checkpoint |
| 8. Fork | Player presses [F] to fork Timeline B | CE creates new timeline |
| 9. Alternate | Player grants subsidy instead of destroying | Different intervention on B |
| 10. Distinct | Both timelines have different stateHash/traceHash | CE lineage |
| 11. Compare | Player presses [V] to compare A vs B | CE compare API |
| 12. Explain | Player presses [E] to ask "why expensive?" | CE explain/attribution |

## Running

### Prerequisites
- CE WebSocket server running on port 7778
- Godot 4.7+ installed
- macOS (tested on arm64)

### Start the CE server
```bash
cd ~/Project_v2/causality-engine
npx tsx src/poc/ce-ws-server.ts
```

### Run the demo (GUI on physical display)
```bash
godot --path ~/Project_v2/godot-ce-demo
```

### Run headless verification (all 12 steps)
```bash
godot --headless --path ~/Project_v2/godot-ce-demo res://iso_verify.tscn
```

## Files

| File | Purpose |
|------|---------|
| `iso_main.gd` | Main scene: rendering, UI, 12-step auto-demo |
| `iso_main.tscn` | Scene definition |
| `ce_ws_adapter.gd` | WebSocket adapter: CE <-> Godot |
| `iso_verify.gd` | Headless 12-step verification driver |
| `iso_verify.tscn` | Verify scene definition |
| `project.godot` | Godot project config |

### Legacy files (kept for reference)
| File | Purpose |
|------|---------|
| `ce_adapter.gd` | HTTP adapter (P-014, superseded by WS) |
| `main.gd` / `main.tscn` | Original HTTP demo scene |
| `headless_*.gd/tscn` | Early headless tests |
| `ws_main.gd/tscn` | Intermediate WS test scene |

## Boundary Audit

**Godot does**: rendering, animation, camera, UI, input, visual projection
**Adapter does**: intent -> CE intervention, CE state -> game projection, event consumption
**CE does**: world state, economy, factions, causal propagation, RNG, temporal state, branching, rewind, explain

**Searchable invariant**: no `randi`, `randf`, `randomize`, or causal rules in any `.gd` file.
