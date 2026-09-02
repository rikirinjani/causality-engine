# P-023: Godot Distribution Package — Falsifiable Predictions

**Written BEFORE implementation.** Date: 2026-09-02

These are the predictions this pass must confirm or falsify. Each states an
observable outcome and the specific evidence that would refute it.

---

## P1 — Clean-project installation

**Prediction:** A Godot project created from scratch, containing no CE files, can
install the CE Godot integration by copying a single self-contained addon
directory into `res://addons/`, and Godot will load it without errors.

**Test:** Create a fresh `project.godot` in a directory that has never contained
CE material. Copy only the addon directory. Run Godot headless against a scene
that instantiates the addon's client.

**Falsified if:** Godot reports missing scripts, missing resources, parse errors,
or the addon requires files from outside its own directory.

---

## P2 — No internal source dependency

**Prediction:** The installed integration communicates with CE exclusively through
the existing WebSocket transport contract. It requires no access to `src/core`,
`src/game`, `src/api`, or any TypeScript file.

**Test:** Grep the entire distributed addon for references to `src/`, `.ts`,
`core/`, `api/`, or relative paths escaping the addon directory.

**Falsified if:** any addon file references CE source paths, or the clean-project
test fails when the CE repository is not reachable on the filesystem.

---

## P3 — Vertical slice reproducible from the distributed addon

**Prediction:** The existing 12-step vertical slice (observe → intervene → CE
accepts → propagate → render → checkpoint → rewind → fork → alternate
intervention → distinct timelines → compare → explain) can be reproduced by a
scene that uses only the distributed addon's public GDScript API.

**Test:** Run a headless verification scene that drives all 12 steps through the
addon client and asserts each one.

**Falsified if:** any step cannot be expressed through the addon's public API, or
the observed values (grain 10.00 → 13.13, hash `5404d32e`, distinct timeline ids)
differ from the P-022 baseline.

---

## P4 — Zero causal authority in Godot

**Prediction:** The distributed addon contains no causal rule, no RNG, no
world-state mutation, and no intervention-acceptance logic. Every causal decision
is CE's.

**Test:** Static audit of every `.gd` file in the addon for `randi`, `randf`,
`randomize`, `rand_range`, `RandomNumberGenerator`, and for any assignment that
would author `causalDomains` pressure or valence.

**Falsified if:** any of those patterns appear, or the addon computes a
consequence rather than projecting one CE reported.

---

## P5 — Survives removal of the development repository

**Prediction:** After installation, the addon functions with the CE development
repository absent from the filesystem, provided a CE runtime is reachable at the
configured network endpoint. The Node/CE-runtime requirement is an explicitly
documented external dependency, not a hidden one.

**Test:** Install the addon into a clean project outside the CE repo tree. Point
it at a CE WS endpoint. Confirm the full loop runs. Confirm no addon file resolves
a path into the CE repository.

**Falsified if:** the addon reads any file outside its own directory, or contains
an absolute path such as `/Users/ptpakdefarma`, `~/Project_v2`, or `C:\Users`.

---

## P6 — No research or probe artifacts in the package

**Prediction:** The distributed addon contains only integration material. No
probe scripts, no verification drivers, no screenshots, no research documents, no
development-only scenes, no temporary files.

**Test:** Enumerate every file in the addon and classify each as
integration / sample / development / research. Only integration material may be
present in the addon directory.

**Falsified if:** any file in the addon is classifiable as development-only,
research, probe, or test-evidence material.

---

## Non-predictions (explicitly out of scope)

This pass does not predict, test, or claim:

- Asset Library publication succeeds (not attempted)
- performance characteristics of the addon
- multiplayer or networked-authority behaviour
- in-process (non-WS) Godot integration
- any change to CE causal semantics

## Blocker rule

If implementation exposes a genuine semantic defect in CE — as opposed to an
ergonomics, packaging, configuration, or documentation problem — this pass STOPS
and reports it. Frozen architecture is not modified to accommodate packaging.
