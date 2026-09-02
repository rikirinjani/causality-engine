# P-024: v1.0.0 Release Candidate Validation — Results

**Date:** 2026-09-02
**Candidate:** CE `1.0.0-rc.1`
**Decision:** **HOLD** — remain at `1.0.0-rc.1`
**Frozen invariants:** 12/12 unchanged

Predictions were written before any release change in
[P-024-PREDICTIONS.md](./P-024-PREDICTIONS.md).

---

## 1. Prediction outcomes

| # | Prediction | Outcome | Evidence |
|---|-----------|---------|----------|
| P1 | Package integrity | **CONFIRMED** (after fixing a build defect) | 162-entry tarball; 9 exclusion patterns absent, 14 required paths present |
| P2 | Clean installation | **CONFIRMED** | `/tmp/ce-consumer` outside the repo; `npm install <tarball>` succeeded; `src/` absent from `node_modules` |
| P3 | Godot compatibility | **CONFIRMED** for 4.3, 4.4, 4.7.2 | 23/23 on each; three versions actually executed |
| P4 | Documentation sufficiency | **FALSIFIED, then fixed** | Blind walkthrough exposed 5 documentation defects; all corrected |
| P5 | Runtime reproducibility | **CONFIRMED** | Clean consumer reproduced `10.00 → 13.13` and `5404d32e` exactly |
| P6 | CI reproducibility | **PARTIAL** | Workflow authored; every step verified locally from a clean checkout. **Not executed on a hosted runner.** |
| P7 | Deployment clarity | **CONFIRMED** | `DEPLOYMENT.md` covers all 11 required items; security limitation stated plainly |
| P8 | Artifact provenance | **CONFIRMED** | `repository`/`homepage`/`bugs` metadata added; tarball shasum recorded |

One prediction falsified (P4), one partial (P6). Both recorded rather than
reframed.

---

## 2. Distribution channels

Four distinct states, deliberately not conflated:

| State | TypeScript runtime | Godot addon |
|-------|-------------------|-------------|
| **Artifact exists** | Yes — `causality-engine-1.0.0-rc.1.tgz`, 184.0 kB | Yes — `godot/addons/causality_engine/` |
| **Publicly downloadable** | No — not on npm | Partially — via git clone only |
| **Indexed / discoverable** | No | No — not in the Asset Library |
| **Reviewed by a third party** | No | No |

Chosen v1.0 channels: **npm** for the runtime, **repository + release tag** for
the addon. Asset Library submission is deferred; it is an external review process,
not a packaging task, and the addon layout is already Asset-Library-shaped.

---

## 3. Package artifact inspection

```
name:          causality-engine
version:       1.0.0-rc.1
filename:      causality-engine-1.0.0-rc.1.tgz
package size:  184.0 kB
unpacked size: 698.1 kB
shasum:        3a73849fe128c3f3641d17dea7a2b0e077dd1106
total files:   162
```

`bash scripts/audit-tarball.sh` → **RESULT: PASS**

| Must NOT be present | Status |
|---------------------|--------|
| `package/src/` | absent |
| `*.test.*` | absent |
| `package/docs/P-0*` | absent |
| `RECONNAISSANCE` | absent |
| `godot-iso` | absent |
| `*.png` | absent |
| `package/examples/` | absent |
| `package/scripts/` | absent |
| `node_modules` | absent |

All 14 required paths present, including `dist/api/product.{js,d.ts}`, the six
addon files, eight product documents, `CHANGELOG.md`, `README.md`, `LICENSE`.

Credential-shaped filename scan: clean.

---

## 4. Clean installation results

Consumer at `/tmp/ce-consumer`, outside the CE tree, containing only a bare
`package.json` and one test file.

```
npm install ./causality-engine-1.0.0-rc.1.tgz
added 1 package, and audited 2 packages in 512ms
found 0 vulnerabilities
```

Installed contents: `CHANGELOG.md`, `LICENSE`, `README.md`, `dist`, `docs`,
`godot`, `package.json`. **`src/` absent** — the consumer cannot reach engine
source even if it wanted to.

No build step required. `prepack` ran the build during `npm pack`, so the
consumer received compiled output.

---

## 5. Clean consumer results

`scripts/clean-consumer.mjs` imports **only** from `causality-engine/product`.

```
=== RESULTS: 51 passed, 0 failed ===
```

Sixteen stages: import surface, catalog discovery, config validation, create and
inspect, checkpoint, intervene, idempotent rejection, advance, event consumption
with ordering and ack, consequence observation, explanation, save/load
determinism, fork, alternate intervention, comparison, rewind, cross-run
determinism.

