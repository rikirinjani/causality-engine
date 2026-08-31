# P-009: Final Reconnaissance Synthesis & Integration Gate

**Project:** Causality Engine (CE)
**Date:** 2026-08-31
**Status:** SYNTHESIS COMPLETE — DECISION GATE
**Predecessors:** P-005 (External Consumer), P-006 (Game-Shaped Adapter), P-007 (Attribution & Windowing), P-008 (Temporal Semantics)
**Test Suite:** 496/496 passing, 13 test files, tsc clean
**Schema Version:** 7

---

## §1 — Final Architecture

CE is a deterministic causal world-simulation layer. It does not render, animate, or handle input. It **remembers and propagates consequences**.

### One System, Not Disconnected Features

The architecture forms a single dataflow pipeline:

```
PLAYER ACTION
    ↓
ADAPTER (translate intent → CE Intervention)
    ↓
submitIntervention → Intervention added to pending queue
    ↓
advance(n ticks) → tick() called n times
    ↓
┌─ phase 0: merge pending contributions into region ledgers
├─ phase 1: heartbeatEconomy (stock, price, trade)
├─ phase 2: heartbeatInvestment (merchant profitability → trade capacity)
├─ phase 3: heartbeatFactions (hostility, patrol demand)
├─ phase 4: heartbeatPopulation (NPC behavior)
├─ phase 5: quota resolution (ledger ≥ threshold → domain resolver + boundary signals)
├─ phase 6: decay unresolved ledger entries
├─ phase 7: dynamics (convergence classification, anomaly surfacing)
├─ phase 8: collect events → enforce retention
└─ mirror RNG state into WorldState
    ↓
WorldState updated (regions, entities, events, provenance)
    ↓
ADAPTER (consumeAndProject → GameView for rendering)
```

Every component feeds into and depends on this single pipeline. There are no independent subsystems — the quota system drives resolution, resolution drives events, events carry provenance, provenance enables attribution, retention bounds history, and persistence preserves continuation state.

### Component Inventory

| Component | File(s) | Role |
|-----------|---------|------|
| **WorldState** | `core/types.ts` | The entire simulation state: regions, entities, events, provenance, dynamics |
| **Regions** | `core/types.ts:129` | Spatial simulation partitions with local ledgers, infrastructure, population |
| **Entities** | `core/types.ts:165` | Agents (farmer, merchant, guard, artisan) and factions (MG, WA) |
| **Relations** | `core/types.ts:257` | Directed social links (e.g. MG→player hostility) |
| **Resources** | `game/content.ts` | grain, iron, cloth, timber, herbs with production/consumption rates |
| **Infrastructure** | `game/content.ts:106` | Trade routes, warehouses, shrines — destroyable structures |
| **Factions** | `game/factions.ts` | Merchant Guild (trade), Wardens (patrol) — respond to economy/civic pressure |
| **Interventions** | `core/types.ts:76` | Player actions with target, magnitude, causal contributions per domain |
| **Causal Pressure** | `core/propagation.ts` | Deferred contributions with magnitude (unsigned) + direction (signed valence) |
| **Quota** | `core/world.ts:327` | Threshold check: ledger pressure ≥ domain threshold → fire resolution |
| **Propagation** | `core/propagation.ts:37` | Cross-region boundary signals with decay, generation bound, locality |
| **Generated Causality** | `core/propagation.ts:29` | State transitions that create NEW pressure (generation n+1), bounded |
| **Boundary Propagation** | `core/propagation.ts:400` | BFS hop-distance over region graph; primary+generated propagate, inherited boundary does not |
| **Simulation Ticks** | `core/world.ts:272` | Pure 9-phase tick: merge → heartbeat×4 → quota → decay → dynamics → events |
| **Events** | `core/events.ts` | Deterministic outbound facts with timeline-scoped IDs, streamSeq, canonical order |
| **Provenance** | `core/provenance.ts` | Multi-parent DAG: intervention → pressure → resolution → effect → derived |
| **Persistence** | `core/persistence.ts` | Checkpoint: serialize/deserialize/validate/restore with schema migration |
| **Branching** | `core/timeline.ts` | Fork (new timeline from checkpoint) and Rewind (abandon future, resume past) |
| **Retention** | `core/retention.ts` | Bounded event window (500 events), explicit eviction boundary, gap detection |
| **Attribution** | `core/provenance.ts:137` | `explain()` BFS from provenance ref to intervention roots |
| **Public API** | `api/public.ts` | Stable surface: 135 lines, re-exports only what developers need |
| **Adapter** | `poc/game-adapter.ts` | Translation layer: player intent → CE intervention → CE events → game view |

### WorldState — The Single Source of Truth

WorldState is the entire simulation state. It contains:

- **Identity**: `tick`, `lineage` (worldId, timelineId, origin), `schemaVersion`
- **Physics**: `regions` (stocks, prices, infrastructure, ledger), `entities`, `relations`
- **Continuation**: `rngState`, `config`, `pendingContributions`, `dynamics`
- **History**: `events` (bounded), `provenance` (bounded), `resolutionLog` (bounded)
- **Trace side** (excluded from stateHash): `ledgerCauses`, `pendingCauses`, `interventionHistory`
- **Bookkeeping**: `highestEmittedSeq`, `oldestRetainedSeq`, `evictedCount`, `historyTruncated`

The separation between state-side (physical world) and trace-side (causal history) is load-bearing: two worlds with identical physics but different causal histories must have the same `stateHash` but different `traceHash`.

---

## §2 — KE Inheritance Audit

CE is an **architectural descendant** of Kronos Engine, not a renamed KE. It inherited proven patterns and deliberately rejected or redesigned others.

