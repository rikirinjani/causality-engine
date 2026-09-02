# P-025: External Release Validation — Falsifiable Predictions

**Written BEFORE any P-025 change.** Date: 2026-09-02
**Candidate:** CE `1.0.0-rc.1` at commit `236ac45`
**Frozen invariants:** 12 (P-019) — must remain unchanged

P-024 held the release on two gates: the package is not published, and no
independent developer has used CE. These predictions test whether those gates can
be closed.

Each states an observable outcome and what would refute it.

---

## P1 — Publish readiness

**Prediction:** A clean rebuild produces a tarball byte-identical in *contents*
to the P-024 audited artifact, and the audit passes again.

**Reference:** 162 entries, `dist/api/product.{js,d.ts}` present, nine exclusion
patterns absent.

**Test:** `rm -rf dist`, `npm pack`, `bash scripts/audit-tarball.sh`.

**Falsified if:** entry count differs, any exclusion pattern appears, or any
required path is missing.

---

## P2 — npm publication

**Prediction:** `1.0.0-rc.1` can be published to npm, after which
`npm install causality-engine@1.0.0-rc.1` succeeds from a machine with no CE
repository.

**Test:** `npm publish --access public`, then install from the registry in a
clean directory and run the clean-consumer suite.

**Falsified if:** publication cannot be performed, or the installed package fails
the consumer suite.

**Known risk:** neither the Mac mini nor the Windows machine has npm credentials.
If publication cannot be performed, this prediction is **falsified**, not
deferred. The blocker will be documented with the exact command required, and the
release state will remain **NOT PUBLISHED**. Publication will not be simulated,
and npm availability will not be claimed.

---

## P3 — Hosted CI

**Prediction:** The CI workflow authored in P-024 executes green on GitHub-hosted
runners across the full matrix.

**Test:** Observe a real hosted run — engine matrix (3 OS × 2 Node), package
build with tarball audit and clean-consumer install, boundary audits.

**Falsified if:** any job fails, or the only evidence is local execution.

Three claims are kept distinct and only the third counts here: **CI authored**,
**CI locally reproduced**, **CI executed on hosted infrastructure**.

---

## P4 — Godot addon independently downloadable

**Prediction:** The addon can be obtained from a public URL without cloning the
CE repository, and a clean Godot project installed from that download completes
the documented integration on all three tested versions.

**Test:** Attach the addon to a GitHub release; download the asset by URL into a
directory that has never contained CE; run the integration on Godot 4.3, 4.4,
4.7.2.

**Falsified if:** the asset cannot be published, the download is incomplete, or
any tested version fails.

---

## P5 — Independent developer validation

**Prediction:** One developer who did not build CE completes the minimal
integration — install, connect, one intervention, observe a causal consequence,
demonstrate persistence — using only the published artifact and documentation,
with no author assistance.

**Test:** Recruit such a developer. Provide only the package, the documentation
URL, and the task. Observe without guiding. Debrief afterwards.

**Falsified if:** no such developer is available, they cannot complete the task,
or they require author assistance to proceed.

**Known risk:** no independent developer is currently identified. If none
participates, this prediction is **falsified**. A blind self-test is not a
substitute and will not be presented as one. Independent validation will not be
manufactured.

---

## P6 — Cross-platform determinism at wider coverage

**Prediction:** The deterministic replay baseline `5404d32e` reproduces on
platform/runtime combinations beyond the two previously documented (macOS arm64,
Windows x64).

**Test:** Observe replay output from each hosted CI job.

**Falsified if:** any platform produces a different hash.

This is an *observation* of existing behaviour under wider conditions, not a
change to any engine claim. If confirmed, the documented determinism evidence is
strengthened; the formal-proof non-claim remains.

---

## P7 — No release-blocking developer-experience defects

**Prediction:** After P-024's documentation fixes, no P0 (prevents completion) or
P1 (requires unexplained knowledge or author intervention) friction remains in
the install-to-first-connection path.

**Test:** Re-walk the corrected documentation against the actual distribution
channel that ends up available.

**Falsified if:** any P0 or P1 item is found.

---

## P8 — Frozen invariants survive the release pass

**Prediction:** No engine file changes. All 12 invariants hold.

**Test:** `git diff HEAD -- src/core src/game src/api src/poc` empty;
`verify:invariants` passes; replay matches `5404d32e`.

**Falsified if:** any engine diff appears or any invariant check fails.

---

## Non-predictions (explicitly out of scope)

- Asset Library acceptance (external review, not a packaging task)
- security of the WS runtime beyond localhost
- performance characteristics
- Godot 4.5 / 4.6 support
- any change to CE causal semantics

---

## Honesty rules for this pass

These are binding, and they are the reason P-024 held:

1. **No manufactured external validation.** If no independent developer
   participates, P5 is falsified and reported as such.
2. **No claimed npm availability before publication.** If credentials are
   missing, the state is NOT PUBLISHED.
3. **No hosted-CI claim from local execution.** Only an observed hosted run
   counts.
4. **No silent conversion of a failed prediction into a success.**
5. **No test weakened to make a release pass.**

## Defect classification

| Class | Handling |
|-------|----------|
| packaging / documentation / adapter / API ergonomics / deployment | fix in this pass |
| **genuine CE semantic defect** | STOP, report, do not modify frozen architecture |

## Release rule

Recommend `1.0.0` only if: public installation succeeds, the published artifact
matches the audited artifact, hosted CI is green, Godot distribution is verified,
at least one independent developer completes the integration, no P0/P1 remains,
all 12 invariants hold, and no unsupported claim is introduced.

Otherwise retain `1.0.0-rc.1` and state exactly what remains.
