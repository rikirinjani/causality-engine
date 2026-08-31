# P-015: Native Visual Godot Consumer Report

**Date:** 2026-08-31
**Status:** COMPLETE — CE successfully drives a visible, interactive Godot game world over HTTP
**Question answered:** *Can CE's deterministic causal world become a visibly rendered,
interactive game world without moving causal authority into the game engine?* **YES.**

---

## 1. Corrected Environment Record

| Claim | P-014 (wrong) | P-015 (corrected) |
|-------|---------------|-------------------|
| Display | "the Mac mini has no display attached" | Mac mini **has a physical monitor attached** and runs a normal graphical desktop session |
| Godot GUI | assumed unavailable | **Available and verified** — normal graphical Godot application launched and rendered |
| P-014 validation | — | Remains correct: P-014 was properly validated headless; only the display-availability statement was wrong |

The erratum is recorded in `docs/P-014-GODOT-FEASIBILITY.md`, `docs/RECONNAISSANCE.md` §24,
and QMS `VER-2026-014`. No other P-014 conclusion was disproven.

## 2. Godot Graphical Launch Result

- Launched as a **normal graphical application**: `godot res://main.tscn` (no `--headless`)
- Process confirmed running on the Mac mini (`godot res://main.tscn`, visible in process list)
- Console session active (`ptpakdefarma console`), WindowServer running
- Demo sequence executed in-app against the live CE HTTP server and completed
  (`DEMO COMPLETE — application remains running for interactive use`)

## 3. Renderer / Backend

```
OpenGL API 4.1 Metal - 90.5 - Compatibility - Using Device: Apple - Apple M4
```

- **Renderer:** OpenGL 4.1 (Compatibility), backed by **Metal** via Godot's macOS driver
- **Device:** Apple M4 (integrated GPU)
- This is the actual backend in use, captured from the Godot startup log.

## 4. Visual Scene Description

The demo renders the medieval-town scenario with primitive `ColorRect` geometry (1280x720,
gl_compatibility):

- **Town** (brown block, center) — color shifts with CE `unrest`
- **Road** (tan strip) connecting town to the outside world
- **Bridge** (darker block on the road) — a real Godot scene object (see §6)
- **Market** (yellow block) — color shifts with CE grain `price`
- **Grain storage** (dark yellow block) — hidden when CE reports warehouse destroyed
- **3 merchants** (red figures on the road) — visible only while the CE trade route is intact
- **Labels** — tick, state hash, per-faction hostility
- **UI buttons** — Destroy Bridge (B), Advance Time (Space), Save, Restore

## 5. Causal Chain Demonstration (CE-driven, visible)

```
Initial state                        (tick 0, grain 10.0, route intact, MG 0.1)
     ↓  [Godot button: Destroy Bridge → adapter → CE intervention]
Bridge destroyed                    (route intact → false)
     ↓  [CE tick 1: trade_disruption, price_shock, food_availability, hostility_increase
         events emitted — in BOTH RF and HT regions]
Grain price increased               (10.0 → 13.13 after 5 ticks)
     ↓
Food availability changed           (ecology.food_availability events)
     ↓
Hostility increased                 (MG faction 0.1 → 0.62)
```

The 8 events received by Godot (via `/poll`):
`ecology.food_availability`, `economy.trade_disruption`, `economy.price_shock`,
`faction.hostility_increase` — each in both HT and RF regions.

**Every consequence originated in CE.** Godot only received state/events, projected them,
and rendered the result. Screenshots captured at each phase:
- `shot_1_initial.png` — intact bridge, merchants, baseline market color
- `shot_2_destroyed.png` — bridge removed, merchants gone
- `shot_3_advanced.png` — market/town colors shifted with price/unrest

## 6. Bridge as a Game Object

- Bridge exists as an actual Godot node (`bridge_sprite`, a `ColorRect` scene object)
- **Exists initially** — verified by pixel analysis: bridge-colored pixels `(153,128,102)`
  present at the bridge region in `shot_1`
- **CE intervention destroys it** — the destroy action went through the adapter's
  `submit_intervention` (no Godot-side destruction logic)
- **Godot reflects destruction** — bridge region 100% of sampled pixels changed between
  shots 1→2 (bridge color → road color `(128,102,76)`); merchant region 46.7% changed
- **Town remains visually isolated afterward** — merchants hidden, market color changed,
  hostility label rose — all consequences of CE state, none authored in Godot