| KE Concept | CE Status | Reason |
|------------|-----------|--------|
| Deterministic RNG | **Inherited, adapted** | mulberry32 kept; seed in WorldState for snapshot coverage; O(1) register capture |
| World state | **Inherited, redesigned** | Single WorldState replaces KE's separate Universe/Sector/Region hierarchy |
| Ticks | **Inherited, adapted** | Pure phases, no wall-clock; KE's tick was a sector-iteration loop; CE's is a single function |
| Snapshots | **Inherited, adapted** | structuredClone; KE had separate snapshot/restore; CE unifies with checkpoint |
| Branching | **Inherited, redesigned** | KE had Universe→Branch with counters; CE has World→Timeline→Checkpoint with content-derived IDs |
| Intervention patches | **Inherited, redesigned** | KE applied patches to sector state; CE applies pressure to region ledgers via causal contributions |
| Event processing | **Inherited, redesigned** | KE had per-sector event queues; CE has a single event bus with streamSeq and canonical order |
| Counterfactual diff | **Deliberately discarded** | KE compared parallel universes; CE uses provenance DAG for causal tracing instead |
| Statistical analysis | **Deliberately discarded** | KE had statistical forks for Monte Carlo; CE has single deterministic replay |
| Sector model | **Deliberately discarded** | KE had pluggable sectors (Geopolitics, Climate, etc.); CE has fixed 4 domains (civic, ecology, economy, faction) |
| Universe genealogy | **Redesigned** | KE used "Universe" with cosmological framing; CE uses "World→Timeline→Checkpoint" for game semantics |
| Rewind points | **Redesigned** | KE called them Rewind Points; CE calls them Checkpoints — the same mechanism, better naming |
| Causal quota | **Novel to CE** | KE had no quota system; CE's threshold-based budget governor is new |
| Convergence detection | **Novel to CE** | KE had no feedback-loop analysis; CE classifies signals as converged/oscillating/diverging |
| Provenance DAG | **Novel to CE** | KE had log-based provenance; CE has structured multi-parent DAG with BFS traversal |
| Retention/eviction | **Novel to CE** | KE had no bounded event window; CE owns a bounded authoritative window with explicit eviction |

### What CE Kept from KE

- Deterministic RNG with seed-based replay
- Pure tick phases (no wall-clock, no Math.random)
- Snapshot/restore for persistence
- Content-derived IDs (not global counters)
- Separation of simulation from presentation

### What CE Replaced

- Universe/Sector/Region hierarchy → World→Timeline→Checkpoint
- Sector model → fixed 4-domain causal model
- Log-based provenance → structured multi-parent DAG
- Universe genealogy → game-appropriate naming
- Counterfactual comparison → causal DAG traversal

### What CE Added (Novel)

- Causal quota as budget governor
- Convergence detection for feedback loops
- Bounded retention with explicit eviction boundary
- Cross-region boundary propagation with locality
- Generated causality with generation bounds
- Structured event attribution via `explain()`

---

## §3 — Final Causal Ontology

### Relationship Types

| Relation | Meaning | Evidence |
|----------|---------|----------|
| **REQUIRES** | Domain B cannot resolve without domain A having fired first | Structural: economy resolution requires stock data from ecology |
| **ENABLES** | Domain A creates conditions that allow domain B to fire | Quota: pressure from A accumulates toward B's threshold |
| **MOTIVATES** | Domain A's resolution generates pressure toward domain B | Propagation: economy resolution → faction hostility increase |
| **PRECEDES** | A happens before B in canonical order, not necessarily causally | Tick ordering: phase 1 precedes phase 5, but may not cause it |
| **EXCLUDES** | A and B cannot both fire in the same tick for the same region/domain | Quota: once resolved, ledger is cleared; no double-firing |
| **INVARIANT** | Constraint that must hold across all ticks | Config bounds: pressure ≤ capPerDomainRegionTick always |

### Status/Evidence Model

| Status | Meaning | When Used |
|--------|---------|-----------|
| **ESTABLISHED** | Intervention's effect is confirmed by resolution | Resolution fired, event emitted |
| **EXCLUDED** | Effect cannot occur given current state | Infrastructure already destroyed; idempotent rejection |
| **CONTRADICTED** | Two opposing causes of comparable weight | Contested resolution: ratio ≥ contestRatio |
| **CONTINGENT** | Effect depends on a future condition | Pending pressure below threshold; waiting for quota |
| **UNKNOWN** | No evidence one way or the other | Initial state before first intervention |
| **UNSUPPORTED** | CE does not model this domain/relationship | Cross-domain effects not in causal contributions |

### Causal Concepts

| Concept | Definition | How Tracked |
|---------|-----------|-------------|
| **Reachability** | Whether a region can be affected by another's actions | BFS hop distance over region graph, bounded by `boundaryMaxHops` |
| **causalReach** | Whether a specific quantity is reachable from a specific intervention | Provenance DAG: BFS from provenance ref to intervention root |
| **Contested causality** | Opposing causes of comparable weight in one domain | `ResolutionDecision.contested = true` when neg/pos ratio ≥ contestRatio |
| **Generated causality** | NEW pressure created by a state transition (not inherited) | `PressureOrigin = "generated"` with incremented generation counter |

### Orthogonal Dimensions

The following are **independent dimensions** that CE tracks separately:

```
TRUTH/STATUS          — What happened (ESTABLISHED, CONTRADICTED, etc.)
CAUSAL REACHABILITY   — Whether A can affect B (graph topology)
TEMPORAL ORDERING     — When things happened (tick, ordinal, streamSeq)
CAUSAL ANCESTRY       — Why things happened (provenance DAG, BFS to roots)
EVIDENCE COMPLETENESS — Whether the explanation is truncated (historyTruncated, incomplete)
```

A quantity can be ESTABLISHED + reachable + temporally ordered + causally traced + incomplete (if provenance was truncated). These dimensions do not collapse into a single "caused" flag.

