# P-023: Godot Distribution Package — Results

**Date:** 2026-09-02
**Status:** Complete. All six predictions confirmed.
**Frozen invariants:** 12/12 unchanged.

Predictions were written before implementation in
[P-023-PREDICTIONS.md](./P-023-PREDICTIONS.md).

---

## Prediction outcomes

| # | Prediction | Outcome | Evidence |
|---|-----------|---------|----------|
| P1 | Clean project installs the addon by copying one directory | **CONFIRMED** | `~/ce-clean-project` created outside the CE repo; addon copied; Godot loaded it with no errors |
| P2 | No internal-source dependency | **CONFIRMED** | Grep for `src/`, `.ts`, `core/`, `api/` across the addon returns nothing |
| P3 | Vertical slice reproducible from the addon | **CONFIRMED** | 23/23 clean-project assertions; grain 10.00 → 13.13, hash `5404d32e`, distinct timelines `T-28c9d0a2` / `T-beed9db7` — identical to the P-022 baseline |
| P4 | Zero causal authority in Godot | **CONFIRMED** | Zero RNG in executable code; `causalDomains` always `[]` |
| P5 | Survives removal of the dev repository | **CONFIRMED** | Clean project lives outside the CE tree; no path escapes the project; only external dependency is the documented WS endpoint |
| P6 | No research or probe artifacts | **CONFIRMED** | Addon is 6 files, all integration material |

None falsified.

---

## Distribution mechanism

**Chosen: installable Godot addon (`res://addons/causality_engine/`), distributed with the CE repository and included in the npm `files` allowlist.**

Rejected alternatives:

| Option | Why not |
|--------|---------|
| Asset Library submission | Requires a public repo, a stable release tag, and review latency. Adds nothing to the immediate goal of *can a third party install this*. Deferred, not blocked — the addon layout is already Asset-Library-shaped. |
| Release archive only | Godot developers expect `addons/`. An archive adds a manual unpack step for no benefit. |
| Separate repository | Splits the addon from the runtime it speaks to, so protocol changes desynchronise. Not worth it for one client. |
| npm-only | Godot developers do not consume npm packages into `res://`. |

The addon directory *is* the package. Copying it is the install.

---

## Package boundary

```
causality-engine/
├── src/                          CE engine source        NOT distributed to Godot devs
├── godot/
│   ├── addons/causality_engine/  THE PACKAGE             ← what a developer installs
│   └── sample/                   onboarding sample       reference, optional
├── godot-iso/                    medieval vertical slice research evidence, not the package
├── docs/                         product + research docs mixed by audience
└── examples/                     TS in-process example   TS developers only
```

### Package contents (6 files)

| File | Lines | Role |
|------|-------|------|
| `plugin.cfg` | 7 | Godot plugin manifest |
| `plugin.gd` | 20 | Registers `CeClient` as a custom node type |
| `ce_client.gd` | 604 | Transport client, projection, full CE API |
| `quantity.gd` | 95 | Quantity-key helpers for `explain()` |
| `icon.svg` | 10 | Node icon |
| `README.md` | 269 | Self-contained addon documentation |

### Deliberately excluded

`iso_main.gd`, `iso_verify.gd` (demo/verification drivers), `shots/` (14 evidence
PNGs), `ws_cp_probe.gd`, `probe-ws-checkpoint.ts`, `headless_*` scenes, all
research documents, the CE engine source.

---

## Inventory of the pre-existing integration

| File | Classification | Disposition |
|------|---------------|-------------|
| `ce_ws_adapter.gd` | integration, demo-coupled | **rewritten** as `ce_client.gd` |
| `iso_main.gd` | demo | stays in `godot-iso/` |
| `iso_verify.gd` | verification driver | stays in `godot-iso/` |
| `iso_main.tscn`, `iso_verify.tscn` | demo scenes | stay |
| `project.godot` | demo project | stays |
| `shots/*.png` (14) | evidence | stay, excluded from package |
| `icon.svg` | asset | new one authored for the addon |
| `README.md` | demo docs | stays; addon has its own |

