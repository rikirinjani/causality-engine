# P-021: CE Productization Analysis

**Date:** 2026-09-02
**Status:** Analysis Complete
**Central Question:** Can a game developer integrate CE into their own game without understanding CE internals?

---

## 10. CE v1.0 Product Boundary

### CE Owns (Engine Authority)

| Responsibility | Description |
|---------------|-------------|
| World state | Stocks, prices, infrastructure, entities, relations |
| Causal rules | Domain-specific resolution logic (economy, factions, etc.) |
| Temporal state | Tick count, temporal ordering |
| Event generation | Deterministic outbound facts with streamSeq |
| Causal propagation | Pressure accumulation, quota resolution, boundary signals |
| Deterministic RNG | mulberry32 seeded PRNG, O(1) restore |
| Provenance | Multi-parent DAG tracking causal ancestry |
| Attribution / explain | BFS traversal from effects to intervention roots |
| Persistence | Checkpoint serialize/deserialize/validate/restore |
| Branching | Fork timelines from checkpoints |
| Rewind | Abandon future, resume past |
| Timeline identity | Content-derived IDs, lineage tracking |

### Game Owns (Presentation Authority)

| Responsibility | Description |
|---------------|-------------|
| Rendering | Visual representation of world state |
| Animation | Motion, transitions, visual effects |
| Physics presentation | Visual physics (not simulation physics) |
| Camera | Viewpoint control |
| UI | Player-facing interfaces |
| Player input | Keyboard, mouse, touch, gamepad |
| Audio | Sound effects, music |
| Game-specific presentation |任何 CE doesn't know about |

### Adapter Owns (Translation Authority)

| Responsibility | Description |
|---------------|-------------|
| Intent → intervention | Translate player actions to CE interventions |
| State → projection | Translate CE state to game-facing structures |
| Event consumption | Consume CE events and route to game systems |
| Reconnect/recovery | Handle transport disconnections |
| Transport handling | HTTP, WebSocket, or other transport |

### Authority Invariant

**CE is the sole authority for causality.** No causal rule, no RNG, no simulation logic may exist in the game or adapter. This is the P-019 frozen invariant #2.

---

## 11. Public API Audit

### Current API Surface (`src/api/public.ts`)

The current public API is organized into 7 groups:

#### CORE API (Game Developer)

```typescript
createEngine()                          // Create simulation engine
createWorld(config, engine)             // Create world from config
submitIntervention(world, intervention, engine)  // Queue player action
submitBatch(world, interventions, engine)        // Queue multiple actions
tick(world, engine)                     // Run one simulation tick
advance(world, engine, n)               // Run n ticks
snapshot(world)                         // Get world state projection
attachEngine(world, engine)             // Reattach engine to restored world
```

**Assessment:** Core API is minimal and sufficient for basic integration. The `Engine` type is opaque to consumers — they don't need to understand its internals.

#### TYPES API (Game Developer)

```typescript
WorldState, Intervention, InterventionTarget,
CausalContribution, DomainId, RegionId, EntityId,
ResourceId, WorldEvent
```

**Assessment:** Types are well-defined. `Intervention` has a clear structure with target, action, magnitude, and causal contributions.

#### CONFIGURATION API (Game Developer)

```typescript
DEFAULT_CONFIG, makeConfig, SimConfig
```

**Assessment:** Configuration is minimal. `makeConfig` accepts a seed and returns a `SimConfig`. No validation API for configs.

#### CHECKPOINT API (Adapter-Facing)

```typescript
createCheckpoint, serializeCheckpoint, deserializeCheckpoint,
validateCheckpoint, restoreCheckpoint, CheckpointEnvelope,
RestoreOptions, RestoredWorld
```

**Assessment:** Full checkpoint lifecycle is exposed. `serializeCheckpoint` produces a string that can be stored anywhere. `validateCheckpoint` checks schema version compatibility.

#### EVENTS API (Adapter-Facing)

