# P-024: v1.0.0 Release Candidate Validation — Falsifiable Predictions

**Written BEFORE any release-related change.** Date: 2026-09-02
**Candidate:** CE `1.0.0-rc.1`
**Frozen invariants:** 12 (P-019) — must remain unchanged

Each prediction states an observable outcome and the specific evidence that
would refute it. A prediction that cannot be falsified is not listed.

---

## P1 — Package integrity

**Prediction:** The npm artifact produced by `npm pack` contains everything
required for its documented installation and use, and excludes all development
and research material.

**Must contain:** compiled `dist/` with `api/product.js` + `.d.ts`, the Godot
addon, the six product documents, `README.md`, `LICENSE`, `package.json`.

**Must exclude:** `src/`, tests, `src/poc/`, research documents (`P-0*`,
`RECONNAISSANCE.md`), `godot-iso/`, screenshots, `examples/`, `scripts/`,
`node_modules/`, any credential, any absolute path.

**Test:** `npm pack --dry-run`, then enumerate the actual tarball contents.

**Falsified if:** any required file is absent, or any excluded category is
present.

---

## P2 — Clean installation

**Prediction:** A directory containing nothing but a bare `package.json` can
`npm install <tarball>` and import CE successfully, with no access to the CE
development repository.

**Test:** Create a temp directory outside the CE tree. Install the tarball.
Import from `causality-engine` and from `causality-engine/product`.

**Falsified if:** install fails, imports fail, module resolution reaches outside
`node_modules`, or the package requires a build step the consumer must run.

---

## P3 — Godot compatibility

**Prediction:** The addon loads and completes the documented integration on the
Godot versions selected for the v1.0 support matrix.

**Versions to attempt:** 4.3, 4.4, 4.7.x (currently verified).

**Test:** Per version — addon loads, `CeClient` initialises, connection succeeds,
intervention succeeds, event arrives, state is inspectable, checkpoint works,
fork/rewind works.

**Falsified if:** any attempted version fails a stage, **or** if a version
cannot be installed in the available environment and is nonetheless labelled
supported.

Three labels will be used and kept distinct: **tested**, **expected compatible**
(API inspection only), **untested**.

---

## P4 — Documentation sufficiency

**Prediction:** A developer following only `INSTALLATION.md`,
`GETTING-STARTED.md`, and `RUNTIME-REQUIREMENTS.md` reaches a working CE-backed
integration without undocumented intervention.

**Test:** Blind protocol — execute only steps the documentation states, in the
order it states them. Every deviation, inference, or repository-knowledge shortcut
is recorded as a documentation defect.

**Falsified if:** any step requires knowledge not present in those documents.

---

## P5 — Runtime reproducibility

**Prediction:** A clean installation reproduces the deterministic reference
behaviour established by P-022/P-023.

**Reference values:** initial grain price `10.00`; after destroying `grain_road`
and advancing 5 ticks, grain `13.13` and `stateHash` prefix `5404d32e`; save/load
continuation identical; forked timelines report `distinct=true` with both hashes
differing.

**Test:** Run the loop from the clean consumer against the installed tarball.

**Falsified if:** any reference value differs.

---

## P6 — CI reproducibility

**Prediction:** The release verification suite executes from a clean checkout in
an environment with no accumulated CE state.

**Test:** A CI workflow performing checkout → `npm ci` → `tsc` → `vitest` →
replay smoke → invariant check, with no reference to any developer machine.

**Falsified if:** the suite depends on a pre-existing file, a running server, a
machine-specific path, or state the checkout does not contain.

**Note:** CI *authoring* can be verified locally by simulating a clean checkout.
CI *execution on a hosted runner* is a separate claim and will be labelled as
such.

---

## P7 — Deployment clarity

**Prediction:** The documentation states unambiguously how to deploy CE locally
in both runtime models, and what must change before exposing the WS runtime
beyond localhost.

**Test:** `DEPLOYMENT.md` must state: Node requirement, supported versions, port,
bind address, startup command, configuration, checkpoint storage, reconnect
behaviour, local setup, production considerations, and the security limitation.

**Falsified if:** any of those is absent, or the WS runtime's lack of
authentication is understated or presented as production-secure.

---

## P8 — Release artifact provenance

**Prediction:** The candidate artifact can be traced to a specific git commit and
verified against that source.

**Test:** `package.json` carries a `repository` field; the artifact's version
corresponds to a commit; a fresh clone at that commit reproduces an equivalent
tarball.

**Falsified if:** the artifact cannot be tied to a commit, or repository metadata
is absent.

---

## Known risk entering this pass

`tsc --noEmit` currently reports **90 error lines** across four `src/poc` tool
files (`long-run.ts`, `runtime-boundary.test.ts`, `runtime-cadence.ts`, and
similar). This is the documented pre-existing P-011 baseline.

`npm run build` runs `tsc` without `--noEmit`. If those errors block emit, there
is no `dist/`, and therefore **no installable artifact** — which would falsify P1
and P2 immediately.

This is a **packaging defect** if it occurs, not a semantic one. Predicted
resolution: exclude non-shipping tool/test files from the build via a dedicated
build tsconfig, without touching any engine source or weakening any test.

---

## Non-predictions (explicitly out of scope)

Not predicted, tested, or claimed in this pass:

- npm publication succeeding (not attempted; `--dry-run` only)
- Asset Library acceptance
- CI passing on a hosted runner
- security of the WS runtime beyond localhost
- performance characteristics
- any change to CE causal semantics

---

## Blocker rule

If validation exposes a defect, it is classified as exactly one of:

```
packaging defect            -> fix in this pass
documentation defect        -> fix in this pass
adapter defect              -> fix in this pass
API ergonomics defect       -> fix in this pass
runtime/deployment defect   -> fix in this pass
genuine CE semantic defect  -> STOP, report, do not modify frozen architecture
```

## Release rule

`1.0.0` is justified only if the distribution and external-consumer claims are
supported by evidence. All automated tests passing is necessary and not
sufficient. If the evidence does not support the claims, the decision is **HOLD**
with concrete blockers listed.
