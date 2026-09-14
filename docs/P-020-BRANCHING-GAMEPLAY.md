# P-020: Branching & Rewind as a First-Class Game Mechanic

**Date:** 2026-09-01
**Status:** COMPLETE — CE's branching/rewind architecture is a working gameplay mechanic
**Central question answered:** *Can a player safely rewind a game world to an earlier causal
checkpoint, create an alternate timeline, play forward, and compare histories — while preserving
deterministic continuation, provenance, event identity, timeline isolation, and CE's sole causal
authority?* **YES.**

CE remains research-frozen at P-019. No frozen invariant was modified; this pass turned the
already-verified branching/rewind semantics (`src/core/timeline.ts`, `src/core/genealogy.ts`)
into a gameplay primitive.

---

## 1. Pre-Implementation Falsifiable Predictions — Results

| # | Prediction | Result |
|---|-----------|--------|
| P1 | Exact rewind: replay I3/I4 identically reproduces original physics | **CONFIRMED** — physics identical (price 13.13, hostility 0.56, RNG equal); stateHash/traceHash DIFFER because lineage is hashed and event ids are timeline-scoped (measured, not assumed) |
| P2 | Alternate branch diverges while retaining shared pre-fork ancestry | **CONFIRMED** — branch physics differ; worldId/parentTimelineId/parentCheckpointId/forkTick shared |
| P3 | Timeline isolation: parent/branch never cross-mutate | **CONFIRMED** — no event-id overlap in post-fork streams; hashes mutually untouched |
| P4 | Deterministic branch replay: same checkpoint+discriminator → same id/hashes | **CONFIRMED** — identical timelineId/stateHash/traceHash |
| P5 | Branch identity: convergent physics ≠ same timeline | **CONFIRMED** — equal physics, different stateHash (lineage hashed), traceHash, timelineId |
| P6 | Abandoned future excluded from forks | **CONFIRMED** — interventionsAfter(C,parent) = [I3,I4]; fork inherits neither |
| P7 | Event identity timeline-safe | **CONFIRMED** — same-content events on two timelines have different ids (measured: E-9d629adc vs E-736a4160) |
| P8 | Provenance correct across forks | **CONFIRMED** — branch price roots include pre-fork destroy AND branch post-fork interventions; parent explanation unpolluted |
| P9 | Rewind ≠ fork | **CONFIRMED** — rewind: origin "rewind", abandonedTimelines.length 1; fork: origin "fork", abandonedTimelines.length 0 |
| P10 | Convergence: physics equality ≠ timeline equality | **CONFIRMED** — engine does not collapse genealogically distinct timelines |

## 2. Timeline Ontology (formalized from existing CE structures — no new abstraction)

The ontology already exists in `src/core/genealogy.ts` + `src/core/timeline.ts`. Documented as
the game-facing model:

| Concept | CE structure | Definition |
|---------|--------------|------------|
| World | `lineage.worldId` | One persistent game world, stable across save/rewind/fork |
| Timeline | `lineage.timelineId` | One causal history within a world; fork/rewind create new ones |
| Checkpoint | `CheckpointEnvelope` | Captured, resumable point; the persistence unit |
| Fork | `forkTimeline(cp, discriminator)` | Sibling timeline from a checkpoint; deep-cloned isolation |
| Rewind | `rewindTo(cp, abandoned)` | Return to earlier checkpoint; abandoned future recorded, not deleted |
| Parent/Child | `parentTimelineId` | Divergence links |
| Abandoned future | `lineage.abandonedTimelines[]` | Rewound-away futures, referenceable + replayable |
| Shared ancestry | worldId, parentTimelineId, parentCheckpointId, forkTick | Preserved across fork/rewind |
| Divergent history | `divergenceInterventionIds` | Interventions that created the divergence |
| Convergent state | physics equality, distinct lineage | Two timelines, same effective state, different identity |

**Explicit answers:** timeline identity is content-derived (deterministic, replayable); a fork
deep-clones everything (physics, RNG, counters, events, provenance, lineage); shared = identity
references only; delivery cursors are per-branch (DeliveryState outside WorldState, wrong_timeline
guard); retention is per-world; pending continuation/RNG/provenance are per-branch; genealogy
records origin/parent/generation.

## 3. Checkpoint Semantics

The existing `CheckpointEnvelope` (full WorldState deep clone + identity) is sufficient for exact
branch continuation. Verified: `checkpoint → fork → advance parent → advance branch` keeps the two
worlds independent (P3). The WS server now stores checkpoints keyed by `checkpointId` so fork/rewind
reference them without re-sending the payload.

## 4. Intervention Semantics (attack matrix)

All combinations verified (branching-rewind.test.ts §11): before/after checkpoint, on parent/child
after fork, same/different interventions on both, rejected intervention on one timeline. A rejected
intervention consumes no causal sequence and mutates neither timeline.

## 5. Game-Facing Branch API (decision)

The minimal adapter-facing API, determined by what the gameplay loop actually needs:

| Operation | Needed for | Implemented |
|-----------|-----------|-------------|
| `checkpoint()` | capture the divergence point | yes (server stores by id) |
| `rewind(checkpointId)` | abandon current future, return to checkpoint | yes |
| `fork(checkpointId, discriminator)` | create alternate timeline | yes |
| `switchTimeline(timelineId)` | navigate between timelines | yes |
| `listTimelines()` | show the timeline tree | yes |
| `timelineInfo(timelineId)` | show lineage/state of one timeline | yes |
| `compareTimelines(a, b)` | the comparison view | yes |