```typescript
factStream, fullRecord, isConsumerFact, stream,
EventAttribution, attributeEvent
```

**Assessment:** Event consumption is exposed. `stream()` returns events in delivery order. `factStream` provides a simplified view.

#### HASH API (Adapter-Facing)

```typescript
stateHash, traceHash, configHash
```

**Assessment:** Hash functions are exposed for deterministic identity verification. `stateHash` excludes trace-side data; `traceHash` includes it.

#### PROVENANCE API (Adapter-Facing)

```typescript
explain, key, Explanation, RootCause, ProvenanceNode
```

**Assessment:** `explain()` is the primary attribution API. `key` provides quantity key helpers (price, stock, hostility, etc.).

#### DELIVERY API (Adapter-Facing)

```typescript
createDeliveryState, registerConsumer, poll, ack,
serializeDelivery, deserializeDelivery, stateSync, resync,
Cursor, ConsumerChannel, DeliveryState, PollResult, StateSync
```

**Assessment:** Full delivery lifecycle is exposed. This is adapter-facing and may be too complex for initial developer onboarding.

#### BRANCHING API (Adapter-Facing)

```typescript
forkTimeline, rewindTo, interventionsAfter, replayAbandoned,
checkpoint, BranchHandle, RewindResult
```

**Assessment:** Branching/rewind is fully exposed. `forkTimeline` creates a new timeline from a checkpoint. `rewindTo` abandons future and resumes past.

#### LIFECYCLE API (Adapter-Facing)

```typescript
classifyCheckpoint, canRewindTo, compactHistory,
recentWindowPolicy, RETAIN_ALL, RESUME_ONLY,
CheckpointClass, RetentionPolicy, CompactionReport, RewindVerdict
```

**Assessment:** Lifecycle management is exposed. This is for advanced use cases (checkpoint compaction, retention policy).

#### RETENTION API (Adapter-Facing)

```typescript
enforceRetention, classifyCursor, describeGap, retentionWindow,
RetentionWindow, RetentionGap, EVENT_RETENTION_LIMIT
```

**Assessment:** Retention is exposed for adapter developers who need to handle event gaps.

#### MIGRATION API (Adapter-Facing)

```typescript
migrateWorld, CURRENT_SCHEMA_VERSION, MIN_MIGRATABLE_SCHEMA_VERSION,
MigrationResult
```

**Assessment:** Schema migration is exposed. Version 7 is current.

### API Classification

| Category | Functions | Target Audience |
|----------|-----------|-----------------|
| **Stable Public** | createEngine, createWorld, submitIntervention, advance, snapshot, stateHash | Game developer |
| **Provisional** | submitBatch, explain, key, forkTimeline, rewindTo, checkpoint | Adapter developer |
| **PoC** | factStream, fullRecord, attributeEvent, interventionsAfter, replayAbandoned | Advanced adapter |
| **Internal** | compactHistory, classifyCheckpoint, canRewindTo, enforceRetention, describeGap | CE internals |
| **Migration** | migrateWorld, CURRENT_SCHEMA_VERSION | CE versioning |

### Gaps for v1.0

1. **No `loadWorld` function** — developers must use `deserializeCheckpoint` + `restoreCheckpoint` + `attachEngine`. Needs a convenience wrapper.
2. **No event subscription API** — developers must poll via `poll()`. Needs a callback/observable pattern.
3. **No world inspection API** — developers can't query specific regions or entities without deserializing the full state.
4. **No config validation** — `makeConfig` accepts any seed; no validation of config values.
5. **No typed intervention catalog** — interventions are free-form; no schema for game-specific actions.

---

## 12. Runtime/Package Model Recommendation

### Option A: Embedded/In-Process Library

**Pros:**
- Zero latency (function calls)
- No deployment complexity
- Simple debugging (single process)
- Natural for single-player games

**Cons:**
- Language lock-in (TypeScript only)
- No fault isolation (CE crash = game crash)
- No independent versioning
- No multiplayer/server path

