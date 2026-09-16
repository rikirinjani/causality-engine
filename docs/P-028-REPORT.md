# P-028: Persistence Resurrection Experiment — Report

**Status: COMPLETE — 13/13 PASS on both hosts, cross-host checkpoint portability verified.**
**Date: 2026-09-16**
**Commits: `ef2ded2` → `3045258` → `8f19480` → `2d426b4` → `7198b5f`**
**Baseline: `c5b3659` (P-027)**

---

## 1. Objective

Test CE's persistence boundary under actual process destruction: can a serialized world be
restored in a **fresh process** and produce the **same deterministic causal future** as an
uninterrupted control?

This goes beyond the existing in-process persistence tests (`src/poc/persistence.test.ts`) and
the single §17.3 process-boundary test: P-028 systematically probes every dimension of the
persistence contract — state, trace, RNG, retention boundaries, provenance, forks, rewinds,
pending work, multi-world isolation, repeated resurrection, and schema safety.

## 2. Falsifiable Predictions

| Dim | Prediction | Result |
|-----|-----------|--------|
| A | Basic resurrection: restored world matches control stateHash + traceHash + tick | ✅ PASS |
| B | Trace continuity: traceHash matches after continuation (causal history preserved) | ✅ PASS |
| C | Checkpoint before retention boundary resurrects identically | ✅ PASS |
| D | Checkpoint after retention boundary resurrects identically | ✅ PASS |
| E | `historyTruncated` flag survives the round-trip | ✅ PASS |
| F | Provenance/resolution counts match after resurrection (no fabricated ancestry) | ✅ PASS |
| G | Checkpoint identity integrity preserved through serialize/restore | ✅ PASS |
| H | Forked branches remain divergent after resurrection, each matching its own control | ✅ PASS |
| I | Rewind resurrection: checkpoint-based rewind follows the checkpoint, not the abandoned future | ✅ PASS |
| J | Pending (unresolved) causal work survives resurrection | ✅ PASS |
| K | Multi-world resurrection: two worlds resurrect independently without cross-contamination | ✅ PASS |
| L | Repeated resurrection (checkpoint → restore → checkpoint → restore) remains deterministic | ✅ PASS |
| schema | Invalid persistence data rejected; valid data accepted | ✅ PASS |

## 3. Environments

| Host | OS | Arch | Node | Duration |
|------|----|------|------|----------|
| Vultr VX1 | Ubuntu 26.04.1 LTS | x86_64 (AMD EPYC) | v22.23.2 | 14,691ms |
| Vultr Windows | Windows Server | AMD64 (host `EA`) | v22.23.2 | 67,310ms |

Both hosts ran the identical harness (`scripts/p028/p028-persistence-resurrection.ts`, seed 42).

## 4. Cross-Host Control Hash Parity

All 13 dimensions produced **byte-identical control hashes** on both hosts (0 mismatches).
Example (dimension A, tick 50): `stateHash 206457cd63240432…` identical on VX1 and Windows.

This re-confirms P-025's 7-environment determinism result at the persistence layer.

## 5. Cross-Host Checkpoint Transfer (the strongest claim)

A checkpoint serialized on one OS, transferred to the other, and restored in a fresh process
produces a **byte-identical future**:

| Direction | Producer | Resumer | stateHash @ tick 80 | traceHash | rngState |
|-----------|----------|---------|--------------------|-----------|----------|
| Win → Linux | Windows, tick 50 | VX1 Linux, +30 ticks | `8ae5e33e28dc173c…` | `b93f995343440955…` | `s=1337604970` |
| Linux → Win | VX1 Linux, tick 50 | Windows, +30 ticks | `8ae5e33e28dc173c…` | `b93f9953…` | `s=1337604970` |

**A CE checkpoint is a portable artifact, not a host-local artifact.** This is the property a
real save-game system needs: a player's save must resume identically on any machine.

## 6. Harness Architecture

Four files in `scripts/p028/`:

- **`p028-control-worker.ts`** — creates a world, applies interventions at specified ticks,
  advances uninterrupted, outputs hashes + world metrics as JSON.
- **`p028-producer-worker.ts`** — same, but stops at `produceTick`, serializes a checkpoint to
  a file, outputs metadata. Supports `--compact <ticks>` to force `compactHistory` before
  serializing (used by dimE).
- **`p028-resumer-worker.ts`** — runs in a **fresh process**: loads the checkpoint file,
  deserializes, restores, attaches a new engine, continues advancing, outputs hashes.
- **`p028-persistence-resurrection.ts`** — orchestrator: spawns workers via `execFileSync`,
  compares control vs persistence hashes per dimension, emits `__SUMMARY_JSON__`.

Interventions are passed via `--iv-file <path>` (temp JSON file) to avoid shell quoting issues.
All workers use **identical intervention IDs** (`iv-<kind>-<tick>`) so `interventionHistory`
— which is part of `traceHash` — matches across control/producer/resumer.