The old adapter was not a plugin. It had no `plugin.cfg`, hard-coded `WS_URL`, no
configuration surface, no reconnection, no `class_name`, and its API used
demo-shaped names (`ce_tick`, `ce_state_hash`, `get_snapshot`). Reusing it as the
package would have shipped demo assumptions to third parties.

---

## Implementation changes

### New — the package

`godot/addons/causality_engine/` (6 files, 1,005 lines).

`ce_client.gd` improvements over the demo adapter:

- `class_name CeClient` — usable as a type
- `@export` configuration: `host`, `port`, `use_tls`, `auto_poll`,
  `auto_reconnect`, `reconnect_delay_seconds`, `socket_buffer_bytes`, `verbose`,
  `event_history_limit`
- `endpoint()` derives the URL; nothing hard-coded
- automatic reconnection with configurable backoff
- 15 signals covering every CE reply, including `gap_received`,
  `connection_failed`, `intervention_result`
- convenience readers: `region()`, `grain_price()`, `is_structure_intact()`,
  `hostility()`
- `auto_poll = false` for drivers owning their own cadence
- full CE surface: create, snapshot, state-sync, advance, ping, submit,
  submit-batch, ack, resync, checkpoint, restore, fork, rewind, switch-timeline,
  list-timelines, timeline-info, compare-timelines, explain

`quantity.gd` provides 15 typed key builders mirroring CE's own helpers, so a
typo cannot silently turn a real explanation into "not explained".

### New — sample

`godot/sample/minimal_sample.{gd,tscn}` — 6-step loop, two CE-backed objects, no
game content. Deliberately smaller than the medieval demo.

`godot/sample/verify_integration.{gd,tscn}` — headless driver, 23 assertions
across 12 stages, using only the addon's public API.

`godot/project.godot` — clean project pointing at the sample.

### Fixed — absolute paths

`godot-iso/iso_main.gd` and `godot-iso/iso_verify.gd` contained three hard-coded
`/Users/ptpakdefarma/Project_v2/...` paths. Replaced with
`res://shots` + `ProjectSettings.globalize_path()`.

### Docs

`INSTALLATION.md` (166), `RUNTIME-REQUIREMENTS.md` (163),
`GODOT-INTEGRATION.md` (335).

### Version

`0.2.0` → `1.0.0-rc.1`. Rationale in the versioning section below.

---

## Clean-project integration results

Project created at `~/ce-clean-project`, **outside** the CE repository tree.
Contains only the addon, the sample, and `project.godot`.

```
=== CE clean-project integration verification ===
endpoint: ws://127.0.0.1:7778
PASS: Stage 1: connected to CE runtime
PASS: Stage 1: CE assigned consumer id ws-7
PASS: Stage 2: snapshot projected region RF
PASS: Stage 2: initial grain price 10.00
PASS: Stage 2: bridge intact initially
PASS: Stage 2: CE reported a state hash
PASS: Stage 3: checkpoint captured (C-c7d8f313)
PASS: Stage 4: CE accepted the intervention
PASS: Stage 5: advanced to tick 5
PASS: Stage 6: received 9 CE events
PASS: Stage 7: grain price rose 10.00 -> 13.13
PASS: Stage 7: faction hostility projected
PASS: Stage 8: CE explained the price
PASS: Stage 8: explanation rooted in destroy_infrastructure
PASS: Stage 9: rewound tick 5 -> 0
PASS: Stage 9: bridge intact again after rewind
PASS: Stage 10: forked timeline B (T-beed9db7)
PASS: Stage 10: B is distinct from A (T-28c9d0a2)
PASS: Stage 11: bridge intact on branch B
PASS: Stage 12: comparison received
PASS: Stage 12: worlds differ
PASS: Stage 12: histories differ
PASS: Boundary: all observed values originated in CE

=== RESULTS: 23 passed, 0 failed ===
```

Values match the P-022 baseline exactly.

---

## Vertical slice results