---

## §4 — Final Propagation Model

### Pressure Representation

Each causal contribution carries:
- **magnitude** (unsigned): "how much does this domain need reconsideration?" — always ≥ 0
- **valence** (signed): direction in [-1, +1]; +1 = disruptive, -1 = relieving
- **origin**: `primary` (player action), `generated` (state transition), `boundary` (inherited from neighbor)
- **generation**: causal generation counter (0 = player action, incremented by state transitions)

### Accumulation

Pressure accumulates in per-region per-domain ledger entries via **saturating merge**:
- Below `pressureSoftKnee`: linear accumulation
- Above `pressureSoftKnee`: saturates toward `capPerDomainRegionTick`
- Opposition: magnitude accumulates, direction nets. Two equal opposing causes do NOT cancel — they add salience and create a contested resolution.

### Resolution

When `ledger[domain] ≥ thresholds[domain]`:
1. Record resolution decision (fired/not, contested/not, origin, generation)
2. Apply domain-specific resolver (economy: price shock; faction: hostility; etc.)
3. Emit boundary signals to neighbours (if origin is primary or generated)
4. Clear ledger entry

### Boundary Propagation

- **BFS hop distance** from origin region over the region graph
- **Decay**: each hop multiplies by `boundaryDecay` (default 0.3)
- **Floor**: signals below `boundaryFloor` are not emitted
- **Locality**: primary+generated propagate; inherited boundary never relays
- **Generation bound**: `maxCausalGeneration` (default 3) caps recurrence; hitting it emits `recurrence_cutoff` diagnostic

### Convergence Classifications

| Class | Meaning | Diagnostic |
|-------|---------|------------|
| `settling` | Still moving, no verdict | None |
| `converged` | Changes below epsilon, stable | None |
| `converged_at_bound` | Stable ONLY at a clamp | `convergence_not_reached` |
| `oscillating` | Alternating without settling | `oscillation_detected` |
| `diverging` | Growing without bound | `divergence_detected` |
| `cutoff` | Computational bound hit | `recurrence_cutoff` |

### Why No Global Tick Per Player Action

CE does not require a global simulation tick for every player action because:
1. **Interventions are deferred**: `submitIntervention()` queues the action; `advance()` runs ticks
2. **Quota is lazy**: pressure accumulates across ticks; resolution fires only when threshold is crossed
3. **Locality bounds work**: boundary signals decay by 0.3× per hop; a disruption in RF barely reaches PS
4. **Generation bound**: cyclic causality is capped at `maxCausalGeneration` ticks of propagation
5. **Retention is independent**: CE enforces event bounds without consulting consumers

A single player action generates ~8 consumer facts in one tick, then the world settles over ~28 ticks (at ledgerDecay=0.8). The adapter can advance multiple ticks per frame or one tick per frame — CE never requires real-time sync.

---

## §5 — Final Determinism Model

### Proven

| Guarantee | Evidence | Test Coverage |
|-----------|----------|---------------|
| Same seed + same interventions → identical world | SHA-256 `stateHash` comparison | `determinism.test.ts` (14 tests) |
| Deterministic replay across save/restore | `checkpoint → serialize → deserialize → restore → advance` produces same stateHash | `persistence.test.ts` (40 tests) |
| Canonical summation order-independent | PendingItem array → sorted-fold produces identical sums regardless of arrival order | `determinism.test.ts` |
| Stable event identity | Event ID = content hash of (timeline, tick, ordinal, type, regionId, data) | `determinism.test.ts`, `events.test.ts` |
| Persistence round-trip | serialize → deserialize → stateHash identical | `persistence.test.ts` |
| Fresh-process restart | New process, same seed → same world after same interventions | `determinism.test.ts` |
| Deterministic branching | Same fork at same checkpoint → same branch worldId and stateHash | `branching.test.ts` (21 tests) |
| Deterministic rewind | Same rewind point → same restored state | `branching.test.ts` |

### Not Proven

| Guarantee | Why Not Proven | Risk Level |
|-----------|----------------|------------|
| Cross-platform floating-point bit identity | IEEE-754 compliance not verified across platforms | Medium |
| Independent per-region RNG streams | Single RNG for whole world; regional isolation is logical, not computational | Low |
| Multi-process simulation | Single-process only; no IPC or distributed state | High |
| Multiplayer synchronization | No networking; single-consumer model | High |
| Real-time performance | No profiling; PoC-scale (3 towns, 20 NPCs) | Medium |
| Concurrent intervention submission | Single-threaded; no lock-free structures | Low |

---

## §6 — Final Persistence Model

### Minimum Continuation State

The following fields are required to resume a world from a checkpoint:

| Field | Category | Why Required |
|-------|----------|-------------|
| `tick` | Simulation position | Where to resume |
| `config` | Tuning | Thresholds, decay rates, bounds |
| `lineage` | Identity | worldId, timelineId, origin, parent links |
| `schemaVersion` | Migration | Which schema to migrate from |
| `rngState` | Determinism | RNG register for deterministic replay |
| `regions` | Physics | Stocks, prices, infrastructure, ledgers |
| `entities` | Physics | Agents, factions, locations |
| `relations` | Physics | Social links |
| `tradeVolume` | Physics | Per-tick trade activity |
| `pendingContributions` | Physics | Unresolved causal work in transit |
| `dynamics` | Continuation | Convergence traces (read by tick) |
| `interventionHistory` | Trace | Actions applied (for explain/audit) |
| `highestEmittedSeq` | Bookkeeping | Retention boundary |
| `oldestRetainedSeq` | Bookkeeping | Retention boundary |
| `evictedCount` | Bookkeeping | Audit counter |
| `interventionSeq` | Bookkeeping | ID derivation counter |
| `provenanceSeq` | Bookkeeping | ID derivation counter |
| `provenance` | Trace | Causal graph (bounded) |
| `provenanceRefs` | Trace | Current explanation per quantity |
| `resolutionLog` | Trace | Threshold check records (bounded) |
| `ledgerCauses` | Trace | Cause attribution per ledger entry |
| `pendingCauses` | Trace | Cause attribution per pending bucket |
| `diagnostics` | Trace | Anomaly records |
| `historyTruncated` | Trace | Whether bounded logs lost entries |

