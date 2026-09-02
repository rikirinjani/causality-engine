# P-025: External Release Validation & 1.0.0 Gate — Results

**Date:** 2026-09-02
**Candidate:** CE `1.0.0-rc.1` at commit `236ac45`, tagged `v1.0.0-rc.1`
**Decision:** **HOLD** — remain at `1.0.0-rc.1`
**Frozen invariants:** 12/12 unchanged

Predictions were written before any P-025 change in
[P-025-PREDICTIONS.md](./P-025-PREDICTIONS.md).

---

## 1. Prediction outcomes

| # | Prediction | Outcome | Evidence |
|---|-----------|---------|----------|
| P1 | Publish readiness | **CONFIRMED** | Clean rebuild: 162 entries, audit PASS |
| P2 | npm publication | **FALSIFIED** | No npm credentials on any available machine |
| P3 | Hosted CI | **CONFIRMED** | Run `33626994835` green, 8/8 jobs |
| P4 | Addon independently downloadable | **CONFIRMED** (after fixing a defect) | Both assets served by public URL; 23/23 on three Godot versions from the download |
| P5 | Independent developer validation | **FALSIFIED** | No independent developer available |
| P6 | Wider cross-platform determinism | **CONFIRMED** | `5404d32e` on 6/6 hosted OS × Node combinations |
| P7 | No P0/P1 developer-experience defects | **CONFIRMED** for the documented path | Blind re-walk clean after correcting install docs |
| P8 | Frozen invariants survive | **CONFIRMED** | No engine diff; all checks pass |

Six confirmed, two falsified. Both falsifications are reported as failures, not
reframed as deferrals.

---

## 2. Phase 0 — Baseline gate

| Item | State |
|------|-------|
| Commit | `236ac45` (P-024) |
| Mac mini sync | `HEAD == origin/main` |
| Uncommitted work | `src/poc/probe-ws-checkpoint.ts` — untracked, preserved |
| Test suite | 746/746 |
| `check:dist` | 0 errors |
| Replay | `5404d32e` matches P-014 |
| Invariant check | All pass |

No history rewritten. No frozen architecture touched.

---

## 3. Phase 1 — Publish readiness

Clean rebuild (`rm -rf dist && npm pack`):

```
total files:   162
package size:  184.7 kB
unpacked size: 700.1 kB
sha1:          871b33cd277e6a97b923950c20af97103ea26540
```

`bash scripts/audit-tarball.sh` → **RESULT: PASS**. Nine exclusion patterns
absent, fourteen required paths present, credential scan clean.

### Entry count identical, shasum different

P-024 recorded sha1 `3a73849f…`; this build produced `871b33cd…`. Both have 162
entries and both pass the audit.

The difference is content, not packaging: P-024's blind walkthrough produced five
documentation fixes to `INSTALLATION.md`, which grew from 4.5 kB to 6.4 kB. The
tarball changed because the documentation improved. Expected, and worth recording
rather than glossing.

npm tarballs are not byte-reproducible across environments in any case (gzip
timestamps, file ordering). Content-level auditing is the meaningful check, which
is why `audit-tarball.sh` inspects entries rather than comparing digests.

---

## 4. Phase 2 — npm publication gate: **NOT PUBLISHED**

**P2 is falsified.**

| Machine | npm auth | Result |
|---------|----------|--------|
| Mac mini | `npm whoami` → `ENEEDAUTH` | Cannot publish |
| Windows | `npm whoami` → `ENEEDAUTH` | Cannot publish |

No `~/.npmrc`, no `NPM_TOKEN`, no `NODE_AUTH_TOKEN` in either environment.

The package name is available — `npm view causality-engine` returns 404, and the
nearest existing names (`causality`, `causality-redux`) do not collide.

### Exact procedure once credentials exist

```bash
npm login                      # or: export NPM_TOKEN=<token>
cd causality-engine
npm run verify:release         # check:dist + tests + replay + invariants
npm publish --access public    # prepack runs the build automatically
```

Then verify from a machine that has never seen the repository:

