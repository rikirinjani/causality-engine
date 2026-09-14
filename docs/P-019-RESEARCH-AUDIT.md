# P-019: Research Artifact & Paper-Evidence Audit

**Date:** 2026-08-31
**Status:** COMPLETE — **RESEARCH-FREEZE RECOMMENDED**
**Purpose:** Not to make CE larger — to determine whether we know enough about CE to write about
it honestly. Answer: **yes, with explicit boundaries.**

Machine-readable ledger: `docs/P-019-EVIDENCE-LEDGER.json` (12 claims → tests → experiments →
results → artifacts).

---

## 1. Evidence Base (definitive)

| Measure | Value |
|---------|-------|
| Test files | 18 (all under `src/poc/`, integration-level) |
| Tests passing | **660/660** (definitive, `npx vitest run`) |
| tsc new errors | **0** (7 pre-existing P-011-era tool files unchanged) |
| retrace | **clean** |
| Schema version | 7 |
| EVENT_RETENTION_LIMIT | 500 |
| PROVENANCE_LIMIT / RESOLUTION_LOG_LIMIT | 4000 / 4000 |
| CE-relevant failure records | 11 (design history — disclosed, strengthens) |
| CE verification records | VER-2026-014..018 (P-014..P-018) + VER-2026-019..025 (base passes) |

No new causal features, transports, or optimizations were added in this pass (read-only audit +
regression).

## 2. Invariant Documentation (12 claims, all SUPPORTED)

Each chain: claim → invariant → falsifiable test → result → artifact.

### C01 — stateHash vs traceHash semantics
- **Claim:** stateHash reflects authoritative world state; traceHash reflects history.
- **Invariant:** stateHash excludes event history and delivery state; eviction changes traceHash, never stateHash.
- **Tests:** retention.test.ts (51, §20.16 hashes), temporal-semantics.test.ts, events.test.ts, determinism.test.ts.
- **Result:** eviction changes traceHash only; hashes reproducible across runs.
- **Artifacts:** RECONNAISSANCE §19/§20; failures `events-in-statehash-category-error`, `provenance-ids-leak-into-state-identity` (disclosed design history).
- **Strength: SUPPORTED.**

### C02 — Deterministic continuation
- **Claim:** same seed + interventions + tick schedule → identical state, hashes, RNG, decisions.
- **Invariant:** simulation is a pure function of (config, interventions, schedule); RNG lives in WorldState.
- **Tests:** determinism.test.ts (14), temporal-boundary.test.ts §9/10 (cadence matrix A–H), vertical-slice.test.ts §1, ws-boundary.test.ts P3.
- **Result:** identical hashes across cadences, transports, and 5+ replay runs (replay hash `ebaa28a3`).
- **Artifacts:** P-016/P-017/P-018 reports; VER-2026-016..020.
- **Strength: SUPPORTED.**

### C03 — Persistence & process-boundary restoration
- **Claim:** checkpoint survives process death; restore → byte-identical state + deterministic continuation.
- **Invariant:** checkpoint serializes full WorldState (incl. RNG); restore + attachEngine resumes identically.
- **Tests:** persistence.test.ts (40), branching.test.ts (21), lifecycle.test.ts (46), runtime-boundary.test.ts §5/§9, vertical-slice.test.ts §3.
- **Experiments:** `resume-worker.ts` (§17.3), `retention-worker.ts` (§20.14).
- **Result:** restored world continues byte-identically vs uninterrupted; RNG survives.
- **Strength: SUPPORTED.**

### C04 — Branching, rewind, convergence
- **Claim:** timelines fork/rewind; competing pressures converge deterministically without fabricating history.
- **Tests:** branching.test.ts (21), feedback.test.ts (47), temporal-semantics.test.ts (rewind), lifecycle.test.ts.
- **Result:** convergence deterministic; branching after compaction safe; rewind semantics verified.
- **Caveat:** VER-2026-021/022 accepted single-platform.
- **Strength: SUPPORTED (with single-platform caveat).**

### C05 — Provenance & attribution
- **Claim:** every tracked quantity attributable to originating interventions via `explain()`, preserving multi-parent causes.
- **Tests:** attribution-windowing.test.ts (31), temporal-semantics.test.ts, vertical-slice.test.ts §2.
- **Result:** `explain("RF:price:grain")` explained=true, roots include `destroy_infrastructure` (P-018); evicted attribution reported as truncated, never unexplained.
- **Strength: SUPPORTED.**