### stateHash vs traceHash

```
stateHash = SHA-256(
  tick, schemaVersion, lineage, config, regions, entities, relations,
  pendingContributions, dynamics, rngState, tradeVolume
)

traceHash = SHA-256(
  provenance, provenanceRefs, resolutionLog, ledgerCauses, pendingCauses,
  diagnostics, events, interventionHistory, historyTruncated,
  highestEmittedSeq, oldestRetainedSeq, evictedCount
)
```

**Why the separation?**
- `stateHash` answers: "What IS the world?" — the physical situation
- `traceHash` answers: "How did we GET here?" — the causal history
- Two different action sequences can reach the same physical world → same `stateHash`, different `traceHash`
- Provenance, events, and history can be compacted without changing future simulation → `stateHash` is unaffected by compaction

This is a load-bearing design decision: it allows history lifecycle management (compaction, eviction, migration) without invalidating world identity.

---

## §7 — Final Event Contract

### Event Identity

- **ID**: Content-derived hash `E-{sha256(timelineId, tick, ordinal, type, regionId, data)}`
- **Timeline-scoped**: Same content in different timelines produces different IDs
- **Per-tick ordinal**: Ordinal resets each tick; identity depends on position within tick
- **Never renumbered**: IDs are stable across replay

### Ordering

| Order | Key | Use |
|-------|-----|-----|
| **Emission order** | `streamSeq` | Monotonic per-timeline; used for cursors and incremental consumption |
| **Canonical order** | `(tick, kind, regionId, source, type, contentHash, ordinal)` | Logical view; `factStream()` returns this |
| **Per-tick** | `ordinal` | Breaks ties within a tick |

`streamSeq` ≠ canonical order. Two events with streamSeq 5 and 10 may appear in reverse canonical order if they belong to different kinds or regions.

### Stream/Window Semantics

| Function | Returns | Sorted By | Use Case |
|----------|---------|-----------|----------|
| `factStream(world)` | All retained consumer facts | Canonical order | Full logical view |
| `stream(world, afterSeq, limit)` | Events after streamSeq | streamSeq | Incremental consumption |
| `fullRecord(world)` | All retained events (incl. internal) | streamSeq | Debugging |

### Cursor Semantics

- Cursors reference `streamSeq`, never array positions
- `streamSeq` survives eviction — it's a delivery coordinate, not an index
- `classifyCursor(world, seq)` returns: `deliverable`, `gap`, or `caught_up`
- `describeGap(world, seq)` returns the evicted range when a gap exists

### Retention

- **Limit**: `EVENT_RETENTION_LIMIT = 500` events per timeline
- **Eviction**: FIFO from front of events array
- **Boundary**: `oldestRetainedSeq` and `highestEmittedSeq` define the window
- **Gap detection**: cursor below `oldestRetainedSeq` → gap reported
- **Independent of consumers**: CE enforces retention without consulting DeliveryState

### At-Least-Once Semantics

- CE hands events to the adapter; the adapter applies them
- If the adapter crashes mid-delivery, redelivery occurs on restart
- Consumers must be idempotent (same event applied twice = same result)
- `attempt` counter on `DeliveryAttempt` lets consumers distinguish first delivery from redelivery

### Consumer Responsibilities

1. Maintain a cursor (streamSeq) per consumer
2. Handle gaps via `stateSync()` or `resync()`
3. Be idempotent (same event applied twice must not corrupt state)
4. Copy facts out as they arrive if longer history is needed

### factStream() Public Status

`factStream()` remains public. It is the canonical way to get all consumer facts in logical order. `stream(afterSeq, limit)` is the incremental alternative for windowed consumption. Both are necessary: `factStream()` for full snapshots, `stream()` for incremental delivery.

---

## §8 — Final Attribution Contract

### What `explain()` Returns

`explain(world, quantityKey)` performs BFS from `provenanceRefs[quantityKey]` through parent links to intervention roots. It returns:

| Field | Type | Meaning |
|-------|------|---------|
| `target` | string | The quantity asked about |
| `explained` | boolean | Whether any cause was found |
| `roots` | RootCause[] | Intervention nodes reachable via the DAG |
| `nodes` | ProvenanceNode[] | Full ancestor subgraph (bounded by maxNodes) |
| `paths` | string[][] | Label chains from quantity to each root |
| `incomplete` | boolean | Whether the trace was truncated (provenance eviction) |
| `danglingParents` | string[] | Parent IDs no longer in the graph |

### What `explain()` Does NOT Return

- Natural language descriptions
- Confidence scores
- Temporal ordering of causes
- The "most likely" cause (it returns ALL reachable roots)
- Causal chains for quantities without provenance refs

### Attribution Distinctions

| Concept | Definition | How CE Handles |
|---------|-----------|----------------|
| **Direct cause** | The intervention that directly produced the effect | Root node in provenance DAG |
| **Causal ancestry** | All nodes in the path from effect to root | BFS traversal of parent links |
| **Contributing cause** | An intervention whose chain reaches the tracked quantity | Multiple parents preserved; never collapsed |
| **Ultimate player attribution** | Which player action started the causal chain | `RootCause.interventionId` |
| **Temporal metadata** | When things happened | `ProvenanceNode.tick` on each node |
| **Competing evidence** | Opposing causes in same domain | `ResolutionDecision.contested = true` |
| **Incomplete provenance** | History was truncated | `Explanation.incomplete = true` |
| **Abandoned futures** | Interventions on rewound timelines | Not in live provenance; recorded in `lineage.abandonedTimelines` |
| **Branch isolation** | Each timeline has independent provenance | Provenance nodes are timeline-scoped |