### Option B: Standalone Runtime/Service

**Pros:**
- Language interoperability (any language via WS/HTTP)
- Fault isolation (CE process can restart independently)
- Independent versioning
- Natural for multiplayer/server
- Can run on separate machine

**Cons:**
- Network latency (WS/HTTP overhead)
- Deployment complexity (separate process)
- Debugging complexity (cross-process)
- Serialization overhead

### Option C: Both (Recommended)

**Primary: In-process library** for single-player games and prototyping.
**Secondary: Standalone service** for multiplayer, server, and cross-language scenarios.

**Rationale:**
- The current architecture already supports both (HTTP/WS transport is independent of CE core)
- The adapter boundary means the same CE code works in both modes
- Godot integration works in-process (GDScript calls TypeScript)
- Future Unreal integration would benefit from process boundary
- Developer should choose based on their needs, not CE's limitations

### v1.0 Recommendation

**Ship both.** The in-process library is the primary product. The standalone service is the secondary product. The adapter pattern makes this natural.

---

## 13. Developer Integration Workflow

### Ideal Developer Experience

```
1. Install CE (npm, Godot plugin, or binary)
2. Import CE API
3. Create engine + world
4. Map game actions → CE interventions
5. Advance simulation on game tick
6. Project CE state → game state
7. Consume events for feedback
```

### What the Developer Should NOT Need to Know

- CE internal propagation phases
- Provenance DAG structure
- Retention window mechanics
- Delivery state management
- Schema migration
- Checkpoint compaction
- Boundary propagation algorithms
- Quota threshold tuning (unless customizing)

### Current Friction Points

1. **Intervention format** — developers must construct `Intervention` objects with `causalDomains` and `provenance` fields. Needs a helper/builder.
2. **Event consumption** — developers must manage `DeliveryState`, `poll()`, `ack()`. Needs a simplified event stream.
3. **State projection** — developers must call `snapshot()` and parse the result. Needs a typed game-view projection.
4. **Checkpoint management** — developers must handle serialization, storage, and restoration. Needs a save/load wrapper.

---

## 14. Godot Adapter/Reference Strategy

### Current State

The Godot integration consists of:
- `ce_ws_adapter.gd` — WebSocket adapter (production)
- `ce_adapter.gd` — HTTP adapter (legacy)
- `iso_main.gd` — Isometric demo scene
- `iso_verify.gd` — Headless verification driver

### Reference Integration Architecture

```
CE Core (TypeScript)
    |
    +-- ce-ws-server.ts (WS server, standalone process)
    |
    +-- Godot Adapter (GDScript)
    |       |
    |       +-- ce_ws_adapter.gd (transport layer)
    |       +-- game-specific adapter (intent translation)
    |
    +-- Future: Unreal Adapter (C++ or Blueprints)
    +-- Future: Unity Adapter (C#)
    +-- Future: Custom Adapter (any language)
```

### Engine-Neutral vs Godot-Specific

| Component | Engine-Neutral | Godot-Specific |
|-----------|---------------|----------------|
| CE core | Yes | No |
| WS server | Yes | No |
| WS protocol | Yes | No |
| Intervention format | Yes | No |
| State projection | Yes | No |
| Event model | Yes | No |
| Adapter pattern | Yes | No |
| GDScript adapter | No | Yes |
| Scene structure | No | Yes |
| Rendering | No | Yes |
| Input handling | No | Yes |

### v1.0 Godot Deliverables

1. **Godot plugin package** — installable via Godot Asset Library
2. **Reference adapter** — `ce_ws_adapter.gd` as reference implementation
3. **Sample game** — minimal integration example
4. **Documentation** — Godot-specific integration guide

---

## 15. Versioning/Compatibility Contract

### Version Numbers

