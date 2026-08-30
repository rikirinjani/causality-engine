# Causality Engine (CE)

**Deterministic causal world-simulation layer for games** — derived conceptually from [Kronos Engine](../Kronos%20Engine), not a fork.

> Traditional game logic asks: *what happens when the player presses the button?*
> Causality Engine asks: **what changed in the world because the player pressed the button?**

CE does not render, animate, or handle input. It **remembers and propagates consequences**.

```
GAME ENGINE  (Unreal / Unity / Godot / custom)
     ↑  rendering / physics / input
     │     ADAPTER  — player interventions → world state → events
     ↓
CAUSALITY ENGINE  — factions, economy, resources, events, persistence
```

## Status

Under active research. The simulation core is deterministic and reproducible:

* `seed + interventions + config → identical world` (SHA-256 `stateHash` / `traceHash`)
* Cross-tick deterministic RNG (mulberry32, O(1) register capture)
* Pure tick phases, no wall-clock, no `Math.random`

See [`docs/RECONNAISSANCE.md`](docs/RECONNAISSANCE.md) for the full architectural record — 20 sections covering quota, locality, tick model, agent design, and all verification evidence.

## What CE currently proves

* **Causal quota as a budget governor** — player pressure accumulates per-region/per-domain and crosses a threshold to trigger a resolution; cost tracks causal activity, not world size.
* **Causal locality** — regions are simulation partitions; a disruption in Region A hurts neighbours with distance-decayed boundary signals and leaves distant regions alone.
* **Deterministic branching & rewind** — `checkpoint` / `restore` / `fork` / `rewind` with explicit genealogy (`World` → `Timeline` → `Checkpoint`), across a real process boundary.
* **Feedback & convergence** — a discrete-recurrence loop (grain supply → price → profitability → investment → capacity → supply) with six classified outcomes: `converged`, `converged_at_bound`, `oscillating`, `diverging`, `settling`, `cutoff`.
* **History lifecycle** — provenance is bounded without changing `stateHash`; retention is explicit; schema migration is versioned and lossless where possible.
* **Event-stream contract** — facts (`fact` vs `internal`), timeline-scoped deterministic ids, canonical per-tick total order, at-least-once delivery with idempotent consumers, explicit `gap` + `resync_from_state`.

No Unreal, networking, multiplayer, or LLM integration yet — by design.

## Quick start

```bash
npm install
npm run check     # tsc --noEmit
npm test          # vitest — 305 tests (as of 2026-08-31)
npm start         # tiny deterministic world demo (3 towns / 2 factions / 5 resources)
npx tsx src/poc/stress.ts    # multi-intervention stress harness (Experiments A–G)
npx tsx src/poc/feedback.ts  # feedback & convergence driver
npx tsx src/poc/persistence.ts  # persistence & branching evidence
npx tsx src/poc/events.ts    # event-stream evidence
npx tsx src/poc/lifecycle.ts # compaction / retention evidence
npx tsx src/poc/sweep.ts     # quota parameter sweep (48 cells)
```

## Project layout

```
src/core/        — deterministic engine (world, RNG, hash, event bus, retention, lifecycle)
src/game/        — generic game domains (economy, factions, ecology, civic, investment)
src/poc/         — evidence drivers + regression suites (determinism, stress, feedback, …)
docs/RECONNAISSANCE.md — the architectural record (read this first)
```

## Ancestor

CE treats Kronos Engine as its architectural ancestor — reusing the domain-independent patterns (seeded RNG, snapshots, diff, adapters, strict TypeScript) while discarding Earth-specific content and redesigning persistence, branching, and the quota model for interactive worlds.

## License

TBD.
