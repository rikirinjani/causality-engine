# Handoff Bundle — CE Hash Fix (NCR-2026-001)

Assembled 2026-10-16 from the 2026-10-08 session. Start with `SESSION-HANDOFF-2026-10-08.md`.

| Path | What | Origin |
|---|---|---|
| `SESSION-HANDOFF-2026-10-08.md` | Session handoff (status, open items, next options) | moved from `docs/` |
| `KAGGLE-ASTRA-BENCHMARK-GUIDE.md` | How to run Astra review benchmarks on Kaggle | moved from `docs/` |
| `records/complete-repro-record.json` | Reproducer RED run on pre-fix code — `collides: true` | moved from repo root |
| `records/redgreen-record.json` | Red/green run — `collides: false` | moved from repo root |
| `records/persistence-checkpoint.json` | Checkpoint snapshot from persistence-equivalence run | moved from repo root |
| `qms/2026-10-02-012000-ncr-hashing-proto-key.json` | NCR-2026-001 record | **copy** — canonical in `Agentic Layer/qms/records/nonconformities/` |
| `qms/2026-10-02-012500-VER-2026-001-ast-ra-stack-review.json` | VER-2026-001 (Astra stack review) | **copy** — canonical in `Agentic Layer/qms/records/verifications/` |
| `qms/2026-10-02-060000-VER-2026-002-hash-fix-kaggle.json` | VER-2026-002 (Kaggle verification, PASS) | **copy** — canonical in `Agentic Layer/qms/records/verifications/` |

## Not in this folder

- **Source and tests** (`src/core/hash.ts`, `src/poc/*.test.ts`, `src/poc/proto-complete-repro.ts`), `README.md` and `docs/COMPATIBILITY.md` stay where they are, because the build depends on them. They are committed at `1f08620`.
- **Kaggle kernel staging dirs** (`%TEMP%\opencode\ce-fix*`, `ce-review`). These were already deleted from temp. Kaggle has the only copies. The links are in the handoff doc.
- **Re-running the reproducers** (`proto-complete-repro.ts`, `proto-redgreen.ts`) writes fresh records to the current working directory, not to this folder.