### Key Semantic: Provenance Refs Are Per-Quantity

Each tracked quantity (e.g. `RF:price:grain`) has a SINGLE provenance ref — the node most recently explaining it. When a new intervention affects the same quantity, the ref is updated. `explain()` traces from the CURRENT ref, not from all historical refs.

This means:
- If I1 creates the initial chain and I2 updates it, `explain()` traces through I2's chain
- If I2's chain shares ancestors with I1's (same intervention), both appear as roots
- If I2 affects a different domain (shrine → civic, not economy), it does NOT appear as root for price

### Key Semantic: explain() Traces DAG, Not Timeline

`explain()` follows provenance parent links, NOT temporal order. An intervention that happened earlier but does not have a provenance path to the quantity is invisible. This correctly distinguishes causation from temporal precedence.

---

## §9 — Public Adapter Boundary

### Architecture Diagram

```
GAME ENGINE (Unreal / Unity / Godot / custom)
    ↓
    rendering / physics / input
    ↓
ADAPTER
    ↓
    translateIntent() → CE Intervention
    ↓
CE PUBLIC API
    ↓
    submitIntervention() → advance(n)
    ↓
CAUSAL SIMULATION
    ↓
    tick() → 9 phases
    ↓
    quota → resolution → boundary signals
    ↓
    region ledgers, dynamics, convergence
    ↓
WORLD STATE + EVENTS + PROVENANCE
    ↓
CE PUBLIC API
    ↓
    factStream() / stream() / explain() / stateHash()
    ↓
ADAPTER
    ↓
    consumeAndProject() → GameView
    ↓
GAME ENGINE
    ↓
    rendering / presentation
```

### What CE Owns

| Responsibility | Boundary |
|----------------|----------|
| Causal simulation | All pressure accumulation, quota resolution, domain resolvers |
| Event generation | Deterministic outbound facts with streamSeq |
| Provenance tracking | Multi-parent DAG of causal ancestry |
| Convergence detection | Feedback loop classification (converged/oscillating/diverging) |
| Retention management | Bounded event window, eviction, gap detection |
| Persistence | Checkpoint serialization, schema migration |
| Branching | Fork and rewind with lineage tracking |
| Determinism | Seed-based RNG, canonical ordering, content-derived IDs |
| Attribution | `explain()` BFS to intervention roots |

### What the Game Engine Owns

| Responsibility | Boundary |
|----------------|----------|
| Rendering | Displaying the world to the player |
| Input handling | Capturing player actions |
| Physics | Collision, animation, particle effects |
| Audio | Sound effects and music |
| UI/UX | Menus, HUD, tooltips |
| Networking | Multiplayer synchronization (future) |
| Asset management | Textures, models, sounds |

### What Crosses the Adapter

| Direction | Data | Format |
|-----------|------|--------|
| Game → CE | Player intent | `Intervention` struct (action, target, magnitude, causalDomains) |
| CE → Game | World state | `GameView` projection (towns, prices, factions, unrest) |
| CE → Game | Events | `WorldEvent[]` (consumer facts via `factStream()` or `stream()`) |
| CE → Game | Attribution | `Explanation` struct (roots, nodes, paths) |
| CE → Game | Integrity | `stateHash` / `traceHash` for save verification |

---

## §10 — Capability Boundary

### PROVEN

Capabilities demonstrated by tests (496 tests, 13 test files):

- Deterministic world creation and simulation
- Causal pressure accumulation per region/domain
- Quota threshold resolution with domain-specific effects
- Cross-region boundary propagation with locality
- Cyclic feedback loops with convergence detection
- Deterministic branching (fork) and rewind
- Checkpoint serialization/deserialization round-trip
- Schema migration with backward compatibility
- Event generation with deterministic IDs and streamSeq
- Canonical event ordering
- Incremental event consumption via `stream(afterSeq, limit)`
- Event retention with bounded window and explicit eviction
- Gap detection and resync
- At-least-once delivery with idempotent consumers
- Multi-parent provenance DAG
- Causal attribution via `explain()` BFS
- `attributeEvent()` linking events to causal nodes
- State hash vs trace hash separation
- History compaction without state identity change
- Game-shaped adapter using only public API
- Idempotent destruction (same infrastructure cannot be destroyed twice)
- Contested causality detection (opposing causes)
- Generated causality with generation bounds

### PROVEN WITH LIMITATIONS

| Capability | Constraint |
|-----------|------------|
| Deterministic replay | Single platform (Node.js 22.23.2, Windows) |
| Event retention | 500-event window; longer history requires adapter-side storage |
| Game adapter | PoC scale (3 towns, 20 NPCs, 5 resources) |
| Convergence detection | 6 classifications; requires tuning per game |
| Attribution | BFS bounded by maxNodes (500); very large graphs may be incomplete |
| Persistence | Single-file JSON serialization; no incremental saves |
| Branching | Parent-child only; no diamond merges |

### UNPROVEN / FUTURE

| Capability | Why Unproven |
|-----------|-------------|
| Unreal integration | No Unreal adapter exists |
| Real-time game-loop performance | No profiling at game frame rates |
| Cross-platform deterministic execution | IEEE-754 compliance not verified |
| Multiplayer synchronization | No networking; single-consumer model |
| Distributed regional execution | Single-process only |
| MMO-scale simulation | PoC has 3 towns, 20 NPCs |
| Large NPC populations | No stress testing beyond PoC scale |
| Multi-file persistence | Single checkpoint file |
| Incremental saves | Full checkpoint serialization each time |
| Concurrent intervention submission | Single-threaded |

