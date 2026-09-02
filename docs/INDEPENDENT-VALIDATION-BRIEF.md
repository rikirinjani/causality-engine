# CE Independent Developer Validation — Tester Brief

**Purpose:** close the last gate on CE `1.0.0`. Everything else has been
verified; the one claim that cannot be made yet is that someone who did not
build CE can adopt it.

This brief is self-contained. Hand it to a developer and step away.

---

## For whoever runs the session (not the tester)

### Give the tester

1. This document.
2. Nothing else.

### Do not give the tester

- Any verbal explanation of CE, its architecture, or its concepts.
- Hints about where files live or what the API is called.
- Help while they are working, even if they are stuck.
- Reassurance that something is or is not a bug.

If they ask a question, write it down and answer only: *"whatever the
documentation says."* Their being stuck **is the result.**

### Record while observing

| Field | Note |
|-------|------|
| Environment | OS, Node version, Godot version if used |
| Prior experience | Game dev? TypeScript? Godot? Simulation? |
| T0 | Start time |
| T1 | First successful install |
| T2 | First successful CE connection or first `createGame` |
| T3 | Task complete, or abandoned |
| Questions asked | Verbatim, in order |
| Commands that failed | Verbatim, with what they expected |
| APIs they looked for that do not exist | Name and what they expected it to do |
| Documentation misreadings | Which sentence, and what they thought it meant |
| Points needing assistance | Exactly what unblocked them |
| Internals opened | Did they ever read CE source? Which file, and why? |

Stop only if they are fully blocked for more than 20 minutes. Record that as a
**P0**.

### Do not fix anything during the session

Documentation defects found mid-session must be recorded, not corrected. Fixing
while observing destroys the evidence.

---

## For the tester

### What CE is

Causality Engine is a simulation layer for games. Your game renders; CE decides
what happens in the world and why.

That is all you are being told. Everything else is in the documentation.

### Where to start

Release page: https://github.com/rikirinjani/causality-engine/releases/latest

Documentation: https://github.com/rikirinjani/causality-engine/tree/main/docs

Start with `INSTALLATION.md`.

### Your task

Pick **one** track.

#### Track A — TypeScript (~30 min expected)

1. Install CE into a new, empty project.
2. Create a world.
3. Perform one intervention.
4. Advance simulation time.
5. Observe a value that changed as a consequence.
6. Save the world and load it back.
7. Print something that shows the consequence and that the reload worked.

#### Track B — Godot (~45 min expected)

1. Start a CE runtime.
2. Create a new, empty Godot project.
3. Install the CE addon.
4. Connect to the runtime.
5. Perform one intervention.
6. Render or print a value that changed as a consequence.
7. Demonstrate one documented persistence operation.

### Ground rules

- Use only the release downloads and the documentation.
- **Do not read CE source code.** If you feel you must, stop and record why —
  that is the single most valuable finding you can produce.
- If something does not work, note it and try what the documentation suggests.
- Do not ask for help. Being stuck is a valid, useful result.
- Please do not consult the `docs/P-0*.md` files — those are internal research
  reports, not user documentation.

### What we actually want

Not a working demo. **Where the documentation failed you.**

A tester who abandons at step 3 with a clear account of why is more valuable than
one who succeeds by guessing.

---

## Debrief (after they finish or stop)

Ask these, in order, and record answers verbatim.

1. What did you expect CE to be before you started? Was it that?
2. Where did you first get stuck?
3. What did you have to guess?
4. Was anything in the documentation actively misleading?
5. Did you ever want to read CE's source? What for?
6. What did you expect to exist that did not?
7. If you had to ship a small game on this, what would worry you?
8. Would you use it again? Why or why not?

---

## Classification (session runner fills in afterwards)

| Class | Definition |
|-------|-----------|
| **P0** | Prevents a competent developer from completing the basic integration |
| **P1** | Completion possible but needs unexplained knowledge, author help, or a misleading step |
| **P2** | Usability or wording improvement; does not prevent success |
| **SEMANTIC** | The engine did the wrong thing — not a documentation issue |

P0 and P1 block `1.0.0`. A SEMANTIC finding stops the release pass entirely and
becomes a new research question; it must not be filed as documentation friction.

---

## Result template

```
CE INDEPENDENT VALIDATION — <date>

Tester:          <role, relevant experience, no CE involvement>
Environment:     <OS / Node / Godot>
Track:           A (TypeScript) | B (Godot)

T1 install:      <mm:ss>
T2 connection:   <mm:ss>
T3 complete:     <mm:ss> | ABANDONED at <step>

Completed unaided:     YES | NO
Read CE source:        NO | YES (<file>, because <reason>)
Author assistance:     NONE | <what was given>

Questions asked:       <n>
P0 findings:           <n>  <list>
P1 findings:           <n>  <list>
P2 findings:           <n>  <list>
SEMANTIC findings:     <n>  <list>

Debrief notes:         <verbatim>
```

A run counts toward the `1.0.0` gate only if **Completed unaided = YES**,
**Author assistance = NONE**, and there are **zero P0 and zero P1** findings.