| Component | Version | Meaning |
|-----------|---------|---------|
| CE Schema | 7 (CURRENT) | WorldState structure version |
| CE API | 0.x (provisional) | Public API surface |
| CE Engine | 0.x (provisional) | Core simulation logic |
| WS Protocol | 1.0 (stable) | Message format between client/server |

### Compatibility Rules

1. **Schema version** — `migrateWorld()` handles forward migration. Old saves can be loaded if `schemaVersion >= MIN_MIGRATABLE_SCHEMA_VERSION`.
2. **API changes** — Minor version bumps for additive changes. Major version bumps for breaking changes.
3. **WS protocol** — Stable. Breaking changes require major version bump and client update.
4. **Deterministic compatibility** — Same seed + same config + same interventions → same stateHash. This is the core contract.

### What Breaks Determinism

- Changing domain resolution logic
- Changing propagation algorithms
- Changing quota thresholds
- Changing RNG implementation
- Changing tick phase order

### What Doesn't Break Determinism

- Adding new domains (backward compatible)
- Adding new event types (backward compatible)
- Changing retention policy (affects events, not state)
- Changing transport (affects delivery, not causality)
- Changing adapter logic (adapter is outside CE)

---

## 16. Persistence/Checkpoint Compatibility Policy

### Checkpoint Structure

A checkpoint contains:
- `identity` — checkpointId, timelineId, createdAt
- `world` — serialized WorldState
- `delivery` — consumer delivery state (optional)

### Compatibility Contract

1. **Same schema version** — checkpoint loads directly
2. **Older schema version** — `migrateWorld()` forward-migrates
3. **Newer schema version** — `validateCheckpoint()` rejects with clear error
4. **Corrupted checkpoint** — `validateCheckpoint()` rejects

### Storage Requirements

- Checkpoints must be stored as opaque strings (serialized JSON)
- No programmatic inspection of checkpoint internals by adapters
- Checkpoint IDs are content-derived (deterministic)

### Compaction

- `compactHistory()` reduces checkpoint size by pruning old events
- Compaction is optional and adapter-initiated
- Compacted checkpoints remain loadable

---

## 17. External-Consumer Integration Test

### Test Design

**Persona:** A game developer who knows TypeScript and Godot but has never seen CE internals.

**Given:**
- CE npm package (or equivalent)
- Public API documentation
- Godot adapter reference
- Sample game scaffold

**Task:** Implement a minimal game integration:
1. Create a world
2. Submit one intervention
3. Advance simulation
4. Render the result
5. Checkpoint and restore

### Expected Friction Points

| Step | Expected Friction | Severity |
|------|-------------------|----------|
| Create world | Low — `createEngine()` + `createWorld()` is clear | Low |
| Submit intervention | Medium — Intervention format requires `causalDomains` and `provenance` | Medium |
| Advance simulation | Low — `advance(world, engine, n)` is clear | Low |
| Render result | Medium — Must call `snapshot()` and parse regions/prices | Medium |
| Checkpoint/restore | High — Must manage serialize/deserialize/validate/restore cycle | High |
| Event consumption | High — Must manage DeliveryState, poll, ack | High |
| Branching | High — Must manage checkpoints, fork, rewind manually | High |

### Productization Work Items (from friction analysis)

1. **Intervention builder** — `createIntervention(action, target)` with sensible defaults
2. **Event stream** — Simplified callback-based event consumption
3. **Game view projection** — Typed adapter that projects CE state to game-specific structures
4. **Save/load wrapper** — `saveGame(world)` / `loadGame(data)` convenience functions
5. **Branching wrapper** — `forkGame(checkpoint)` / `rewindGame(checkpoint)` convenience functions

---

## 18. Documentation Architecture

### Required Documentation Set for v1.0