---

## §11 — Defect History

### Architectural Defects Discovered During Reconnaissance

| # | Defect | Danger | Detection | Fix | Regression |
|---|--------|--------|-----------|-----|------------|
| 1 | **Causal saturation erasure** | Large existing ledger entry makes new contribution invisible (hard clamp) | Parameter sweep showed unresponsive domains | Soft-knee saturation: linear below knee, saturating above | `stress.test.ts`, `feedback.test.ts` |
| 2 | **Floating-point accumulation order** | IEEE-754 non-associativity: `raw += m` in arrival order produces order-dependent bits (measured 2.35000000000000008882 vs 2.34999999999999964473) | Canonical summation test | PendingItem array → sorted-fold | `determinism.test.ts` |
| 3 | **Wrong state/trace hashing** | Events and provenance in stateHash made physically identical worlds hash differently across branches | Branching test showed hash divergence | Separate stateHash (physics) from traceHash (history) | `determinism.test.ts`, `branching.test.ts` |
| 4 | **Pending provenance identity** | Provenance node IDs in PendingEntry made stateHash depend on submission order, not physics | State hash divergence on reordered interventions | Move cause IDs to `pendingCauses` (trace side, excluded from stateHash) | `determinism.test.ts` |
| 5 | **Config compatibility bug** | Two runs with different tuning produced indistinguishable provenance (KE gap) | Hash comparison test | Include config in stateHash | `determinism.test.ts` |
| 6 | **Abandoned-future sequence bug** | Rewind did not properly record intervention IDs in abandoned timeline | Branching test showed missing lineage | Record interventionIds in AbandonedTimeline | `branching.test.ts` |
| 7 | **Event identity collision** | Event ID depended on total history length, not per-tick position | Replay test showed different IDs | Ordinal resets each tick; ID = content hash | `determinism.test.ts` |
| 8 | **Cursor position shifting on eviction** | Array-index cursors silently repositioned consumers onto different facts (measured: 2 facts skipped, no gap) | Retention test with eviction | Cursors reference streamSeq, never array positions | `retention.test.ts` |
| 9 | **False/vacuous tests** | Tests that pass without actually testing the intended behavior | Test review during P-005 | Rewrite tests with concrete assertions | All test files |
| 10 | **Incorrect assumptions in external-consumer tests** | Tests assumed shrine destruction affects economy prices (different domain) | P-008 adversarial pass | Fix tests to match actual domain semantics | `temporal-semantics.test.ts` |
| 11 | **Feedback-loop modelling defect** | Inherited boundary pressure was being relayed, causing double-counting across regions | Feedback pass identified leak | Separate "inherited" (boundary) from "generated" (new) pressure; only primary+generated propagate | `propagation.ts`, `feedback.test.ts` |
| 12 | **Over-declared diagnostics/bounds** | Diagnostics and bounds were declared but not enforced or tested | Review during P-007 | Implement and test all declared diagnostics | `retention.test.ts`, `feedback.test.ts` |

---

## §12 — Independent Review Gap

### Oracle Attempts

| Attempt | Result | Reason |
|---------|--------|--------|
| Architecture review | **Failed** | Insufficient API credits |
| Code review | **Failed** | Insufficient API credits |
| Simplification review | **Failed** | Insufficient API credits |

### What Was Self-Reviewed

All 496 tests were written and reviewed by the orchestrator agent. The following were self-reviewed:
- All architectural decisions (quota, locality, retention, hashing)
- All test scenarios (determinism, stress, feedback, persistence, branching, events, attribution)
- All defect discoveries and fixes
- All API design choices

### Why Independent Review Remains Desirable

- Self-review cannot catch blind spots in architectural reasoning
- A second perspective on the quota/locality trade-off would increase confidence
- The convergence detection model is novel and could benefit from external validation
- The stateHash/traceHash separation is a critical design decision that warrants independent verification

### Whether This Blocks Integration

**No.** The 496 tests provide substantial evidence of correctness. The architectural decisions are documented and traceable. The defect history shows a rigorous discovery process. Independent review would increase confidence but is not required for a controlled integration experiment.

---

## §13 — Architecture Decision

```
CE ARCHITECTURE:
  ACCEPTED WITH CAVEATS

GAME INTEGRATION:
  CONDITIONAL GO

UNREAL:
  NOT YET READY
```

### Justification

**CE Architecture = ACCEPTED WITH CAVEATS**

The architecture is well-defined, bounded, and tested. The causal model (quota + locality + propagation + convergence) is proven to work correctly across 496 tests. The public API is minimal and stable. The persistence model is sound.

Caveats:
- Convergence detection requires tuning per game
- Attribution is bounded (maxNodes = 500); very large graphs may be incomplete
- Single-platform proof only (Node.js, Windows)
- PoC scale (3 towns, 20 NPCs)

**Game Integration = CONDITIONAL GO**

CE can serve as the causal world layer underneath a real game, provided:
- The adapter remains thin (translate → submit → consume → project)
- The game engine handles rendering, physics, input, audio, networking
- The integration starts with a controlled experiment (§15)
- Performance is validated at game frame rates before shipping

**Unreal = NOT YET READY**

No Unreal adapter exists. The PoC adapter uses TypeScript/Node.js. An Unreal adapter would require:
- C++ or Blueprint integration with CE's checkpoint/restore API
- Performance validation at 60fps game loop
- Cross-platform deterministic execution verification
- This is a future gate (Gate B, §14)

---

## §14 — Integration Gates

### Gate A — Real-Time Local Game Loop