The adapter remains thin: it translates intents and projects state. Godot implements zero causal
simulation, RNG, consequence calculation, provenance, timeline mutation, or branch resolution.

## 6. Godot Gameplay Implementation

Extended the P-018 isometric vertical slice (`iso_main.gd`) with:
- **Branch UI:** Checkpoint / Rewind / Fork Timeline B / Compare A vs B buttons + comparison panel
- **Gameplay loop (auto-demo, verified on the physical display):**
  1. Timeline A: destroy bridge → advance → grain **14.86**
  2. Checkpoint captured: `C-45aa1ecd`
  3. Rewind → new timeline `T-849c1d0a` (origin rewind, abandoned future recorded)
  4. Fork → Timeline B `T-5d05c928` (origin fork)
  5. Timeline B: grant subsidy instead → advance → grain **14.46** (diverged from A)
  6. Compare A vs B → comparison panel rendered

The player sees: *"This is the same world at the same point in history, but I chose differently."*

## 7. Visualize Timeline Identity

The comparison panel shows both timeline ids, grain price/stock, MG hostility, bridge state, event
counts, and the equality verdicts (stateHash equal / traceHash equal / physics equal). When physics
converge but identity differs, it shows **"Same effective state, DIFFERENT history (distinct
timelines)"** — never collapsing them.

## 8. Compare Alternate Outcomes

The comparison view uses CE state/event/provenance information only (server-side `compare-timelines`
computes physics/stateHash/traceHash equality from the two worlds). No game-specific comparison
rules were invented.

## 9. Rewind Semantics in the UI

**Both** operations are exposed as distinct actions (Rewind vs Fork), per the mission's preference
for semantic clarity. Rewind abandons the current future (recorded, replayable); Fork preserves it
as a sibling. The player never accidentally destroys an alternate history.

## 10. WebSocket/Runtime Verification

The P-017 WebSocket boundary is the real runtime. The server was extended to a multi-timeline
registry (each timeline = independent world+engine+delivery). Verified: no event duplication beyond
at-least-once, no cross-timeline event collision (P7), cursor correctness per timeline, gap
recovery, stateSync correctness, deterministic continuation. Transport remains observational.

## 11. Determinism Matrix

- **Direct CE / WS:** identical hashes for equivalent scenarios (branching-rewind.test.ts P4).
- **Windows x64 / macOS arm64:** the branching-rewind suite passes on both (25/25 each).
- **Godot:** the branch demo's hashes match the direct-CE reference for the same interventions.

## 12. Adversarial Tests (branching-rewind.test.ts §11, 13 tests)

fork twice from same checkpoint (distinct ids); fork from a branch (generation 2); rewind after
multiple interventions (full abandoned stretch + replayAbandoned reproduces the abandoned hash);
repeated timeline switching (no cross-mutation); post-switch submissions land correctly; same-branch
replay (identical hashes); convergence (physics equal, identity distinct); reconnect after fork
(branch-only events, at-least-once, dedup); restore after branch (pre-fork world, branch untouched);
two consumers see only their own events; parent↔child cursor cross-polls refused (wrong_timeline);
rejected intervention changes nothing on either timeline.

**No state/event/cursor/RNG/provenance leakage, no timeline identity collision, no abandoned-future
leakage.**

## 13. Defects and Fixes

- **None in CE core.** The branching/rewind semantics were already correct (P-017-era tests).
- **WS server refactor:** the single-world Runtime became a multi-timeline registry; existing
  ws-boundary tests (24) confirmed no regression.
- **Godot adapter:** added branch API methods + response handlers; headless iso verification
  remained 16/16.

## 14. Final Architecture Decision

**Branching and rewind are a first-class gameplay mechanic.** The player can rewind to a
checkpoint, fork an alternate timeline, play forward differently, and compare the two histories —
with deterministic state, provenance, event identity, timeline isolation, and CE's sole causal
authority all preserved. The 12 frozen invariants are intact.

## 15. Remaining Risks

1. **Timeline registry is in-memory** — server restart loses non-current timelines (checkpoints
   are also in-memory). Persistence of the timeline tree is a future concern, not this pass.
2. **Comparison view is text-based** — adequate for the slice; a richer visual diff is P-021 scope.
3. **Rewind/fork via checkpointId requires the server to hold checkpoints** — a client that
   reconnects after server restart must re-checkpoint. Documented, not a defect.
4. **Branch depth is unbounded** — each fork adds a timeline entry; a long session could grow the
   registry. Bounded by gameplay, not by CE.

## 16. Recommended P-021

**Persist the timeline tree + richer branch visualization.** (a) Serialize the timeline registry
and checkpoints so a server restart preserves all branches; (b) render the timeline tree visually
(not just text) with per-branch state chips; (c) add a third branch to demonstrate multi-way
divergence. All within the frozen invariants — no new causal mechanics.

## Files (new/changed this pass)

- `src/poc/branching-rewind.test.ts` — 25 adversarial tests (created)
- `src/poc/ce-ws-server.ts` — multi-timeline registry + branch API (fork/rewind/switch/list/info/compare) (changed)
- `src/poc/godot/ce_ws_adapter.gd` — branch API methods + response handlers + checkpoint-id capture (changed)
- `src/poc/godot/iso_main.gd` — branch UI + gameplay loop + comparison view (changed)
- `src/poc/godot/shots/iso_G_branch_compare.png` — visual evidence (created)
- `docs/P-020-BRANCHING-GAMEPLAY.md` — this report (created)
- `docs/RECONNAISSANCE.md` — §30 appended
- QMS: `VER-2026-027`, `REQ-2026-017`