Reference values reproduced exactly: initial grain `10.00`, after destroy + 5
ticks grain `13.13` and `stateHash` `5404d32e`, 11 observable differences between
branches, save/load continuation identical.

---

## 6. Godot compatibility matrix

Three versions **actually downloaded and executed**, not inferred.

| Version | Build | Result |
|---------|-------|--------|
| **4.3** | `4.3.stable.official.77dcf97d8` | **23/23** |
| **4.4** | `4.4.stable.official.4c311cbee` | **23/23** |
| **4.7.2** | `4.7.2.stable.official.ed1daf0bf` | **23/23** |

Every version completed all twelve stages: addon loads, `CeClient` initialises,
connection succeeds, snapshot projects, checkpoint captures, intervention
accepted, advance, events arrive, price rises `10.00 → 13.13`, explanation rooted
in `destroy_infrastructure`, rewind, fork, comparison.

### Honest labelling

| Label | Versions |
|-------|----------|
| **Tested** | 4.3, 4.4, 4.7.2 |
| **Expected compatible** | 4.5, 4.6 — same `WebSocketPeer` API, not executed |
| **Untested** | anything below 4.3 (will not load; API absent) |

4.5 and 4.6 are not claimed as supported.

---

## 7. CI results

`.github/workflows/verify.yml` — three jobs:

| Job | Steps |
|-----|-------|
| **engine** | 6-way matrix (ubuntu/windows/macos × node 20/22): `npm ci`, `check:dist`, `test`, `verify:replay`, `verify:invariants` |
| **package** | build, `npm pack`, tarball content audit, clean-consumer install and run, artifact upload |
| **boundary** | addon RNG audit, product-layer RNG/wall-clock audit, developer-path audit, causal-authority audit |

Every step was verified locally against a clean checkout:

| Step | Local result |
|------|-------------|
| `npm ci` equivalent | Pass (blind clone) |
| `check:dist` | Pass, 0 errors |
| `npm test` | 746/746 |
| `verify:replay` | `5404d32e` matches |
| `verify:invariants` | All pass |
| tarball audit | PASS |
| clean-consumer | 51/51 |
| boundary audits | Pass |

**Not executed on a hosted runner.** The workflow is authored and its logic
verified locally; whether GitHub Actions runs it green is a separate, untested
claim. This is the honest reading of P6.

---

## 8. Mac mini verification

Recorded **separately** from clean-environment verification, so the Mac mini's
accumulated state cannot be mistaken for evidence of reproducibility.

| Check | Result |
|-------|--------|
| Test suite | 746/746 |
| `check:dist` | 0 errors |
| Replay | `5404d32e` matches P-014 |
| Invariant check | All pass |
| Godot 4.3 / 4.4 / 4.7.2 | 23/23 each |

**Mac mini is not a release dependency.** The blind test cloned the public repo
into `/tmp/blind` and built from scratch. The clean consumer installed a tarball
into `/tmp/ce-consumer`. Neither used repository state, and no credential or
machine-specific configuration was committed.

---

## 9. Deployment documentation

`docs/DEPLOYMENT.md` — all eleven required items covered: Node requirement,
verified versions, port, bind address, startup command, configuration, checkpoint
storage, reconnect behaviour, local setup, production considerations, security
limitation.

Security stated without hedging:

> **The CE WebSocket runtime has no authentication.** It binds `127.0.0.1` by
> default. If you bind it to any other interface, anything that can reach the
> port can create worlds, submit interventions, read full world state, and fork
> timelines. There is no credential, no token, no origin check, and no rate
> limit. Adding authentication and transport security is **not part of CE v1.0.**

Includes a pre-exposure checklist, all of whose items CE does not provide.

---

## 10. Troubleshooting documentation

`docs/TROUBLESHOOTING.md` — nine sections drawn from problems actually hit during
P-022/P-023/P-024, not invented: installation, CE runtime, Godot addon, events
and delivery, interventions, checkpoints, timelines, explanation, determinism.

Includes the real cases: `EADDRINUSE` on 7778, the `is_connected` collision,
`ERR_MODULE_NOT_FOUND` from CommonJS consumers, missing `dist/` after clone, and
the rewind-hash asymmetry that is correct behaviour rather than a bug.

---

## 11. External developer test

**No external developer was available. No external validation is claimed.**

A strict blind protocol was executed instead: follow only what the documentation
states, in the order it states it, using no repository knowledge.

### Blind walkthrough