**Pre-requisites:**
- CE `advance()` completes within 16ms (60fps budget) for the game's world size
- Event consumption does not stall the render loop
- Checkpoint/restore completes within 100ms

**Tests required:**
- `advance(n)` benchmark: measure p50/p95/p99 latency for n = 1, 10, 100
- Event throughput: events/sec under sustained load
- Checkpoint latency: serialize + deserialize time

**Exit criteria:**
- `advance(1)` < 16ms at p95
- No dropped frames during sustained simulation
- Checkpoint/restore < 100ms

### Gate B — Unreal Adapter

**Pre-requisites:**
- Gate A passed
- C++ or Blueprint wrapper for CE's public API
- Checkpoint serialization compatible with Unreal's save system

**Tests required:**
- Adapter round-trip: submit intervention in Unreal → CE processes → events returned
- Checkpoint: save in Unreal → load in CE → verify stateHash
- Performance: advance() at game frame rate from Unreal's game loop

**Exit criteria:**
- Full intervention → event pipeline works from Unreal
- Checkpoint/restore works across Unreal save/load
- No frame drops from CE integration

### Gate C — Cross-Platform Execution

**Pre-requisites:**
- CE compiled/run on target platforms (Windows, Linux, macOS, console)
- IEEE-754 compliance verified (same seed + same interventions → same stateHash)

**Tests required:**
- Cross-platform determinism: run same scenario on each platform, compare stateHash
- Floating-point edge cases: test with known problematic values

**Exit criteria:**
- stateHash identical across all target platforms for the same input

### Gate D — Multiplayer

**Pre-requisites:**
- Gate A passed
- Network synchronization model defined (authoritative server? peer-to-peer?)
- Conflict resolution for concurrent interventions

**Tests required:**
- Two clients submit interventions → server merges → both see same world
- Disconnect/reconnect: client resumes from last checkpoint
- Latency: intervention → world update → event delivery within acceptable delay

**Exit criteria:**
- All clients see identical world state after convergence
- No data loss on disconnect/reconnect

### Gate E — Distributed Simulation

**Pre-requisites:**
- Gate D passed
- Region partitioning across processes/nodes
- Cross-region boundary signal propagation over network

**Tests required:**
- Regions split across nodes → boundary signals propagate correctly
- Node failure → regions rebalanced without data loss
- Consistency: all nodes agree on world state after synchronization

**Exit criteria:**
- Consistent world state across distributed nodes
- No causal order violations

---

## §15 — First Real-Game Experiment

### Scenario

```
3 towns (RF, HT, PS)
2 factions (Merchant Guild, Wardens)
1 trade route (grain_road: RF ↔ HT)
1 warehouse (grain_warehouse: RF)
1 shrine per town (town_shrine)
5 resources (grain, iron, cloth, timber, herbs)
~20 NPCs (farmers, merchants, guards, artisans)
Player destroys bridge (grain_road)
```

### Responsibilities

| Component | Owns |
|-----------|------|
| **Unreal** | Rendering (towns, NPCs, infrastructure), input (player clicks bridge), audio, UI (prices, unrest, faction attitudes) |
| **CE** | Causal simulation (pressure → quota → resolution → events), persistence (save/load), attribution (why did prices change?) |
| **Adapter** | translateIntent (click → destroy_infrastructure), consumeAndProject (events → GameView), checkpoint management |

### What Crosses the Adapter

| Direction | Data |
|-----------|------|
| Unreal → CE | `Intervention { action: "destroy_infrastructure", target: "grain_road", location: "RF", magnitude: 0.8, causalDomains: [...] }` |
| CE → Unreal | `GameView { towns: { RF: { grainPrice, grainStock, unrest, tradeRouteIntact }, ... }, factions: { MG: { hostility }, WA: { hostility } } }` |
| CE → Unreal | `WorldEvent[]` (consumer facts: price_shock, trade_disrupted, hostility_changed, ...) |
| CE → Unreal | `Explanation` (for "why did prices change?" tooltip) |

### What Is Rendered

- Town view with infrastructure (bridge intact/destroyed)
- NPC behavior (merchants stop trading, farmers produce less)
- Price display (grain price increases in RF after bridge destruction)
- Faction attitudes (MG hostility increases)
- Unrest display (civic unrest may increase)
- "Why did this happen?" tooltip (powered by `explain()`)

### Success Criteria

1. **Causal chain visible**: Player destroys bridge → RF grain price increases → merchants become hostile → NPCs react
2. **Attribution works**: "Why are prices high?" → explain() returns bridge destruction as root cause
3. **Locality holds**: PS is barely affected (boundary signal decay)
4. **Persistence works**: Save mid-crisis → load → same world state (stateHash match)
5. **No frame drops**: CE advance() < 16ms at p95

### Metrics Measured

- `advance()` latency (p50, p95, p99)
- Event throughput (events/sec)
- Checkpoint/restore latency
- stateHash consistency across save/load cycles
- Player-facing latency (action → visible effect)
- Attribution accuracy (explain() returns correct root)

---

## §16 — Final Architectural Diagram