### C06 — Event identity, ordering, retention
- **Claim:** stable event identity; canonical delivery order (ascending streamSeq); bounded retention with detectable gaps.
- **Invariant:** event id = f(timeline, tick, ordinal, content); classifyCursor = caught_up/deliverable/gap.
- **Tests:** events.test.ts (53), retention.test.ts (51), temporal-semantics.test.ts, temporal-boundary.test.ts §4/§5.
- **Result:** ordering stable across eviction; gaps explicit, never silent.
- **Caveat:** EVENT_RETENTION_LIMIT=500 is a policy, not an evidence-backed optimum (VER-2026-025).
- **Strength: SUPPORTED (policy value caveated).**

### C07 — At-least-once delivery
- **Claim:** every retained fact delivered ≥ once; duplicates identifiable by stable id + attempt counter.
- **Tests:** events.test.ts, ws-boundary.test.ts P5, runtime-boundary.test.ts §4/§6.
- **Result:** reconnect redelivers retained events, deduped by id; duplicate poll without ack cannot double-apply.
- **Strength: SUPPORTED.**

### C08 — DeliveryState separation
- **Claim:** delivery bookkeeping outside WorldState; never affects stateHash/traceHash/simulation.
- **Tests:** retention.test.ts §20.7, runtime-boundary.test.ts §4, ws-boundary.test.ts P7/P8, temporal-boundary.test.ts §1.
- **Result:** 200 CE ticks at <10ms/tick with un-acked consumer; delivery ops never change hashes.
- **Strength: SUPPORTED.**

### C09 — Adapter/game authority boundary
- **Claim:** games project CE state but never simulate causality; CE is sole causal authority.
- **Tests:** adapter-hardening.test.ts (44), game-adapter.test.ts (32), external-consumer.test.ts (61); grep audits (P-015/017/018).
- **Result:** zero causal rules / zero RNG in all Godot slice code; adapter imports only the public surface.
- **Strength: SUPPORTED.**

### C10 — Transport independence
- **Claim:** HTTP and WS deliver identical semantics; transport never affects causality or hashes.
- **Tests:** ws-boundary.test.ts P3, runtime-boundary.test.ts §7, temporal-boundary.test.ts §9/10.
- **Experiment:** transport-benchmark.ts (in-process intervention 4.4× faster over WS; HTTP fine at 5–20 Hz).
- **Result:** identical hashes across HTTP/WS/direct.
- **Strength: SUPPORTED.**

### C11 — Cross-platform determinism
- **Claim:** identical hashes on Windows (x64) and macOS (arm64).
- **Tests/experiments:** cross-platform-determinism.ts (P-011); ws-boundary/vertical-slice/temporal suites run on both platforms.
- **Result:** `99be7427`/`5404d32e` identical on both; 24/24 + 13/13 pass on both.
- **Strength: SUPPORTED (tested scenarios; not exhaustive over every config).** *See over-strong audit.*

### C12 — Godot integration
- **Claim:** CE deterministically drives a visible interactive isometric game world.
- **Tests/experiments:** iso_verify.gd (16/16), ws_verify.gd (14/14); GUI on physical display with screenshots iso_A..F.
- **Result:** bridge destroyed → grain 10→13.13 → hostility 0.1→0.62, all CE-originated; explain() UI from CE.
- **Strength: SUPPORTED.**

## 3. Over-Strong Claims Audit (worded stronger than evidence)

| Claim | Issue | Precise replacement |
|-------|-------|---------------------|
| C11 "cross-platform determinism holds" | verified on 2 platforms for tested scenarios, not exhaustive | "holds for all tested scenarios on Windows x64 and macOS arm64; general claim requires the full suite cross-platform" |
| C06 retention "precise" + limit 500 | limit is a policy, not validated optimum | "retention semantics precise and bounded at the configured limit; the limit value (500) is a policy parameter, not an evidence-backed optimum" |
| C02 "determinism under all cadences/transports" | verified for matrix A–H + HTTP/WS/direct, not arbitrary | "holds for the tested cadence configurations and transports; rendering/poll cadence is observational for these cases" |