```bash
mkdir /tmp/npm-check && cd /tmp/npm-check
echo '{"name":"c","private":true,"type":"module"}' > package.json
npm install causality-engine@1.0.0-rc.1
node -e "import('causality-engine/product').then(m => console.log(typeof m.createGame))"
```

**Publication was not simulated. npm availability is not claimed.** The state is
NOT PUBLISHED.

### What was done instead

A **GitHub release** was published, which does close the "obtainable without the
repository" half of the gate:

```
https://github.com/rikirinjani/causality-engine/releases/tag/v1.0.0-rc.1
```

| Asset | Size | sha256 |
|-------|------|--------|
| `causality-engine-1.0.0-rc.1.tgz` | 184,749 | `020d6e58…aa640` |
| `causality-engine-godot-addon-1.0.0-rc.1.zip` | 13,667 | `ff36cd6a…9df3` |

Tag `v1.0.0-rc.1` is annotated with the verification evidence and the known
limitations, and is marked pre-release.

### Public-download consumer test

Downloaded the tarball by URL into `/tmp/p025-release` — no repository, no local
build:

```
HTTP 200 size 184749
sha256 020d6e5862743a1929ecd7c8e03613b1c00914c3de7d6ce2b94bf4f9018aa640
       ^ matches the release digest exactly
sha1   871b33cd277e6a97b923950c20af97103ea26540
       ^ matches the locally audited build exactly
audit-tarball.sh → RESULT: PASS
```

Installed into `/tmp/p025-consumer` and ran the clean-consumer suite:

```
added 1 package, found 0 vulnerabilities
=== RESULTS: 51 passed, 0 failed ===
```

**The published artifact is byte-identical to the audited artifact**, and it
works when obtained purely from a public URL. That is the substance of the gate;
what is missing is the npm registry as the channel.

---

## 5. Phase 3 — Hosted CI gate: **GREEN**

Run `33626994835`, triggered by the P-024 push. **8/8 jobs green in 58 s.**

| Job | Duration |
|-----|----------|
| engine (node 20 / ubuntu) | 32 s |
| engine (node 22 / ubuntu) | 25 s |
| engine (node 20 / macos) | 41 s |
| engine (node 22 / macos) | 34 s |
| engine (node 20 / windows) | 55 s |
| engine (node 22 / windows) | 50 s |
| package artifact | 16 s |
| boundary audit | 7 s |

Observed in the hosted logs, not inferred:

```
package audit clean (162 entries)
added 1 package, and audited 2 packages in 499ms
=== RESULTS: 51 passed, 0 failed ===
Test Files  20 passed (20)
hash: 5404d32e6ca92e9e…    (all six engine jobs)
INV 4/12 determinism  run1=5404d32e6ca92e9e run2=5404d32e6ca92e9e identical=true
```

The three claims, kept separate:

| Claim | Status |
|-------|--------|
| CI authored | Yes (P-024) |
| CI locally reproduced | Yes (P-024) |
| **CI executed on hosted infrastructure** | **Yes — run 33626994835** |

One advisory annotation: GitHub is deprecating Node 20 for actions and
force-running `checkout@v4` / `setup-node@v4` on Node 24. This affects the action
runtime, not CE's tested Node versions. Not a failure; noted for a future action
bump.

---

## 6. Phase 4 — Godot distribution validation

The addon is now downloadable by public URL and was validated **from that
download**, not from the repository.

Clean project at `/tmp/p025-gp`, built by unzipping the released asset. Path audit
found no reference to `Users`, `Project_v2`, or `causality-engine`.

| Godot version | Build | Result |
|---------------|-------|--------|
| **4.3** | `4.3.stable.official.77dcf97d8` | **23/23** |
| **4.4** | `4.4.stable.official.4c311cbee` | **23/23** |
| **4.7.2** | `4.7.2.stable.official.ed1daf0bf` | **23/23** |

All twelve stages passed on each: addon loads, `CeClient` initialises, connection,
snapshot, checkpoint, intervention, advance, events, price `10.00 → 13.13`,
explanation rooted in `destroy_infrastructure`, rewind, fork, comparison.

4.5 and 4.6 remain **untested** and are not claimed.

