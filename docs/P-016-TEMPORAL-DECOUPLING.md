# P-016: Continuous Game-Loop / Temporal Decoupling Adversarial Pass

**Date:** 2026-08-31
**Status:** COMPLETE — CE simulation time and game rendering time are decoupled without weakening causal correctness
**Question answered:** *Can the game run at a smooth render cadence while CE remains the sole causal authority, without temporal ambiguity, dropped consequences, duplicated actions, or visual states that falsely imply causal events?* **YES.**

---

## 1. Temporal Architecture Assessment

The load-bearing property is the **DeliveryState / WorldState separation** (P-012, §19): delivery
bookkeeping lives OUTSIDE the world and is never hashed. This makes rendering cadence
*observational only* by construction — no poll/ack/resync call can change stateHash/traceHash.

Adversarial testing confirms this holds under every attack in the mission: cadence matrix A–H,
intervention bursts, event batches of any size, reconnects, gaps, restarts, and failure
injection. The two API surfaces (`public.ts` operations) are sufficient for a game to recover
from every failure mode through the public contract alone — no CE internals required.

## 2. Clock / Authority Model

Three independent clocks, documented precisely:

| Clock | Owns | Does NOT own |
|-------|------|--------------|
| **T_ce** (CE tick, `state.tick`) | causal state, intervention acceptance/rejection, causal contributions, hashes (stateHash/traceHash), RNG | rendering, event visibility timing |
| **T_adp** (adapter cadence, poll/ack calls) | event visibility, cursor position, recovery decisions | causal state, hashes |
| **T_render** (Godot frame) | rendering, animation, interpolation, input | anything causal |

Submission rule: interventions may arrive at **any** time relative to ticks (queued by the
adapter, applied by CE synchronously at submit). Event visibility is entirely T_adp. Rendering
and interpolation are T_render only — and there is **no API path** for a rendered or
interpolated value to enter CE as authoritative state (proven in §5 below).

## 3. Cadence Stress Results

All five cadence configurations plus the three structural cases (F/G/H) were compared against a
headless reference (same interventions, advance everything, poll at end):

| Case | CE ticks | Render frames | stateHash match | traceHash match | facts delivered | duplicates |
|------|----------|---------------|-----------------|-----------------|-----------------|------------|
| A: CE60/render60 | 18 | 18 (1/frame) | ✓ | ✓ | all, once, in order | 0 |
| B: CE20/render60 | 18 | 54 (1/3) | ✓ | ✓ | all, once, in order | 0 |
| C: CE10/render60 | 18 | 108 (1/6) | ✓ | ✓ | all, once, in order | 0 |
| D: CE60/render20 | 18 | 6 (3/frame) | ✓ | ✓ | all, once, in order | 0 |
| E: CE60/render10 | 18 | 3 (6/frame) | ✓ | ✓ | all, once, in order | 0 |
| F: burst between ticks | 18 | 1 (all at once) | ✓ | ✓ | all, once, in order | 0 |
| G: ticks between frames | 18 | 3 (6/frame, no poll mid) | ✓ | ✓ | all, once, in order | 0 |
| H: idle frames, no tick | 0 | 10 | ✓ (unchanged) | ✓ | none (no new facts) | 0 |

**Conclusion:** no causal event skipped, none duplicated, canonical (delivery) order preserved,
interventions applied exactly once, stateSync authoritative, final hashes identical to the
headless reference in every configuration.

## 4. Intervention Timing Findings

**Sequential vs same-tick batch — ordering IS semantically meaningful.**

Empirically verified: `I1→tick→I2→tick→I3→tick` (spread over ticks 0/7/13) produces a
DIFFERENT world than `I1,I2,I3` all at tick 0 (grain price 28.87 vs 40 after 18 ticks). This is
correct behavior: kill at tick 0 vs tick 7 changes which agents exist when dynamics run, and
contributions merge into ledgers in different ticks. **Neither timeline is "wrong"; they model
different causal histories.**

**When ordering is irrelevant:** within a single tick, `submitBatch` provides canonical
(arrival-independent) order sorted by intervention id. Same batch in any arrival order →
identical world. An adapter applying a network frame's worth of actions should use `submitBatch`
for order-insensitive semantics, or document explicit ordering for order-sensitive ones.

**Rejected interventions** (unknown action, wrong target type, target already destroyed):
- never consume a sequence (`interventionSeq` unchanged; next valid intervention gets the SAME seq)
- never appear as a game action (no event)
- never alter stateHash or traceHash (provenance node rolled back)
- never produce a causal event

## 5. Event Batching Findings

- **One CE tick → multiple events:** bridge destruction emits trade_disruption + price_shock +
  food_availability + hostility_increase across regions — all delivered in one poll, in order.
- **Multiple ticks → one poll:** 5 ticks' worth of facts delivered in a single batch, canonical order, no gaps.
- **Batch boundaries are transport artifacts, not causal boundaries:** polling per-tick vs per-5-ticks delivers identical fact sets in identical order.
- **Reconnect → duplicate delivery:** at-least-once guarantee; `attempt` counter increments;
  consumer dedupes by event id — no double-application.
- **Gap → stateSync → resync → resume:** eviction below the cursor yields an explicit `gap`
  (never a silent empty poll); recovery via `stateSync` + `resync` repositions the cursor;
  post-resync events flow normally.
- **stateSync is a LEVEL snapshot:** adopting it never replays history (`historyComplete` flags
  whether history exists); current state is authoritative.

## 6. Interpolation Decision

**Authoritative vs presentation values:**

| Value | Status |
|-------|--------|
| `stateSync.regions[RF].grainPrice`, snapshot prices | authoritative simulation state |
| interpolated 10 → 10.5 → 11 → 12 → 13 between ticks | visual interpolation (T_render only) |
| market color, bridge visibility, merchant positions | presentation-only state |