## 4. Non-Claims (explicit)

- **Exactly-once delivery is NOT claimed** — only at-least-once with id-dedup.
- **NOT a general-purpose game engine** — single-world, single-town vertical slice only.
- No multi-town, combat, NPC AI, quests, procedural generation, multiplayer, or LLM integration.
- `EVENT_RETENTION_LIMIT=500` is not claimed optimal; it is a bounded policy.
- **No formal proof of determinism** — determinism is empirically evidenced by reproducible hashes.
- WebSocket soak/lifecycle at production scale is NOT tested (functional + failure-injection only).
- No claim that the provenance ring (4000) never evicts; eviction is explicit and reported.
- No claim the adapter is a complete game-engine SDK; it is a reference boundary.

## 5. Remaining Limitations

1. **All 660 tests are integration-level under `src/poc/`** — `src/core/`, `src/api/`, `src/game/` have no unit tests. A paper should describe CE as evidenced through its public API, not per-module unit-tested.
2. **Cross-platform suite runs are partial**: full suite on Windows; WS/vertical-slice/temporal suites on macOS — not the entire suite on both.
3. **Performance numbers are hardware-specific** (Ryzen 3 4300U, Apple M4) and methodology-specific.
4. **tsc has 7 pre-existing errors** in P-011-era tool files (benchmark, headless, long-run, cross-platform-determinism, runtime-cadence, benchmark-investigation, runtime-boundary.test) — none touch the public API; flagged for a cleanup lane, not a blocker.
5. **P-010/P-011 have no dedicated doc files** — evidence is in scripts + QMS records only.
6. **Failure records (11 CE-relevant) must be disclosed** — they document how invariants were discovered adversarially; they strengthen rather than weaken the claims.
7. **Checkpoint chunking (P-018)** is a transport-level fix without a dedicated WS-boundary test yet.

## 6. Final Adversarial Regression (no new architecture)

- 660/660 tests pass (18 files).
- `tsc --noEmit`: 0 new errors.
- retrace: clean.
- No causal features, transports, or speculative optimizations added in this pass.

## 7. Recommendation: **RESEARCH-FREEZE**

CE has reached a defensible research-freeze point. All 12 architectural claims are supported by
falsifiable tests + experiments + artifacts; the design history (11 failure records) shows the
invariants were hardened adversarially; the full regression is green.

### Freeze boundary — FROZEN (change requires a new experiment):
1. stateHash/traceHash semantics and their separation
2. WorldState/DeliveryState separation
3. Event identity formula (timeline, tick, ordinal, content)
4. streamSeq canonical delivery order
5. at-least-once delivery contract + id-dedup
6. retention 3-state semantics + gap→stateSync→resync
7. intervention immediate-vs-deferred semantics
8. deterministic continuation via checkpoint/restore
9. provenance/attribution via explain()
10. branching/rewind/convergence semantics
11. adapter authority boundary (CE = sole causal authority)
12. schema version 7 wire format

### Freeze boundary — REQUIRES NEW EXPERIMENT:
- Any change to hashed state semantics (stateHash/traceHash inputs)
- Any change to event identity or streamSeq ordering
- Any change to delivery guarantees
- Any change to retention/gap semantics
- Any change to intervention timing semantics
- Any schema version bump
- Adding a third transport that changes the adapter contract
- Changing RNG or simulation math that alters hashes for existing scenarios

### Freeze boundary — ORDINARY IMPLEMENTATION ALLOWED:
- Adding game content (regions, entities, interventions within existing schemas)
- Adapter/scene code (Godot scenes, new UI, new input)
- Transport server implementation details that preserve semantics (chunking, buffering)
- Adding tests and evidence
- Calibrating config parameters without changing hashed semantics for the same config

**Next action:** write the research paper using the ledger as the evidence appendix. Any
post-freeze architectural change must first produce a falsifiable experiment and an updated
ledger entry.

## Files (new/changed this pass)

- `docs/P-019-EVIDENCE-LEDGER.json` — machine-readable claim→evidence ledger (created)
- `docs/P-019-RESEARCH-AUDIT.md` — this report (created)
- `docs/RECONNAISSANCE.md` — §29 appended
- QMS: `VER-2026-026`, `REQ-2026-016`