```
1. Getting Started
   - Installation
   - Quick start (5-minute integration)
   - Core concepts (world, intervention, tick, event)

2. Architecture
   - System overview diagram
   - Authority boundary (CE vs game vs adapter)
   - Causal propagation model
   - Determinism model

3. Runtime API
   - Core API reference
   - Types reference
   - Configuration reference

4. Event Model
   - Event types
   - Event consumption
   - Delivery guarantees
   - Gap handling

5. Interventions
   - Intervention format
   - Causal contributions
   - Domain-specific effects
   - Intervention builder

6. Persistence
   - Checkpoint create/serialize/restore
   - Save/load workflow
   - Schema migration
   - Compaction

7. Branching & Rewind
   - Fork workflow
   - Rewind workflow
   - Timeline comparison
   - Use cases (sandbox, rewind, alternate history)

8. Determinism
   - Determinism contract
   - What breaks determinism
   - Cross-platform validation
   - Testing determinism

9. Adapter Development
   - Adapter pattern
   - Transport selection (HTTP vs WS)
   - State projection
   - Event routing

10. Godot Integration
    - Plugin installation
    - Reference adapter
    - Sample game
    - Troubleshooting

11. Deployment
    - In-process deployment
    - Standalone service deployment
    - Docker/container deployment

12. Compatibility
    - Versioning policy
    - Schema migration
    - Checkpoint compatibility
    - Upgrade guide

13. Troubleshooting
    - Common issues
    - Debug logging
    - Performance profiling
```

---

## 19. v1.0 Productization Backlog

### P0 — Must Have for v1.0

| # | Item | Effort | Rationale |
|---|------|--------|-----------|
| 1 | Intervention builder helper | Small | Reduces developer friction for core use case |
| 2 | Simplified event stream | Medium | Current poll/ack model is too complex for most games |
| 3 | Save/load convenience wrapper | Small | Checkpoint cycle is too verbose |
| 4 | Getting Started documentation | Medium | Essential for developer adoption |
| 5 | Godot plugin package | Medium | Primary integration target |
| 6 | API reference documentation | Medium | Essential for developer adoption |

### P1 — Should Have for v1.0

| # | Item | Effort | Rationale |
|---|------|--------|-----------|
| 7 | Game view projection helper | Medium | Reduces state parsing friction |
| 8 | Branching convenience wrapper | Small | Simplifies fork/rewind workflow |
| 9 | Config validation | Small | Prevents silent misconfiguration |
| 10 | Typed intervention catalog | Medium | Prevents free-form intervention errors |
| 11 | Architecture documentation | Medium | Essential for developer understanding |
| 12 | Sample game (Godot) | Large | Primary evidence of developer workflow |

### P2 — Nice to Have for v1.0

| # | Item | Effort | Rationale |
|---|------|--------|-----------|
| 13 | World inspection API | Medium | Useful for debugging |
| 14 | Callback-based event subscription | Medium | Alternative to polling |
| 15 | Docker deployment guide | Small | Deployment flexibility |
| 16 | Performance profiling guide | Small | Optimization guidance |

---

## 20. Definition of "CE v1.0"

### CE v1.0 is:

1. **A deterministic causal simulation layer** that games consume through a defined adapter boundary
2. **A stable public API** that game developers can use without understanding CE internals
3. **A reference Godot integration** demonstrating end-to-end gameplay
4. **A documentation set** enabling independent developer adoption
5. **A backward-compatible schema** with migration support
6. **A reproducible build** with deterministic replay verification

### CE v1.0 is NOT:

1. A game engine (it doesn't render, animate, or handle input)
2. A general-purpose simulation framework (it's game-focused)
3. A multiplayer server (single-process, single-consumer)
4. A content pipeline (it simulates, doesn't create content)
5. An academically validated theory (it's an empirically tested implementation)

### v1.0 Acceptance Criteria

- [ ] Public API is stable and documented
- [ ] Intervention builder reduces developer friction
- [ ] Event stream is simple to consume
- [ ] Save/load wrapper works end-to-end
- [ ] Godot plugin installs and runs
- [ ] Getting Started guide enables 5-minute integration
- [ ] All 685 tests pass
- [ ] Deterministic replay verified across platforms
- [ ] No frozen invariants violated