Asset Library submission was assessed and deliberately not attempted: it is an
external review process, and the project has not designated it a mandatory
channel. The GitHub release satisfies independent downloadability.

---

## 7. Phase 5 — Independent developer validation: **NOT PERFORMED**

**P5 is falsified.**

No developer outside this project was available. Per the honesty rules in
`P-025-PREDICTIONS.md`, this is reported as a failed prediction rather than
substituted with a self-test.

A blind self-test was run for *documentation* purposes (Phase 7 below), and it is
explicitly **not** independent validation. The author cannot un-know the system.

`docs/INDEPENDENT-VALIDATION-BRIEF.md` is now prepared so the test can be run
without further setup: task definition for both TypeScript and Godot tracks,
observation log, debrief questions, classification rubric, and result template.

A run counts toward the gate only if: **completed unaided**, **no author
assistance**, **zero P0**, **zero P1**.

---

## 8. Phase 6 — Friction analysis

### Findings this pass

| # | Finding | Class | Status |
|---|---------|-------|--------|
| F1 | Godot addon zip had Windows backslash path separators; `unzip` warned and extraction was unreliable on macOS/Linux | **P0** | **Fixed** |
| F2 | `INSTALLATION.md` said "every install starts from a git clone" — untrue once the release existed | **P1** | **Fixed** |
| F3 | Godot install instructions assumed a repository clone | **P1** | **Fixed** |
| F4 | No documented remedy for the `npm install causality-engine` 404 | **P1** | **Fixed** |
| F5 | ESM requirement is stated but easy to skip; a missing `"type": "module"` produces `ERR_MODULE_NOT_FOUND` | P2 | Documented in `TROUBLESHOOTING.md` |
| F6 | Standalone runtime still needs a clone (it is a server, not a library) | P2 | Documented as inherent |

### F1 detail — the one real P0

`Compress-Archive` on Windows produced entries named
`causality_engine\ce_client.gd`. Unix `unzip` reported *"appears to use
backslashes as path separators"* and produced an unreliable layout. Any
macOS/Linux Godot developer downloading the asset would have hit this.

Rebuilt with `zip -rq` on the Mac mini, which also improved the layout: entries
are now `addons/causality_engine/…`, so unzipping at the project root drops files
in the correct place with no manual move. The release asset was replaced;
`sha256 ff36cd6a…` is the corrected artifact and the download was re-verified
against that digest.

**Classification: packaging defect.** No engine change.

### Semantic findings

**Zero.** No CE semantic defect was found. `git diff HEAD -- src/core src/game
src/api src/poc` is empty for this pass.

---

## 9. Phase 7 — Blind documentation re-walk

Not independent validation. A check that the documented path works as written.

| Step | Documented instruction | Result |
|------|----------------------|--------|
| 1 | `curl -LO <release-url>` | HTTP 200, 184,749 bytes |
| 2 | `npm install ./causality-engine-1.0.0-rc.1.tgz` | Added 1 package, 0 vulnerabilities |
| 3 | Paste the Option A snippet verbatim | `13.134310936532078` — matches the documented `13.13` |

One recorded stumble: running the snippet before creating a `package.json` with
`"type": "module"` produced `ERR_MODULE_NOT_FOUND`. The requirement *is*
documented one line above the snippet, and `TROUBLESHOOTING.md` covers the error.
Classified **P2** — real but not blocking, and already documented.

Blind install to first working result: **under 2 minutes** via the release
download, against ~8 minutes in P-024 when the first documented step 404'd.

---

## 10. Answers to the release questions

| # | Question | Answer |
|---|----------|--------|
| **Q1** | Can a fresh user obtain CE from a public distribution channel? | **Yes** — GitHub release, both assets by URL. **Not npm.** |
| **Q2** | Can they install it without the source repository? | **Yes** for the library and the Godot addon. **No** for the standalone runtime, which is a server process. |
| **Q3** | Can they connect to a CE runtime using documented instructions? | **Yes** — 23/23 from the downloaded addon on three Godot versions. |
| **Q4** | Can they build the minimal causal loop using only the public API? | **Yes** — 51/51 assertions from the public download, imports restricted to `causality-engine/product`. |
| **Q5** | Can they use the Godot addon without CE internal knowledge? | **Yes** — the addon contains no CE source reference and no path outside itself. |
| **Q6** | Has this been demonstrated by someone other than the authors? | **No.** This is the blocking gate. |
| **Q7** | Has CI actually executed on hosted infrastructure? | **Yes** — run `33626994835`, 8/8 green. |
| **Q8** | Are all remaining limitations honestly documented? | **Yes** — release notes, `CHANGELOG.md`, `DEPLOYMENT.md`, `COMPATIBILITY.md`, and this report. |