## 7. Failures Encountered and Fixed (all harness bugs, zero engine defects)

| # | Symptom | Root cause | Fix | Commit |
|---|---------|-----------|-----|--------|
| 1 | `ERR_MODULE_NOT_FOUND` | Space in `Causality Engine` path split by `shell: true` | Relative paths + `cwd` | `4b0c8ee` |
| 2 | JSON args mangled on Windows (`[{tick:5,...}]`) | cmd.exe strips quotes from argv | `--iv-file` temp files | `4b0c8ee` |
| 3 | 8/13 after fix — interventions silently dropped | Orchestrator passed raw JSON in argv; workers expected `--iv-file <path>` flag | Pass the path as flag | `ef2ded2` |
| 4 | traceHash mismatches in A/B/J/L | Worker-specific ID prefixes (`ctrl-`/`prod-`/`resumer-`) leaked into `interventionHistory` → different traceHash | Identical `iv-<kind>-<tick>` IDs | `3045258` |
| 5 | dimE "producer did not truncate" | `compactHistory` on an intervention-free world has ~1 provenance node — nothing to prune | Give producer real causal history before compaction | `8f19480` |

**Key insight from #4:** intervention IDs are part of causal identity (`interventionHistory` is
hashed into `traceHash`). Two worlds with identical physics but different intervention labels
are *correctly* different traces. This is CE working as designed — the harness was wrong, not
the engine.

**Key insight from #5:** `compactHistory` is honest — it only sets `historyTruncated` when
there is actually history to prune. Verified separately (probe26/29) that a genuinely truncated
world round-trips the flag correctly through serialize → deserialize → restore.

## 8. Engine Properties Verified

1. **State completeness**: every field needed to continue the simulation survives the round-trip
   (tick, rngState, lineage, config, regions, entities, relations, pending work, provenance,
   resolution log, diagnostics, intervention history, retention boundaries).
2. **Trace completeness**: the causal history (provenance graph, resolution decisions, emitted
   facts, intervention history) is preserved bit-for-bit — `traceHash` matches.
3. **RNG continuity**: the serialized RNG state (`{s: uint32}`) resumes bit-identically.
4. **Retention honesty**: `historyTruncated`, `oldestRetainedSeq`, `evictedCount` all survive;
   a restored world never claims more history than it has.
5. **Fork/rewind semantics**: divergent branches stay divergent; rewind follows the checkpoint.
6. **Pending work**: unresolved causal pressure (pendingContributions/pendingCauses) survives.
7. **Multi-world isolation**: two worlds resurrect independently (extends P-027 to the
   persistence boundary).
8. **Schema safety**: malformed checkpoints are rejected with structured errors, not crashes.

## 9. Performance

| Host | Total | Per-dimension avg | Slowest dimension |
|------|-------|-------------------|-------------------|
| VX1 Linux | 14.7s | ~1.1s | H/K multi-worker (~1.7s) |
| Windows | 67.3s | ~5.2s | H/K multi-worker (~8.0s) |

Windows is ~4.6x slower (shared vCPU burst), but results are identical — determinism is
independent of host speed.

## 10. Threats to Validity

- **Single seed (42)**: all dimensions use the default seed. P-026/P-027 already covered
  seed-divergence families extensively; P-028's question was the persistence boundary, not
  seed sensitivity.
- **Tick counts are modest** (≤630): retention-limit overflow (500 events) is never hit
  naturally; dimE forces truncation via `compactHistory` instead. Natural-overflow resurrection
  is covered by dimC/dimD boundary logic and P-026's 750-unit campaign.
- **Worker spawn overhead** dominates runtime; this does not affect correctness claims.

## 11. Deliverables

- `scripts/p028/p028-control-worker.ts` — control worker
- `scripts/p028/p028-producer-worker.ts` — producer worker (with `--compact`)
- `scripts/p028/p028-resumer-worker.ts` — fresh-process resumer worker
- `scripts/p028/p028-persistence-resurrection.ts` — orchestrator (13 dimensions)
- `docs/P-028-VX1-SUMMARY.json` — VX1 run 4 full JSON summary
- `docs/P-028-WIN-SUMMARY.json` — Windows run full JSON summary
- `Agentic Layer/qms/records/verifications/VER-P028-2026-09-16-020000.json` — QMS verification
- PM-1 traces: `p028-vx1-rerun.pm1`, `p028-windows-crosshost.pm1`

## 12. Conclusion

**CE's persistence boundary is sound.** A serialized world restored in a fresh process — on the
same host or a different OS — produces the same deterministic causal future as an uninterrupted
control, across all 13 tested dimensions. Zero engine defects were found; every failure
encountered during the campaign was a harness bug, each fixed and re-verified.

This closes the last open question from the P-025 external validation: the checkpoint format is
not only versioned and validated (schema safety) but **semantically complete** — resurrection
is indistinguishable from continuation.