`godot-iso/` after the absolute-path fix:

```
=== CE 12-STEP RESULTS: 19 passed, 0 failed ===
```

Grain 10.00 → 13.13, hash A `5404d32e` / B `48fee55b`, checkpoint `C-c7d8f313`,
timeline B `T-beed9db7`, render 145.4 FPS. Semantics unchanged.

---

## Install / remove / reinstall

| Step | Result |
|------|--------|
| Install (copy addon) | Loads, 23/23 pass |
| Remove (`rm -rf addons/causality_engine`) | Fails cleanly: `Preload file "res://addons/causality_engine/quantity.gd" does not exist` — no crash, no partial state |
| Reinstall (copy again) | 6 files restored, 23/23 pass |

No stray files, no cached state, no registry entries. The addon directory is the
entire install footprint.

---

## Runtime / dependency contract

### Required by the Godot addon

- Godot 4.3+ (verified 4.7.2, macOS arm64)
- A reachable CE runtime on a WebSocket endpoint
- Nothing else. No Node on the Godot side, no CE source, no absolute paths.

### Required by the CE runtime

- **Node.js 20+** — a real dependency, stated plainly
- npm 9+
- `ws` (standalone mode only; in-process mode has zero runtime dependencies)

### Required only by the sample / demo / tests

- CE repository clone
- `tsx`, `vitest`

None of this ships with a game.

### Security

The CE WS runtime has **no authentication** and binds `127.0.0.1` by default.
Documented explicitly in `RUNTIME-REQUIREMENTS.md`: exposing it beyond localhost
without adding auth lets anything that reaches the port create worlds, submit
interventions, and read state.

---

## Package hygiene audit

| Check | Result |
|-------|--------|
| Probe scripts | None |
| Temporary files | None |
| Test artifacts | None |
| Credentials | None |
| Absolute paths | None (verified by grep) |
| Machine-specific config | None; all settings are `@export` with neutral defaults |
| Screenshots | None in the package |
| Development-only scripts | None |
| Unnecessary dependencies | None; addon has zero dependencies |
| Internal research docs | None |
| CE source references | None |

---

## Frozen-invariant audit

| # | Invariant | Status | Evidence |
|---|-----------|--------|----------|
| 1 | CE is sole causal authority | Unchanged | Addon computes no consequence |
| 2 | No causal rules outside CE | Unchanged | `causalDomains` always `[]` |
| 3 | No RNG outside CE | Unchanged | Zero RNG in executable code |
| 4 | Deterministic replay | Unchanged | `5404d32e` matches P-014 |
| 5 | Temporal decoupling | Unchanged | No timers driving CE; `advance()` is caller-driven |
| 6 | WS is transport, not causal channel | Unchanged | `ce-ws-server.ts` untouched |
| 7 | Godot = rendering only | Unchanged | Addon projects, never decides |
| 8 | Adapter = translation only | Unchanged | No world mutation |
| 9 | explain() uses CE attribution | Unchanged | `request_explain` is a pass-through |
| 10 | Branching preserves lineage | Unchanged | `distinct=true`, both hashes differ |
| 11 | Checkpoint/rewind are CE operations | Unchanged | Client only requests them |
| 12 | State hash is deterministic | Unchanged | Two runs identical |

---

## Verification results

| Check | Result |
|-------|--------|
| CE test suite | **746/746** (20 files) |
| tsc | **90 lines** — unchanged baseline |
| Deterministic replay | `5404d32e` matches P-014 |
| Invariant check | All pass |
| Clean-project integration | **23/23** |
| Medieval vertical slice | **19/19** |
| Install/remove/reinstall | Pass |
| Package hygiene | Pass |
| Boundary audit | Pass |

No test was weakened.

---

## Defects found and fixed

**1. Absolute developer paths in the medieval demo (real, fixed).**
Three hard-coded `/Users/ptpakdefarma/Project_v2/...` paths in `iso_main.gd` and
`iso_verify.gd`. Would have broken on any other machine. Replaced with
`res://shots` + `ProjectSettings.globalize_path()`.