**Contract decision: CE exposes no setter for any numeric state.** The only mutation paths are
typed interventions (`destroy_infrastructure`, `kill_entity`, …), `tick`, `advance`, `restore`.
An interpolated value therefore *cannot* feed back into CE — there is no function that accepts
one. Verified: interpolating a signal (read-only projection) does not alter causal propagation,
hashes, replay, checkpoint bytes, or event attribution. No contract change needed; the existing
API already structurally prevents interpolation feedback.

## 7. Discrete-Event Animation Contract

```
CE fact:     bridge destroyed at tick 42   ← authoritative causal time
animation:   bridge-collapse animation during frames 2520–2540  ← presentation only
```

- Each event carries a stable `id` and the authoritative `tick` at which causality occurred.
- A renderer MAY animate an event over many frames; the animation must be keyed to
  `event.id` + `event.tick`, never to frame numbers, and must not imply the causal transition
  happened at a different CE tick.
- **Delayed ack is safe:** a renderer animating 30 frames before acking changes nothing in CE —
  the world advances regardless; ack is observational.
- The CE fact's tick is the only truth about WHEN causality happened; frame numbers are T_render.

## 8. Restart / Reconnect Findings

**CE restart while rendering** (`render → checkpoint → shutdown → restore → continue → render`):
- Restored world has identical stateHash AND traceHash (authoritative state + history preserved).
- Deterministic continuation: advancing N more ticks from the restored world produces the same
  hashes as an uninterrupted run.
- No duplicate historical events: the restored record is identical (same event count).
- The renderer resynchronizes through the public contract only: restore world, restore delivery
  cursor, resume polling. A new post-restart intervention produces new facts, delivered normally.

**Reconnect without restart:** disconnect blocks polls (`disconnected` status); reconnect resumes
from the cursor with nothing lost (within retention).

**Renderer restart:** a fresh consumer can recover via `stateSync`+`resync` OR by polling
(within retention) — both are public-contract operations. No CE internals needed.

## 9. API Changes

Two changes, both motivated by the adversarial findings:

1. **`stream()` now returns delivery order (ascending streamSeq), matching `poll()`.**
   *Finding:* `poll()` delivered in streamSeq (emission) order, but `stream()` returned
   canonicalCompare order — the two adapter read paths could disagree on within-tick ordering,
   so a consumer reading history via `stream()` and live events via `poll()` would see different
   orders. Fixed in `src/core/events.ts`; `factStream` remains the canonicalCompare audit view.
   All 623 tests (including pre-existing `stream()` tests) pass with the fix.

2. **`submitBatch` added to the public API surface** (`src/api/public.ts`).
   *Finding:* canonical same-tick batch ordering existed in core but was not exported; a game
   adapter had no public way to apply a network frame's actions deterministically. Now exported
   and contract-tested.

No other API ambiguity was found. The existing contract (9 core operations + delivery ops)
already provides everything needed for temporal decoupling.

## 10. Remaining Runtime Risks

1. **~50–65 ms Godot HTTPRequest overhead** per request (P-014/P-015) — the binding constraint
   for per-frame polling at 60 fps. HTTP is adequate at 5–20 Hz; the WebSocket decision is
   deferred per mission (see P-017).
2. **Pre-existing tsc debt** in 7 PoC tool files (P-011 baseline + P-012/13) — none touched by
   this pass; `npm run check` is not yet green repo-wide (cleanup recommended as low-risk lane).
3. **`enforceRetention` at tiny limits** forces gaps quickly — correct per design, but an adapter
   must poll within the retention window or adopt `stateSync` promptly.
4. **Checkpoint round-trip helper** (`roundTripCheckpoint`) used in tests is a test-only helper;
   production code paths (server, adapter) perform the same steps — worth a shared utility later.

## 11. Recommended P-017

**WebSocket event push decision gate.** The HTTP polling architecture has now been proven
adequate for turn-based/strategy cadence (5–20 Hz) across the full temporal-decoupling matrix.
The remaining question is whether per-frame (60 fps) world-data needs justify a WebSocket
channel. P-017 should: (a) measure whether the 50–65 ms HTTP overhead actually degrades a
60 fps strategy-game loop at 5–20 Hz polling (it did not in P-015: render FPS stayed 83–88);
(b) if degradation is real, implement WebSocket push on `ce-server.ts` + Godot WebSocket client
with the P-016 temporal contract enforced; (c) otherwise close the WebSocket question with the
HTTP architecture retained. Also recommended: clean the 7-file tsc debt and promote the
checkpoint round-trip helper into the public API.

## Files (new/changed this pass)

- `src/poc/temporal-boundary.test.ts` — **44 tests** covering §1–§10 (cadence matrix, timing, batching, interpolation, animation, restart, failure injection, determinism)
- `src/core/events.ts` — `stream()` delivery-order fix (P-016 finding)
- `src/api/public.ts` — `submitBatch` exported (P-016 finding)
- `docs/P-016-TEMPORAL-DECOUPLING.md` — this report
- `docs/RECONNAISSANCE.md` — §26 appended
- QMS: `VER-2026-016`, `REQ-2026-013`

## Verification Evidence

- 623/623 CE tests pass (579 existing + 44 new)
- Cadence matrix A–H: all match headless reference (stateHash + traceHash)
- Determinism: identical hashes across all cadence configs and independent re-runs
- Sequential vs batch: semantically different (grain 28.87 vs 40) — documented, both deterministic
- Rejected interventions: no seq, no event, no hash change (4 test cases)
- Reconnect/restart/gap recovery: all through the public contract only
- `tsc`: P-016 adds zero new errors (my files clean; 7 pre-existing files unchanged)