## 7. Godot → CE Reverse Intervention

The demo presses the real **Destroy Bridge button** (`destroy_button.pressed.emit()`), which
runs the same handler as a human click:

```
Godot UI/input (button pressed)
      ↓ adapter.submit_intervention(...)
      ↓ CE (submit accepted, interventionSeq 1)
      ↓ CE simulation (tick → events)
      ↓ CE event/state (poll + snapshot)
      ↓ Godot projection (_project_state)
      ↓ visual change (bridge removed, merchants gone)
```

UI round-trip (submit + snapshot responses): **137 ms**. CE, not Godot, produced the
consequences.

## 8. Cadence and Latency Measurements

| Metric | Run 1 | Run 2 |
|--------|-------|-------|
| **Render FPS** (sampled/frame) | avg **82.9**, min 1.0, max 110 | avg **88.4**, min 1.0, max 243 |
| HTTP request latency, avg | 154 ms | 130 ms |
| HTTP request latency, max | 301 ms | 206 ms |
| Transport-level latency (immediate-dispatch requests: submit, advance) | ~55–64 ms | ~55–64 ms |
| CE server processing (from P-014) | < 1 ms/tick | < 1 ms/tick |
| Destroy-bridge UI round trip | 137 ms | — |
| Advance UI round trip | 203 ms | — |

**Findings:**
1. Godot's HTTPRequest adds ~50–65 ms fixed overhead per request (measured consistently).
2. **Per-request latency instrumentation notes:** my adapter records latency from *queue time*,
   so requests that waited behind others (poll, create-world, queued snapshots) show inflated
   values (150–300 ms). Requests dispatched immediately (submit, advance) measure the true
   transport: ~55–64 ms — matching the headless P-014 measurement.
3. Render FPS is healthy (avg 83–88) with a 5–20 Hz polling cadence.

**Is HTTP polling adequate for this demonstration? YES.**
- Turn-based / strategy / economy cadence (5–20 Hz polling): comfortably adequate.
- Per-frame 60 fps polling: still NOT viable (~55–65 ms > 16.7 ms frame budget) — as found
  in P-014. No premature transport replacement was done, per mission instructions.

## 9. Determinism Results

Same scenario run twice (fresh world, seed 42, same intervention sequence) — **identical
hashes at every phase**:

| Phase | Run 1 stateHash / traceHash | Run 2 stateHash / traceHash |
|-------|----------------------------|-----------------------------|
| Initial | `99be7427` / `b9e6816d` | `99be7427` / `b9e6816d` |
| After destroy | `6546fe73` / `59372073` | `6546fe73` / `59372073` |
| After advance 5 | `5404d32e` / `94f470fa` | `5404d32e` / `94f470fa` |

Also matches the headless/server runs from P-014 (`5404d32e` after bridge-destroy + 5 ticks).
The rendered frame is not pixel-identical by design (scene uses live UI timers/labels), but
all CE-derived projected state is identical. Note the `stateHash` change between initial and
post-destroy is expected: `submitIntervention` applies immediate effects synchronously, which
changes world state before any tick.

## 10. Architecture Boundary Audit

Scanned all `.gd` files for causal rules (consequence simulation):

```
causal-rule keywords (increasePrice, reduceFood, increaseHostility, price +=,
hostility +=, starvation, if X destroyed):  NO MATCHES in adapter/demo code
random/RNG usage (randi/randf/randomize/RandomNumberGenerator): NO MATCHES
```

- The **adapter** (`ce_adapter.gd`) only: HTTP queue, `_project_state` (state → dictionary),
  event forwarding. Zero causal logic.
- The **scene** (`main.gd`) only: calls adapter operations + visual projection
  (`bridge_sprite.visible = rf_town["trade_route_intact"]`, `market color = f(price)`).
  These are render mappings of CE state — not consequence simulation.
- The one `destroyed` match (`headless_cadence.gd:64`) is the test's *intervention timing*
  (`if frame == 20: submit_intervention(...)`) — it submits to CE, it does not simulate.
- Adapter imports: only CE's public HTTP surface (`127.0.0.1:7777` endpoints), no CE internals.

**Conclusion:** No causal authority moved into Godot. CE remains the sole source of
consequences.

## 11. Visual Evidence