---

## 11. Verification summary

| Check | Count | Result |
|-------|-------|--------|
| CE test suite (Mac mini) | 746 | **746 passed** |
| CE test suite (hosted CI, 6 combinations) | 746 × 6 | **all passed** |
| `check:dist` | shippable code | **0 errors** |
| Clean consumer — local tarball | 51 | **51 passed** |
| Clean consumer — public download | 51 | **51 passed** |
| Clean consumer — hosted CI | 51 | **51 passed** |
| Godot 4.3 from release download | 23 | **23 passed** |
| Godot 4.4 from release download | 23 | **23 passed** |
| Godot 4.7.2 from release download | 23 | **23 passed** |
| Tarball audit — local build | 24 | **PASS** |
| Tarball audit — public download | 24 | **PASS** |
| Tarball audit — hosted CI | 24 | **PASS** |
| Replay (7 environments) | 7 | **`5404d32e` everywhere** |
| Boundary audits (hosted) | 4 | **PASS** |
| Blind documentation re-walk | 3 steps | **PASS**, 1 P2 |

Determinism now confirmed on: macOS arm64 (local), Linux x64 / macOS arm64 /
Windows x64 under Node 20 and 22 (hosted). **Seven environments, one hash.**

---

## 12. RESEARCH STATUS

Unchanged by this pass. Recorded separately so distribution work is never mistaken
for research progress.

### Frozen invariants — 12/12 intact

| # | Invariant | Status |
|---|-----------|--------|
| 1 | CE is sole causal authority | Unchanged |
| 2 | No causal rules outside CE | Unchanged |
| 3 | No RNG outside CE | Unchanged |
| 4 | Deterministic replay | Unchanged — `5404d32e` in 7 environments |
| 5 | Temporal decoupling | Unchanged |
| 6 | WS is transport, not causal channel | Unchanged |
| 7 | Godot = rendering only | Unchanged |
| 8 | Adapter = translation only | Unchanged |
| 9 | `explain()` uses CE attribution | Unchanged |
| 10 | Branching preserves lineage | Unchanged |
| 11 | Checkpoint/rewind are CE operations | Unchanged |
| 12 | State hash is deterministic | Unchanged |

### Research claims — unchanged

Causal quota architecture, structured provenance DAG with retrospective
attribution, adapter authority boundary, deterministic branching and rewind,
bounded retention with explicit gap reporting.

### Empirical evidence — strengthened, not extended

Cross-platform determinism now spans seven environments instead of two. This is
**wider observation of an existing claim**, not a new claim. The non-claims stand
in full: no formal determinism proof, no exactly-once delivery, not a
general-purpose engine, single-scenario vertical slice, WS not production-soaked,
hardware-specific performance, integration-level testing.

---

## 13. PRODUCT STATUS

| Dimension | State |
|-----------|-------|
| **Artifact quality** | Release-quality. 162 entries, audited three ways, digests match across build and download. |
| **Distribution** | GitHub release live with both assets. **npm: NOT PUBLISHED.** Asset Library: not submitted. |
| **Installation** | Verified from public download for both the library and the Godot addon. |
| **Documentation** | Ten documents. Install path corrected this pass. Blind re-walk: under 2 minutes to first result. |
| **CI** | Hosted, green, 8/8 jobs, 6-way engine matrix plus package and boundary audits. |
| **External validation** | **None.** Brief prepared; no tester available. |
| **Release readiness** | Everything except adoption evidence. |

---

## 14. Release decision: **HOLD**

`1.0.0-rc.1` remains the release candidate.

### Gate-by-gate