| Step | Documented instruction | Outcome |
|------|----------------------|---------|
| 1 | `npm install causality-engine` | **FAILED — npm 404.** Not published. |
| 2 | `git clone` + `npm install` | Succeeded |
| 3 | `npm run serve` | Failed with `EADDRINUSE` (a runtime was already up) |
| 4 | `npm run build` | Emitted `dist/`, but printed pre-existing `src/poc` type errors |
| 5 | `mkdir addons && cp -r` | Succeeded — but `addons/` had to be created first |
| 6 | Paste the "Verify" snippet | Loaded, but a headless run never exits |
| 7 | Corrected snippet | `CE connected: ws-12`, `connection_open=true` |

### Recorded friction

| # | Friction | Severity | Resolution |
|---|----------|----------|-----------|
| F1 | `npm install causality-engine` 404s | **High** | Added a prominent "Not yet published" notice; documented `npm pack` + local-tarball install |
| F2 | `EADDRINUSE` not explained where it occurs | Medium | Added the case inline at the `npm run serve` step |
| F3 | `npm run build` printed errors that look like failures | Medium | Documented that `src/poc` tooling is not shipped; pointed to `check:dist` / `verify:release` |
| F4 | `addons/` does not exist in a new project | Low | Added `mkdir -p` |
| F5 | Verify snippet never exits headless | Medium | Rewrote it with an explicit exit and expected output |
| F6 | No blank `project.godot` provided | Low | Not fixed — creating a Godot project is Godot's onboarding, not CE's |

**Time to first successful connection: ~8 minutes**, of which roughly 5 were
spent on F1 and F5.

Five of six friction points were documentation defects and are fixed. P4 was
genuinely falsified before correction.

---

## 12. Package metadata

| Field | Status |
|-------|--------|
| `name` | `causality-engine` |
| `version` | `1.0.0-rc.1` |
| `description` | Present, states the authority boundary |
| `license` | Apache-2.0, `LICENSE` shipped |
| `repository` | **Added this pass** |
| `homepage` | **Added this pass** |
| `bugs` | **Added this pass** |
| `main` / `types` | `dist/api/product.js` / `.d.ts` |
| `exports` | Three entry points: `.`, `./product`, `./engine` |
| `files` | 13-entry allowlist |
| `engines` | `node >= 20` |
| `keywords` | 9 relevant terms |
| `CHANGELOG.md` | **Added this pass** |
| `README.md` | Present |
| `prepack` | **Added** — guarantees a build before packing |

Nothing cosmetic was added.

---

## 13. Defects discovered

### D1 — `npm run build` shipped proof-of-concept code (packaging, fixed)

`build` ran bare `tsc`, which compiled **everything** including `src/poc` and all
tests: 129 `poc` files, 60 compiled test files, 2.7 MB `dist/`. Type errors in
poc tooling also meant emit succeeded only by accident.

Fixed with `tsconfig.build.json` — includes only `src/api`, `src/core`,
`src/game`, `src/product`; excludes `src/poc` and `**/*.test.ts`; sets
`noEmitOnError: true`. Result: **144 files, 888 KB, zero test files, zero poc
files.**

The pre-existing 90-line `tsc --noEmit` baseline is unchanged and unhidden. Bare
`npm run check` still reports it; `check:dist` typechecks what ships.

### D2 — Five documentation defects (fixed)

F1–F5 above. Each was a real blocker or real confusion during the blind
walkthrough.

### D3 — Missing release metadata (fixed)

No `repository`, `homepage`, `bugs`, `CHANGELOG.md`, or `prepack`. All added.

### Classification

| Class | Count |
|-------|-------|
| Packaging defect | 1 (D1) |
| Documentation defect | 5 (D2) |
| Runtime/deployment defect | 1 (D3) |
| **Genuine CE semantic defect** | **0** |

No engine file was touched. `git diff HEAD -- src/core src/game src/api src/poc`
is empty for this pass.

---

## 14. Frozen-invariant audit

| # | Invariant | Status |
|---|-----------|--------|
| 1 | CE is sole causal authority | Unchanged |
| 2 | No causal rules outside CE | Unchanged |
| 3 | No RNG outside CE | Unchanged |
| 4 | Deterministic replay | Unchanged — `5404d32e` |
| 5 | Temporal decoupling | Unchanged |
| 6 | WS is transport, not causal channel | Unchanged |
| 7 | Godot = rendering only | Unchanged |
| 8 | Adapter = translation only | Unchanged |
| 9 | `explain()` uses CE attribution | Unchanged |
| 10 | Branching preserves lineage | Unchanged |
| 11 | Checkpoint/rewind are CE operations | Unchanged |
| 12 | State hash is deterministic | Unchanged |