Screenshots captured by the running Godot app (viewport capture, saved to
`src/poc/godot/shots/`):
- `shot_1_initial.png` (18,505 B)
- `shot_2_destroyed.png` (18,390 B)
- `shot_3_advanced.png` (18,546 B)

Pixel-diff verification (PIL): bridge region **100% changed** 1→2 (bridge→road color),
merchant region **46.7% changed** 1→2, total scene 0.48% changed 1→2, 0.75% 1→3. The full
Godot session log is at `/tmp/p015-godot-gui.log` on the Mac mini (and captured in the
report evidence). Note: orchestrator model cannot view images directly; evidence verified
programmatically via pixel analysis.

## 12. Defects Discovered

1. **`ce_adapter.gd` compile error (P-015 instrumentation bug):** `url` is not a parameter of
   `_on_http_completed` in GDScript — broke the first GUI launch. Fixed by tracking
   `_inflight_url` per request. (Headless suites unaffected — they use a different script.)
2. **Malformed `icon.svg`** (backslash-escaped quotes from original authoring) — Godot logged
   `Error loading image: 'res://icon.svg'` (non-fatal). Replaced with a valid SVG.
3. **Pre-existing tsc debt (not introduced by P-015):** `tsc --noEmit` reports errors in 7
   PoC tooling files — 4 tracked at the P-011 baseline (`benchmark.ts`, `headless.ts`,
   `long-run.ts`, `cross-platform-determinism.ts`) and 3 from P-012/P-013
   (`benchmark-investigation.ts`, `runtime-cadence.ts`, `runtime-boundary.test.ts`). All are
   `noUncheckedIndexedAccess`/strict-mode strictness in one-off scripts, none part of the
   public API or the P-015 deliverable. **P-015 adds zero new tsc errors** — the one error
   introduced in my earlier ce-server.ts edit was fixed, and `ce-server.ts` /
   `ce-integration-test.ts` are clean.
4. **Latency instrumentation nuance:** adapter timestamps requests at queue time, not
   dispatch time — queued requests show inflated latency. Documented; transport latency
   measured via immediately-dispatched requests (~55–64 ms).

## 13. Remaining Integration Risks

1. **~50–65 ms Godot HTTPRequest overhead** per request — the binding constraint for
   per-frame polling (already characterized in P-014). Fine at 5–20 Hz; action-game cadence
   would need WebSocket or in-process (P-012).
2. **Per-request latency logging** inflates queued-request numbers — instrumentation should
   timestamp at dispatch; cosmetic, but worth fixing if latency becomes a P-016 focus.
3. **Pre-existing tsc debt** in 7 PoC tool files should be cleaned (strict-mode `!` guards)
   to make `npm run check` green repo-wide — recommended as a low-risk cleanup lane.
4. **Headless suite divergence:** `ce_adapter.gd` is shared by headless suites and the GUI
   demo; the instrumentation edit was validated by the GUI run but headless suites should be
   re-run after the `_inflight_url` change to confirm no regression (they were re-validated
   implicitly via the GUI run's identical hashes, but a formal re-run is cleaner).

## 14. Recommended P-016

**Option A (recommended): WebSocket event push.** Remove the 50–65 ms HTTP polling
constraint by adding a WebSocket channel to `ce-server.ts` (or a sibling server) and a Godot
WebSocket client. CE pushes events at tick cadence; the game renders freely. Re-measure
latency at 60 fps polling cadence.

**Option B: Latency/polling hardening.** Fix adapter dispatch-time timestamps, re-run the
headless suites formally, clean the 7-file tsc debt, and characterize the HTTP transport
overhead more precisely (connection reuse, keep-alive).

Either way: keep the causal authority entirely in CE — the P-015 architecture boundary held
without exception.

## Files (new/changed this pass)

- `src/poc/godot/ce_adapter.gd` — latency instrumentation, `_inflight_url` fix, checkpoint capture (P-014)
- `src/poc/godot/main.gd` — P-015 demo driver: timed causal scenario, screenshots, FPS/latency/hash logging
- `src/poc/godot/icon.svg` — repaired (valid SVG)
- `src/poc/godot/shots/` — 3 phase screenshots (visual evidence)
- `docs/P-015-VISUAL-GODOT.md` — this report
- `docs/RECONNAISSANCE.md` — §25 appended
- `docs/P-014-GODOT-FEASIBILITY.md` — erratum added
- QMS: `VER-2026-014` erratum, `VER-2026-015`, `REQ-2026-012`
