# P-021: CE Paper Package — Publication-Ready Research Artifacts

**Date:** 2026-09-02
**Status:** PREPARED / SUBMISSION-BLOCKED
**Frozen Invariants:** 12 (P-019) — UNCHANGED

---

## 1. Proposed Paper Title

**Causality Engine: A Deterministic Causal World-Simulation Layer for Interactive Games**

Alternative titles considered:
- "Causal World-Simulation for Interactive Games: Architecture and Validation of the Causality Engine"
- "Remembering Consequences: A Causal Engine for Game World Simulation"

---

## 2. Abstract (Draft)

Games that respond to player actions with meaningful, traceable consequences require a causal simulation layer that is deterministic, inspectable, and separable from presentation. We present Causality Engine (CE), a TypeScript-based causal world-simulation layer that treats player interventions as inputs to a propagation pipeline rather than direct state mutations. CE maintains sole authority over world state, causal propagation, deterministic RNG, temporal ordering, branching, and rewind, while remaining agnostic to rendering, animation, and player input.

CE's architecture separates three concerns: the game (rendering, input, presentation), the adapter (translation between game intent and CE interventions), and the engine (causal propagation, state, provenance). A quota-based budget governor defers causal resolution across ticks, preventing cascade爆炸 while preserving causal fidelity. A structured provenance DAG enables retrospective attribution: given any observable consequence, CE can trace the causal chain back to originating player actions.

We validate CE through a vertical-slice integration with Godot 4.7, demonstrating a playable medieval town scenario where a single player intervention (destroying a trade bridge) propagates through economy, factions, and merchant behavior over ~28 ticks. The same intervention, replayed from the same seed, produces bit-identical state sequences (SHA-256 stateHash). Branching from a checkpoint creates causally distinct timelines that can be compared side-by-side. Cross-platform validation (macOS arm64, Windows x64) confirms deterministic replay across hardware.

CE is not a general-purpose game engine. It is a causal simulation layer that games consume through a defined adapter boundary. We discuss the limitations of this approach, the conditions under which determinism holds, and the architectural decisions that enable transport-independent, language-agnostic integration.

---

## 3. Research Questions

**RQ1:** Can a game simulation layer maintain deterministic causal propagation while remaining fully separable from presentation?

**RQ2:** Can player interventions be modeled as deferred causal pressures rather than immediate state mutations, while preserving observable responsiveness?

**RQ3:** Can a structured provenance DAG enable retrospective causal attribution for any observable game consequence?

**RQ4:** Can deterministic branching and rewind be implemented as first-class world operations without architectural compromise?

**RQ5:** Can the same causal simulation run identically across different hardware platforms given identical inputs?

---

## 4. Contribution List

### Primary Contributions

1. **Causal Quota Architecture:** A budget-governed propagation model where interventions accumulate as pressure in per-region, per-domain ledgers, and resolution fires only when thresholds are crossed. This defers cascade爆炸 while preserving causal fidelity. (Novel to CE, not present in KE.)

2. **Structured Provenance DAG with Retrospective Attribution:** A multi-parent directed acyclic graph that tracks causal ancestry from effects back to intervention roots, enabling `explain()` to answer "why did this happen?" for any observable quantity. (Novel to CE; KE had log-based provenance.)

3. **Adapter Authority Boundary:** A strict separation where the engine owns causality and the adapter owns translation, enabling the same causal simulation to be consumed by different game engines (Godot, Unreal, custom) without modification.

4. **Vertical-Slice Validation:** An end-to-end integration demonstrating that a single player intervention propagates through a multi-domain game world with deterministic, inspectable, and branchable consequences.

### Secondary Contributions

5. **Cross-platform deterministic replay:** SHA-256 state identity confirmed across macOS arm64 and Windows x64.

6. **Transport-independent delivery:** HTTP polling and WebSocket push expose identical causal semantics.

7. **Bounded retention with explicit eviction:** A finite event window that preserves causal continuity while preventing unbounded memory growth.

---

## 5. Claim → Evidence Mapping

| # | Claim | Classification | Evidence | Strength |
|---|-------|---------------|----------|----------|
| C1 | Same seed + same interventions → identical world | Empirically supported | `determinism.test.ts` (14 tests), SHA-256 stateHash comparison | Strong (deterministic, reproducible) |
| C2 | Deterministic replay across save/restore | Empirically supported | `persistence.test.ts` (40 tests), checkpoint round-trip | Strong |
| C3 | Cross-platform bit identity | Empirically supported | `cross-platform-determinism.ts`, macOS/Windows hash comparison | Moderate (2 platforms, no formal proof) |
| C4 | Causal quota prevents cascade explosion | Implementation observation | P-009 §4, `feedback.test.ts` (47 tests) | Moderate (empirically validated) |
| C5 | Provenance DAG traces effects to intervention roots | Empirically supported | `explain()` in `provenance.ts`, P-009 §3 | Strong (BFS traversal verified) |
| C6 | Adapter boundary enables engine-agnostic integration | Design decision | `game-adapter.ts`, Godot integration (P-014–P-018) | Moderate (one integration demonstrated) |
| C7 | Branching creates causally distinct timelines | Empirically supported | `branching.test.ts` (21 tests), `branching-rewind.test.ts` (25 tests) | Strong |
| C8 | StateHash excludes trace-side data | Design decision + verified | P-009 §1, `hash.ts` | Strong (by construction + test) |
| C9 | WebSocket and HTTP expose identical causal semantics | Empirically supported | `ws-boundary.test.ts` (24 tests), `temporal-boundary.test.ts` (44 tests) | Strong |
| C10 | Single-town vertical slice demonstrates feasibility | Implementation observation | P-014–P-018, Godot integration | Weak (single scenario, not general proof) |

