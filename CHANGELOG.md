# Changelog

All notable changes to Causality Engine.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0-rc.1] — 2026-09-02

First release candidate. The engine architecture is research-frozen; this
candidate is about distribution, not capability.

### Added

- **Product API** (`causality-engine/product`) — the supported surface for game
  developers. Nine modules covering runtime, configuration, action catalog,
  intervention ergonomics, event streaming, persistence, timelines, inspection,
  and causal explanation.
- **Godot addon** (`godot/addons/causality_engine/`) — installable Godot 4 addon.
  `CeClient` provides transport, projection, reconnection, and the full CE API
  over WebSocket. `Quantity` provides typed key builders for `explain()`.
- **Godot sample** (`godot/sample/`) — minimal six-step integration plus a
  headless verification driver with 23 assertions.
- **Documentation** — Getting Started, API Reference, Compatibility,
  Installation, Runtime Requirements, Godot Integration, Deployment,
  Troubleshooting.
- **Package exports** — `.` and `./product` for the product surface, `./engine`
  for adapter authors needing low-level delivery or lifecycle control.
- **Build configuration** — `tsconfig.build.json` emits only shippable code;
  proof-of-concept tools and tests are excluded from the published artifact.
- **Verification scripts** — `verify:replay`, `verify:invariants`,
  `verify:release`.
- **CI** — GitHub Actions workflow running the full verification suite from a
  clean checkout.

### Engine capabilities (established pre-1.0, unchanged)

- Deterministic causal propagation: same seed + same config + same interventions
  produce the same `stateHash` at every tick.
- Causal quota architecture — interventions accumulate as pressure in per-region,
  per-domain ledgers; resolution fires on threshold crossing.
- Structured provenance DAG with retrospective attribution via `explain()`.
- Branching and rewind as first-class world operations with content-derived
  timeline identity.
- Bounded event retention with explicit gap reporting — eviction is never silent.
- At-least-once event delivery with stable stream coordinates and explicit
  acknowledgement.
- Transport independence: HTTP polling and WebSocket push expose identical causal
  semantics.
- Schema migration for saved worlds (current schema version 7).

### Known limitations

- **The WebSocket runtime has no authentication.** It binds `127.0.0.1` by
  default. Exposing it beyond localhost requires a security layer that is not
  part of CE v1.0.
- Single process. No IPC, no distributed simulation, no multiplayer.
- At-least-once delivery, not exactly-once. Consumers must tolerate redelivery.
- Bounded event and provenance records. Eviction is reported, not prevented.
- No formal determinism proof. Empirically validated on macOS arm64 and
  Windows x64.
- Not a game engine — no rendering, animation, input, or audio.
- Single-scenario vertical slice. Scalability to large worlds is not established.
- `tsc --noEmit` reports pre-existing type errors in `src/poc` tooling. Those
  files are excluded from the published build and from the release check.

### Not yet done

- Not published to npm.
- Not submitted to the Godot Asset Library.
- Godot support matrix limited to versions actually tested — see
  `docs/RUNTIME-REQUIREMENTS.md`.

---

## Pre-1.0 history

Development proceeded as numbered research passes (P-001 … P-023). Each pass
produced a report under `docs/`. Notable gates:

| Pass | Outcome |
|------|---------|
| P-009 | Reconnaissance synthesis; architecture settled |
| P-011 | Headless CE runtime — simulation independent of any host process |
| P-014 | Godot feasibility; deterministic replay baseline `5404d32e` established |
| P-017 | WebSocket event push accepted with caveats |
| P-018 | First playable vertical slice |
| P-019 | Research audit; 12 architectural invariants frozen |
| P-020 | Branching gameplay; adversarial branch/rewind testing |
| P-021 | Paper package and productization analysis |
| P-022 | Product API — integration-ready |
| P-023 | Godot distribution package — distribution-ready |

The engine has been research-frozen since P-019. Changes after that point are
product, packaging, and documentation work; the 12 frozen invariants are
unchanged.

[1.0.0-rc.1]: https://github.com/rikirinjani/causality-engine/releases/tag/v1.0.0-rc.1