Verified structurally: no engine diff, no addon diff, `verify:invariants` passes,
replay matches the P-014 baseline.

---

## 15. Exact verification counts

| Check | Count | Result |
|-------|-------|--------|
| CE test suite | 746 tests, 20 files | **746 passed** |
| `check:dist` | shippable code | **0 errors** |
| `tsc --noEmit` (full, incl. poc) | — | 90 lines, unchanged baseline |
| Replay smoke | 1 | `5404d32e` matches P-014 |
| Invariant check | 5 assertions | all pass |
| Product API tests | 61 | pass (within the 746) |
| Clean consumer | 51 assertions | **51 passed** |
| Godot 4.3 | 23 assertions | **23 passed** |
| Godot 4.4 | 23 assertions | **23 passed** |
| Godot 4.7.2 | 23 assertions | **23 passed** |
| Medieval slice | 19 assertions | 19 passed (P-023) |
| Tarball audit | 24 checks | **PASS** |
| Blind walkthrough | 7 steps | 6 friction points recorded |

Total automated assertions this pass: **746 + 51 + 69 = 866**, all passing.

---

## 16. Release decision: **HOLD**

`1.0.0-rc.1` remains the current release candidate.

### Why not release

All automated tests pass. That was never sufficient. Two of the three claims a
`1.0.0` makes are still unsupported by evidence:

**1. "You can install this."** You cannot. `npm install causality-engine` returns
404. The blind walkthrough failed at step one. Everything works — via a git clone
and a locally built tarball. That is not what a `1.0.0` implies.

**2. "This has been used by someone other than its author."** It has not. Every
one of the 866 assertions was written by the party that wrote the code. The blind
protocol was a disciplined substitute and it did find five real documentation
defects — but a person who genuinely does not know the system will find different
ones. Publishing `1.0.0` while claiming external validation would be
manufacturing it.

**What is genuinely ready:** the artifact, its contents, its metadata, the three
tested Godot versions, the documentation set, and the verification suite. The
engineering is done. The distribution is not.

---

## 17. Remaining blockers to `1.0.0`

| # | Blocker | Severity | What closes it |
|---|---------|----------|----------------|
| B1 | Not published to npm | **High** | `npm publish`; confirm `npm install causality-engine` works from a clean machine |
| B2 | No external validation | **High** | One developer outside this project completes `INSTALLATION.md` unaided; record their friction |
| B3 | CI never run on a hosted runner | Medium | Push and confirm the workflow goes green |
| B4 | Addon not independently downloadable | Medium | Tag a GitHub release with the addon attached |
| B5 | WS runtime unauthenticated | Medium | Documented as a v1.0 limitation. Acceptable for localhost; blocks networked use. |
| B6 | Asset Library not submitted | Low | External review process; deferred deliberately |
| B7 | 4.5 / 4.6 untested | Low | Either test them or keep them out of the support claim |

B1 and B2 are the release gate. B3–B7 are not.

---

## 18. Recommended P-025

**Publish, then obtain genuine external validation.**

1. `npm publish` the runtime. Verify `npm install causality-engine` from a machine
   that has never seen the repository.
2. Tag `v1.0.0-rc.1` on GitHub with the addon attached as a release asset.
3. Push the CI workflow; confirm it goes green on hosted runners across the 6-way
   matrix.
4. Recruit **one** developer outside this project. Give them only the published
   package and the documentation URL. Give no verbal help. Record every question
   they ask — each is a documentation defect.
5. Fix what they find.
6. Cut `1.0.0` only after steps 1 and 4 both succeed.

Explicitly **not** P-025: new causal semantics, new gameplay, multiplayer, cloud
hosting, adding authentication to the engine, performance work, or reopening the
freeze.

---

## Central question

> Can Causality Engine `1.0.0-rc.1` now be honestly released as CE `1.0.0`,
> rather than merely demonstrated to work by its authors?

**No — and the second clause is exactly why.**

CE has been demonstrated to work more thoroughly than before: 866 assertions
across a clean-room tarball consumer, three real Godot versions, and a blind
installation walkthrough that falsified one of our own predictions and produced
five documentation fixes.

But every one of those demonstrations was still performed by the authors. The one
claim `1.0.0` makes that we cannot support is that someone else can pick this up.
The blind protocol was the closest honest approximation available, and it is not
the same thing.

**The artifact is release-quality. The release itself requires publishing it and
letting someone else try.**