| Gate | Status |
|------|--------|
| Public package installation succeeds | **Partial** — GitHub release yes, npm no |
| Published artifact matches audited artifact | **Pass** — digests identical |
| Hosted CI green | **Pass** — run `33626994835` |
| Godot distribution verified | **Pass** — 3 versions from the public download |
| ≥1 independent developer completes integration | **FAIL** — none available |
| No P0/P1 developer-experience blockers | **Pass** — 1 P0 and 3 P1 found and fixed |
| All 12 frozen invariants intact | **Pass** |
| No unsupported claims introduced | **Pass** |

Six of eight gates pass. Two do not, and one of them is the gate that P-024
identified as decisive.

### Why HOLD, stated plainly

**The npm gate is now partial rather than closed.** CE is genuinely obtainable
without the repository — a public URL, a digest-verified download, 51/51 from
that download. The remaining shortfall is the registry as a channel, not the
ability to distribute. That alone would arguably not justify holding.

**The independent-validation gate is untouched.** No developer outside this
project has used CE. Every one of the roughly 1,100 assertions across P-022 to
P-025 was written and run by the authors. P-024 held on exactly this point, and
nothing in P-025 changed it.

Manufacturing that evidence — presenting a blind self-test as independent
validation — is the one thing that would make the `1.0.0` claim dishonest rather
than merely premature. The blind re-walk in Phase 9 is reported as what it is: a
documentation check by someone who already knows the system.

---

## 15. Remaining blockers

| # | Blocker | Severity | Closes when |
|---|---------|----------|-------------|
| B1 | No independent developer validation | **Blocking** | One outside developer completes `INDEPENDENT-VALIDATION-BRIEF.md` unaided, zero P0/P1 |
| B2 | Not published to npm | Medium | Credentials obtained; `npm publish --access public`; registry install verified |
| B3 | Asset Library not submitted | Low | Optional; not a designated mandatory channel |
| B4 | Godot 4.5 / 4.6 untested | Low | Test them, or continue not claiming them |
| B5 | WS runtime unauthenticated | Low | Documented v1.0 limitation; acceptable for localhost |
| B6 | CI actions pinned to a deprecated Node | Low | Bump `checkout`/`setup-node` when v5 is stable |

**B1 alone blocks `1.0.0`.** B2 is a channel gap with a documented workaround that
demonstrably works.

---

## 16. Recommended P-026

**Close B1. Nothing else.**

1. Recruit one developer with no CE involvement.
2. Hand them `docs/INDEPENDENT-VALIDATION-BRIEF.md` and step away.
3. Observe silently. Record every question, every failed command, every guess.
4. Do not fix anything during the session.
5. Debrief with the eight prepared questions.
6. Classify findings P0 / P1 / P2 / SEMANTIC.
7. Fix P0 and P1.
8. If a SEMANTIC finding appears, stop the release pass and open it as a research
   question.
9. Cut `1.0.0` only if the run completed unaided with zero P0/P1.

Opportunistic, not blocking: publish to npm when credentials exist; bump the CI
actions.

Explicitly **not** P-026: new causal semantics, new gameplay, multiplayer, cloud,
engine authentication, performance work, reopening the freeze.

---

## Central P-025 question

> Can CE honestly stop being described as "a project that works" and start being
> described as "a product that another developer can actually adopt"?

**Not yet — and the gap is now precisely one thing.**

What changed this pass is real. CE is downloadable from a public URL with verified
digests. The published artifact is byte-identical to the audited one. Hosted CI is
green across six OS and Node combinations, and all six reproduce the same
deterministic hash. Three Godot versions pass 23/23 from the released addon rather
than from the repository. A P0 packaging defect that would have broken every
macOS and Linux Godot user was found and fixed. Blind time-to-first-result fell
from about eight minutes to under two.

That is the difference between "works on the authors' machines" and
"distributable". CE has crossed it.

But "a product another developer can adopt" is a claim about *another developer*,
and no other developer has touched it. The evidence for adoptability is still
entirely self-generated. The honest description today is:

> **A project that works, packaged and distributed to a standard that should
> support adoption — with adoption itself still unevidenced.**

One test closes that sentence. The brief is written. The tester is missing.