---

## 6. Limitations / Non-Claims

The following are explicitly NOT claimed:

1. **No formal determinism proof.** Determinism is empirically validated through reproducible hash comparison, not formally proven. IEEE-754 floating-point behavior across platforms is not guaranteed.

2. **No exactly-once delivery.** Event delivery is at-least-once with explicit gap detection. Consumers must handle deduplication.

3. **Not a general-purpose engine.** CE is a causal simulation layer, not a game engine. It does not render, animate, or handle input.

4. **Single-town vertical slice.** The Godot integration demonstrates one scenario (3 towns, 20 NPCs). Scalability to larger worlds is not established.

5. **WS production soak not established.** WebSocket transport is validated through integration tests, not production load testing.

6. **Hardware-specific performance.** Performance claims (145 FPS render, 3.46s test suite) are specific to Apple M4 and should not be generalized.

7. **Integration-level testing.** Tests validate API contracts and state transitions, not formal behavioral specifications.

8. **No multiplayer/distributed simulation.** CE is single-process, single-consumer. No IPC or distributed state.

9. **No concurrent intervention submission.** Single-threaded execution. No lock-free structures.

10. **Content limitations.** The medieval town scenario is illustrative, not exhaustive. Domain coverage (economy, factions, infrastructure, population) is not complete.

---

## 7. Historical Lineage

### Deer's Rock → Kronos Engine → Causality Engine

**Deer's Rock** was the initial exploration of causal simulation in games. It established the core question: *Can a game world remember and propagate consequences rather than computing them on-demand?* The implementation was exploratory and did not achieve a stable architecture.

**Kronos Engine (KE)** refined Deer's Rock into a deterministic, multi-scale world simulator. KE introduced:
- Seeded PRNG with RNG-state threading
- WorldState/WorldSnapshot separation
- Sector contract (immutable tick transforms)
- Typed event catalog with ordered event bus
- Universe genealogy with Rewind Points and fork recipes
- Adapter boundary ("The world does not reach into the hospital")

KE's limitations drove CE's design:
- Six Earth-specific sectors → CE's four game-agnostic domains
- Typeless intervention patches → CE's typed, schema-registered interventions
- FNV-1a 32-bit hash → CE's SHA-256 state identity
- O(n) RNG restore → CE's O(1) register capture
- Module-level global counters → CE's per-world scoped counters
- Wall-clock in restore → CE's clock-free simulation
- Counterfactual diff comparison → CE's provenance DAG traversal

**Causality Engine** inherited KE's deterministic foundations but redesigned the architecture for game integration:
- Universe/Sector → World/Timeline/Checkpoint
- Log-based provenance → structured multi-parent DAG
- Statistical forks → deterministic single replay
- Counterfactual comparison → retrospective attribution via `explain()`

CE added novel mechanisms not present in KE:
- Causal quota as budget governor
- Convergence detection for feedback loops
- Bounded retention with explicit eviction
- Cross-region boundary propagation with locality
- Generated causality with generation bounds
- Structured event attribution

### Lineage Statement

CE is an architectural descendant of KE, not a renamed KE. The relationship is one of inheritance and deliberate redesign: CE kept KE's deterministic foundations (seeded RNG, pure ticks, snapshot/restore) while replacing KE's Earth-specific content model with a game-agnostic causal architecture. The adapter boundary pattern originated in KE and was refined in CE to support multiple game engines.

---

## 8. Publication-Readiness Checklist

| Item | Status | Notes |
|------|--------|-------|
| Title | Draft | Subject to revision |
| Abstract | Draft | Needs empirical results section |
| Introduction | Missing | Needs motivation + problem statement |
| Related Work | Partial | KE lineage documented; needs broader game-AI context |
| Architecture | Strong | P-009 §1 comprehensive |
| Causal Model | Strong | P-009 §3–§4 comprehensive |
| Determinism Model | Strong | P-009 §5 comprehensive |
| Persistence Model | Strong | P-009 §6 comprehensive |
| Experimental Methodology | Partial | Individual pass reports exist; needs consolidation |
| Results | Partial | Test counts, hash comparisons, performance numbers exist |
| Failure/Adversarial Testing | Strong | P-020 (25 tests), boundary tests |
| Limitations | Strong | §6 above comprehensive |
| Discussion | Missing | Needs interpretation of results |
| Conclusion | Missing | Needs synthesis |
| Figures/Diagrams | Missing | Architecture diagram, causal flow, hash comparison |
| References | Missing | Needs academic bibliography |
| Reproducibility | Strong | Public GitHub repo, deterministic replay |

### Blocking Items

1. **Deer's Rock cleanup** — must be finalized before paper narrative is frozen
2. **Kronos Engine cleanup** — must be finalized before paper narrative is frozen
3. **Empirical results section** — needs consolidated experimental data
4. **Discussion section** — needs interpretation of findings
5. **Figures** — needs architecture diagrams, flow charts

---

## 9. DR/KE Submission Gate

```
PAPER STATUS: PREPARED / SUBMISSION-BLOCKED

BLOCKERS:
- Deer's Rock cleanup/finalization
- Kronos Engine cleanup/finalization

WHEN BLOCKERS CLEARED:
1. Inspect final DR/KE state
2. Reconcile historical lineage (§7)
3. Update paper where necessary
4. Rerun evidence/claim audit (§5)
5. Produce final submission candidate

DO NOT:
- Submit before DR/KE are finalized
- Declare academic validation beyond existing evidence
- Publish repository as equivalent to peer-reviewed publication
```