**2. `is_connected` name collision (real, fixed).**
Godot 4 reserves `is_connected` on `Object`. Declaring `var is_connected: bool`
caused a parse error at load. Renamed to `connection_open`. Caught by the
clean-project test — the medieval demo never declared such a variable, so this
was only discoverable by building a genuinely new client.

**3. Fork/list-timelines race in the verification driver (test defect, fixed).**
The driver assumed one pump after `fork()` was enough. The fork reply triggers a
follow-up `list-timelines` round trip, so `timeline_b` was still empty. Changed to
poll until the registry names the branch. Addon behaviour was correct.

**No CE semantic defect was found.** Nothing required touching frozen
architecture.

---

## Versioning: 1.0.0-rc.1

Moved from `0.2.0` to `1.0.0-rc.1` — a release candidate, not `1.0.0`.

### What is satisfied

| Criterion | Status |
|-----------|--------|
| Stable product API | Yes — 8 groups, documented, 61 tests |
| Documented integration boundary | Yes — three-layer table in four documents |
| Deterministic behaviour | Yes — replay verified, cross-platform |
| Supported installation path | Yes — copy the addon directory |
| Documented runtime requirements | Yes — separated by audience |
| Reproducible sample | Yes — 23/23 from a clean project |
| No internal-source dependency | Yes — verified by grep and by a clean project outside the repo |

### Why not `1.0.0`

Three things a `1.0.0` should have that this does not:

1. **No published artifact.** Not on npm, not in the Asset Library. "Install" is
   still "clone and copy".
2. **No external validation.** Every test was written by the same party that
   wrote the code. No third-party developer has attempted the install.
3. **Godot version coverage is narrow.** Verified on 4.7.2 only. The addon claims
   4.3+ by API inspection, not by testing.

`1.0.0` should be cut after a publish target is chosen and at least one external
developer completes the install.

---

## Remaining blockers to `1.0.0`

| Blocker | Severity | Note |
|---------|----------|------|
| No published artifact | High | Pick npm and/or Asset Library, publish |
| No external validation | High | One outside developer completing INSTALLATION.md |
| Single Godot version tested | Medium | Verify 4.3 and 4.4 |
| WS runtime unauthenticated | Medium | Documented; fine for localhost, blocks networked use |
| No CI | Medium | Nothing prevents a regression between passes |
| Deployment guide missing | Low | How to ship Node alongside a Godot game |
| Troubleshooting is scattered | Low | Present in three documents; no single page |

---

## Recommended P-024

**Publish and externally validate the 1.0 candidate.**

1. Choose the publish target — npm for the runtime, Asset Library or a GitHub
   release tag for the addon.
2. Run `npm publish --dry-run`; confirm the `files` allowlist produces a sane
   tarball.
3. Verify the addon on Godot 4.3 and 4.4.
4. Add CI running the 746-test suite, replay, invariant check, and both Godot
   headless verifications.
5. Write `DEPLOYMENT.md`: shipping the Node runtime with a Godot game.
6. Have one developer outside this project follow `INSTALLATION.md` unaided and
   record every point of confusion.
7. Cut `1.0.0` only after (6) passes.

Explicitly **not** P-024: new causal semantics, new gameplay, multiplayer, cloud,
performance work, or reopening the freeze.

---

## Central question

> Can a game developer who has never seen the CE repository install the CE
> integration, connect it to a CE runtime, and build a small playable game
> without needing to understand CE's internal architecture?

**Yes — with one honest caveat.**

Confirmed: a clean Godot project outside the CE tree installs the addon by
copying one directory, connects, and drives the complete causal loop — intervene,
advance, consume events, inspect state, explain, checkpoint, rewind, fork,
compare — with 23/23 assertions passing and no reference to CE source.

The caveat: "install" currently means "clone the repo and copy a directory",
because nothing is published. That is a distribution-channel gap, not a
capability gap.

**CE has crossed from integration-ready to distribution-ready. It is not yet
distributed.**