```
PLAYER
  ↓ input
GAME ENGINE (Unreal)
  ↓ rendering / physics / audio
  ↓
ADAPTER
  ├── translateIntent() → Intervention
  ├── consumeAndProject() → GameView
  ├── checkpoint management
  └── event consumption
  ↓
CE PUBLIC API (api/public.ts)
  ├── createEngine / createWorld
  ├── submitIntervention
  ├── advance / tick
  ├── factStream / stream
  ├── explain / attributeEvent
  ├── stateHash / traceHash
  ├── forkTimeline / rewindTo
  ├── checkpoint / restoreCheckpoint
  └── enforceRetention / classifyCursor
  ↓
CAUSAL SIMULATION (core/world.ts)
  ├── phase 0: merge pending → region ledgers
  ├── phase 1-4: heartbeats (economy, investment, factions, population)
  ├── phase 5: quota resolution (ledger ≥ threshold → domain resolver)
  │   ├── resolveEconomy → price shock, trade disruption
  │   ├── resolveEcology → production loss
  │   ├── resolveFaction → hostility, patrol demand
  │   └── resolveCivic → unrest
  ├── boundary signals → neighbours (BFS, decay, generation bound)
  ├── phase 6: decay unresolved entries
  ├── phase 7: dynamics (convergence classification)
  └── phase 8: collect events → enforce retention
  ↓
CAUSAL LEDGER (per region × domain)
  ├── pressure (unsigned magnitude)
  ├── valence (signed direction)
  ├── origin (primary / generated / boundary)
  └── generation (0 = player, bounded)
  ↓
QUOTA / LOCALITY
  ├── threshold check → fire or decay
  ├── contested detection (opposing causes)
  └── boundary propagation (hop-distance, decay, floor)
  ↓
REGIONAL PROPAGATION
  ├── RF ↔ HT (trade route)
  ├── HT ↔ PS (neighbor)
  └── signals decay by 0.3× per hop
  ↓
WORLD STATE (WorldState)
  ├── regions / entities / relations (physics)
  ├── events (bounded, canonical order)
  ├── provenance (bounded, multi-parent DAG)
  ├── dynamics (convergence traces)
  └── lineage (world → timeline → checkpoint)
  ↓
EVENT / PROVENANCE
  ├── WorldEvent { id, streamSeq, tick, ordinal, type, data }
  ├── ProvenanceNode { id, kind, label, parents }
  ├── Explanation { roots, nodes, paths, incomplete }
  └── EventAttribution { eventId, causeNodeId, causeAvailable }
  ↓
ADAPTER
  ├── consumeAndProject() → GameView
  ├── cursor management (streamSeq)
  └── gap detection (classifyCursor, describeGap)
  ↓
GAME ENGINE (Unreal)
  ↓
RENDERING / PRESENTATION

ERSISTENCE (parallel path):
  createCheckpoint → serializeCheckpoint → file/network
  restoreCheckpoint → deserializeCheckpoint → attachEngine
  compactHistory → stateHash unchanged, traceHash changes
```

---

## §17 — Final Answer

### What CE Is

A **deterministic causal world-simulation layer** for games. It takes player interventions, propagates consequences through a causal model (pressure → quota → resolution → events), and provides structured attribution ("why did X happen?"). It is designed to sit underneath a game engine, with a thin adapter translating between player intent and CE's causal model.

### What CE Is Not

- A game engine (no rendering, physics, input, audio)
- A general-purpose simulation framework (fixed 4-domain causal model)
- A real-time system (tick-based, not frame-synchronized)
- A distributed system (single-process, single-consumer)
- A multiplayer platform (no networking, no synchronization)

### What Has Been Proven

- Deterministic simulation with seed-based replay
- Causal quota as a budget governor
- Cross-region locality with distance-decay
- Feedback loop convergence detection
- Persistent state with checkpoint/restore
- Deterministic branching and rewind
- Event-stream contract with retention and gap detection
- Causal attribution via provenance DAG traversal
- Game-shaped adapter using only public API
- 496 tests across 13 test files, all passing

### What Remains Unproven

- Real-time performance at game frame rates
- Cross-platform deterministic execution
- Multiplayer synchronization
- Large-scale simulation (beyond 3 towns, 20 NPCs)
- Unreal integration
- Long-running game stability (hours/days of play)
- Concurrent intervention submission

### Why the Architecture Is Ready

The architecture is **well-defined, bounded, and tested**. Every component has clear responsibilities and documented interfaces. The public API is minimal (135 lines). The causal model is proven across 496 tests. The defect history shows a rigorous discovery process with mechanism-level fixes and regression coverage.

The key architectural decisions — causal quota, locality, convergence detection, stateHash/traceHash separation, bounded retention, provenance DAG — are all validated by tests and documented in the reconnaissance record.

### Recommended Next Task

**Gate A: Real-Time Local Game Loop Benchmark**

Before any Unreal integration, validate that CE can operate within a game's frame budget:
1. Create a benchmark harness that calls `advance(1)` in a loop
2. Measure p50/p95/p99 latency for the PoC world (3 towns, 20 NPCs)
3. Validate event throughput under sustained load
4. Confirm checkpoint/restore latency is acceptable

This is the minimum evidence needed to confirm CE can serve as a real-time causal layer.

---

## Verification

- [x] `tsc --noEmit` clean (0 errors)
- [x] `vitest run` — 496/496 tests pass, 13 test files
- [x] No source changes except documentation (P-009 is synthesis only)
- [x] No new tests (496 existing tests provide sufficient evidence)
- [x] Git status recorded (see below)

### Git Status

```
Modified:   docs/RECONNAISSANCE.md (§23 — P-008 findings)
Modified:   src/api/public.ts (P-007 exports)
Modified:   src/core/events.ts (P-007 stream function)
New file:   src/poc/attribution-windowing.test.ts (P-007 tests)
New file:   src/poc/temporal-semantics.test.ts (P-008 tests)
```

### Open QMS Gaps

1. No independent oracle review (API credits exhausted)
2. Cross-platform determinism not verified
3. Real-time performance not benchmarked
4. Large-scale simulation not tested
5. No Unreal adapter exists

### Known Architectural Caveats

1. Convergence detection requires tuning per game
2. Attribution bounded by maxNodes (500); very large graphs may be incomplete
3. Single-platform proof only (Node.js 22.23.2, Windows)
4. PoC scale (3 towns, 20 NPCs, 5 resources)
5. Single-file checkpoint serialization (no incremental saves)
