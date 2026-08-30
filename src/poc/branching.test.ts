import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance, attachEngine, createEngine, createWorld, submitIntervention } from "../core/world.js";
import { stateHash, traceHash } from "../core/hash.js";
import { createCheckpoint, serializeCheckpoint } from "../core/persistence.js";
import { checkpoint, forkTimeline, noteDivergence, replayAbandoned, rewindTo } from "../core/timeline.js";
import { ancestryOf } from "../core/genealogy.js";
import { explain, key, PROVENANCE_LIMIT } from "../core/provenance.js";
import { WORLD_SEED } from "../game/content.js";
import { iBridge, iMerchant, iRally, iSubsidy, iWarehouse } from "./harness.js";
import type { Intervention, WorldState } from "../core/types.js";

/**
 * Branching, rewind, genealogy, provenance persistence and the process boundary (§17).
 * Split from persistence.test.ts because these spawn child processes and run longer.
 */

function seededWorld(ticks = 9): { world: WorldState; engine: ReturnType<typeof createEngine> } {
  const engine = createEngine();
  const world = createWorld({ seed: WORLD_SEED }, engine);
  advance(world, engine, ticks);
  return { world, engine };
}

function continueFrom(source: WorldState, ticks: number): WorldState {
  const world = structuredClone(source);
  advance(world, attachEngine(world, createEngine()), ticks);
  return world;
}

// ===========================================================================
describe("§17.5 branching", () => {
  it("forks preserve parent identity, get distinct identities, and share pre-fork history", () => {
    const { world } = seededWorld();
    const cp = checkpoint(world, "fork-point");
    const parentTimeline = world.lineage.timelineId;
    const preForkTrace = traceHash(world);

    const a = forkTimeline(cp, "branch-a");
    const b = forkTimeline(cp, "branch-b");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // distinct identities, same parent, same fork point
    expect(a.value.timelineId).not.toBe(b.value.timelineId);
    expect(a.value.world.lineage.parentTimelineId).toBe(parentTimeline);
    expect(b.value.world.lineage.parentTimelineId).toBe(parentTimeline);
    expect(a.value.world.lineage.parentCheckpointId).toBe(cp.identity.checkpointId);
    expect(a.value.world.lineage.forkTick).toBe(world.tick);
    expect(a.value.world.lineage.generation).toBe(world.lineage.generation + 1);

    // shared history is intact in both (only lineage differs pre-divergence)
    expect(traceHash(a.value.world)).toBe(preForkTrace);
    expect(traceHash(b.value.world)).toBe(preForkTrace);
  });

  it("post-fork mutations are isolated: no leaks between branches or back to the parent", () => {
    const { world } = seededWorld();
    const cp = checkpoint(world);
    const parentHash = stateHash(world);

    const a = forkTimeline(cp, "a");
    const b = forkTimeline(cp, "b");
    if (!a.ok || !b.ok) return;

    submitIntervention(a.value.world, iBridge("x"), a.value.engine);
    noteDivergence(a.value.world, [iBridge("x")]);
    advance(a.value.world, a.value.engine, 15);

    submitIntervention(b.value.world, iRally("y"), b.value.engine);
    noteDivergence(b.value.world, [iRally("y")]);
    advance(b.value.world, b.value.engine, 15);

    // parent untouched
    expect(stateHash(world)).toBe(parentHash);
    // branches differ from each other
    expect(stateHash(a.value.world)).not.toBe(stateHash(b.value.world));
    // and neither shares mutable structure
    expect(a.value.world.regions["RF"]).not.toBe(b.value.world.regions["RF"]);
    expect(a.value.world.interventionHistory.map((i) => i.id)).not.toEqual(
      b.value.world.interventionHistory.map((i) => i.id),
    );
  });

  it("state hashes diverge exactly when state diverges", () => {
    const { world } = seededWorld();
    const cp = checkpoint(world);
    const a = forkTimeline(cp, "a");
    const b = forkTimeline(cp, "b");
    if (!a.ok || !b.ok) return;

    // no interventions: same physics, but DIFFERENT lineage -> different identity
    advance(a.value.world, a.value.engine, 10);
    advance(b.value.world, b.value.engine, 10);
    expect(a.value.world.lineage.timelineId).not.toBe(b.value.world.lineage.timelineId);
    expect(stateHash(a.value.world)).not.toBe(stateHash(b.value.world));

    // strip lineage and the physical worlds are identical, proving only identity differed
    const stripLineage = (w: WorldState) => {
      const c = structuredClone(w);
      c.lineage = { ...c.lineage, timelineId: "T-x", parentTimelineId: null, parentCheckpointId: null, forkTick: null };
      return stateHash(c);
    };
    expect(stripLineage(a.value.world)).toBe(stripLineage(b.value.world));
  });

  it("a fork records which interventions created its divergence", () => {
    const { world } = seededWorld();
    const cp = checkpoint(world);
    const a = forkTimeline(cp, "a");
    if (!a.ok) return;

    const iv = iWarehouse("div-1");
    submitIntervention(a.value.world, iv, a.value.engine);
    noteDivergence(a.value.world, [iv]);
    expect(a.value.world.lineage.divergenceInterventionIds).toEqual(["div-1"]);
  });
});

// ===========================================================================
describe("§17.6 branch convergence — state converges, history does not", () => {
  it("two different intervention histories reaching the same world share stateHash but not traceHash", () => {
    const { world } = seededWorld();
    const cp = checkpoint(world);

    // Both branches destroy the same two structures; only the ORDER differs.
    const runOrder = (label: string, order: Intervention[]) => {
      const f = forkTimeline(cp, label);
      if (!f.ok) throw new Error("fork failed");
      for (const i of order) submitIntervention(f.value.world, i, f.value.engine);
      advance(f.value.world, f.value.engine, 20);
      return f.value.world;
    };

    const a = runOrder("conv-a", [iBridge("i-bridge"), iWarehouse("i-warehouse")]);
    const b = runOrder("conv-b", [iWarehouse("i-warehouse"), iBridge("i-bridge")]);

    // Same timeline label would be required for identical lineage; compare physics only.
    const physical = (w: WorldState) => {
      const c = structuredClone(w);
      c.lineage = { ...c.lineage, timelineId: "T-x", parentTimelineId: null, parentCheckpointId: null, forkTick: null, generation: 0 };
      return stateHash(c);
    };

    expect(physical(a)).toBe(physical(b)); // converged world
    expect(traceHash(a)).not.toBe(traceHash(b)); // divergent history
  });

  it("convergence survives a persistence round-trip, not just in memory", () => {
    const { world } = seededWorld();
    const cp = checkpoint(world);

    const runOrder = (label: string, order: Intervention[]) => {
      const f = forkTimeline(cp, label);
      if (!f.ok) throw new Error("fork failed");
      for (const i of order) submitIntervention(f.value.world, i, f.value.engine);
      advance(f.value.world, f.value.engine, 10);
      // serialize and come back before continuing
      const env = createCheckpoint(f.value.world);
      const round = serializeCheckpoint(env);
      const reparsed = JSON.parse(round) as typeof env;
      const w = structuredClone(reparsed.world);
      advance(w, attachEngine(w, createEngine()), 10);
      return w;
    };

    const a = runOrder("rt-a", [iBridge("i-bridge"), iWarehouse("i-warehouse")]);
    const b = runOrder("rt-b", [iWarehouse("i-warehouse"), iBridge("i-bridge")]);

    const physical = (w: WorldState) => {
      const c = structuredClone(w);
      c.lineage = { ...c.lineage, timelineId: "T-x", parentTimelineId: null, parentCheckpointId: null, forkTick: null, generation: 0 };
      return stateHash(c);
    };
    expect(physical(a)).toBe(physical(b));
    expect(traceHash(a)).not.toBe(traceHash(b));
  });
});

// ===========================================================================
describe("§17.4 rewind semantics", () => {
  it("rewinding preserves the abandoned future as a referenceable sibling", () => {
    const { world, engine } = seededWorld();
    const cp = checkpoint(world, "rewind-point");
    const originalTimeline = world.lineage.timelineId;

    // build a future
    submitIntervention(world, iBridge("f1"), engine);
    advance(world, engine, 5);
    submitIntervention(world, iWarehouse("f2"), engine);
    advance(world, engine, 10);
    const abandonedTick = world.tick;
    const abandonedHash = stateHash(world);

    const rw = rewindTo(cp, world);
    expect(rw.ok).toBe(true);
    if (!rw.ok) return;

    // live world is back at the checkpoint tick with a NEW timeline identity
    expect(rw.value.world.tick).toBe(cp.identity.tick);
    expect(rw.value.timelineId).not.toBe(originalTimeline);
    expect(rw.value.world.lineage.origin).toBe("rewind");

    // the abandoned future is recorded, not deleted
    const abandoned = rw.value.world.lineage.abandonedTimelines;
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]!.timelineId).toBe(originalTimeline);
    expect(abandoned[0]!.abandonedAtTick).toBe(abandonedTick);
    expect(abandoned[0]!.rewoundToTick).toBe(cp.identity.tick);
    expect(abandoned[0]!.abandonedStateHash).toBe(abandonedHash);
    expect(abandoned[0]!.interventionIds).toEqual(["f1", "f2"]);
  });

  it("the live world's provenance does NOT contain the abandoned future", () => {
    const { world, engine } = seededWorld();
    const cp = checkpoint(world);
    const provenanceAtCheckpoint = cp.world.provenance.length;

    submitIntervention(world, iBridge("f1"), engine);
    advance(world, engine, 10);
    expect(world.provenance.length).toBeGreaterThan(provenanceAtCheckpoint);

    const rw = rewindTo(cp, world);
    if (!rw.ok) return;
    // rewound world's history is the history of the world it actually is
    expect(rw.value.world.provenance).toHaveLength(provenanceAtCheckpoint);
    expect(rw.value.world.interventionHistory.every((i) => i.id !== "f1")).toBe(true);
    // explain() must not cite an event that no longer happened
    const ex = explain(rw.value.world, key.tradeBlocked("RF"));
    expect(ex.roots.some((r) => r.interventionId === "f1")).toBe(false);
  });

  it("replay from the rewind point reproduces the abandoned future EXACTLY", () => {
    const { world, engine } = seededWorld();
    const cp = checkpoint(world);

    submitIntervention(world, iBridge("f1"), engine);
    advance(world, engine, 5);
    submitIntervention(world, iWarehouse("f2"), engine);
    advance(world, engine, 10);
    const abandonedState = stateHash(world);
    const abandonedTrace = traceHash(world);
    const abandonedInterventions = structuredClone(world.interventionHistory.filter((i) => i.provenance.submittedAtTick >= cp.identity.tick));

    const replayed = replayAbandoned(
      cp,
      abandonedInterventions,
      (w, e, i) => {
        submitIntervention(w, i, e);
      },
      world.tick,
    );
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;

    expect(replayed.value.stateHash).toBe(abandonedState);
    expect(replayed.value.traceHash).toBe(abandonedTrace);
  });

  it("rewind refuses a checkpoint from a different world or from the future", () => {
    const { world, engine } = seededWorld();
    const cp = checkpoint(world);
    advance(world, engine, 5);

    const otherEngine = createEngine();
    const otherWorld = createWorld({ seed: 999 }, otherEngine);
    advance(otherWorld, otherEngine, 12);
    const foreign = checkpoint(otherWorld);

    expect(rewindTo(foreign, world).ok).toBe(false);

    const future = checkpoint(world);
    const stale = structuredClone(world);
    stale.tick = 1;
    expect(rewindTo(future, stale).ok).toBe(false);
  });

  it("rewind then diverge: the new timeline is genuinely independent of the abandoned one", () => {
    const { world, engine } = seededWorld();
    const cp = checkpoint(world);
    submitIntervention(world, iBridge("f1"), engine);
    advance(world, engine, 10);
    const abandonedHash = stateHash(world);

    const rw = rewindTo(cp, world);
    if (!rw.ok) return;
    submitIntervention(rw.value.world, iRally("alt"), rw.value.engine);
    advance(rw.value.world, rw.value.engine, 10);

    expect(stateHash(rw.value.world)).not.toBe(abandonedHash);
    // the abandoned hash is still recorded and still correct
    expect(rw.value.world.lineage.abandonedTimelines[0]!.abandonedStateHash).toBe(abandonedHash);
  });
});

// ===========================================================================
describe("§17.6 genealogy answers the required questions", () => {
  it("answers which world, which timeline, from which checkpoint, at which tick, via which interventions", () => {
    const { world } = seededWorld();
    const cp = checkpoint(world);
    const f = forkTimeline(cp, "genealogy");
    if (!f.ok) return;

    const iv = iWarehouse("cause-1");
    submitIntervention(f.value.world, iv, f.value.engine);
    noteDivergence(f.value.world, [iv]);
    advance(f.value.world, f.value.engine, 5);

    const l = f.value.world.lineage;
    expect(l.worldId).toBe(world.lineage.worldId); // which world
    expect(l.timelineId).not.toBe(world.lineage.timelineId); // which timeline
    expect(l.parentCheckpointId).toBe(cp.identity.checkpointId); // from which checkpoint
    expect(l.forkTick).toBe(cp.identity.tick); // at which tick
    expect(l.divergenceInterventionIds).toEqual(["cause-1"]); // via which interventions
    expect(ancestryOf(l)).toEqual([world.lineage.timelineId, l.timelineId]); // descent chain
  });

  it("timeline ids are content-derived, so the same fork twice yields the same id", () => {
    const { world } = seededWorld();
    const cp = checkpoint(world);
    const a = forkTimeline(cp, "same-label");
    const b = forkTimeline(cp, "same-label");
    if (!a.ok || !b.ok) return;
    expect(a.value.timelineId).toBe(b.value.timelineId);
  });

  it("worldId is stable across forks and rewinds — one world, many timelines", () => {
    const { world, engine } = seededWorld();
    const worldId = world.lineage.worldId;
    const cp = checkpoint(world);
    advance(world, engine, 5);

    const f = forkTimeline(cp, "f");
    const rw = rewindTo(cp, world);
    if (!f.ok || !rw.ok) return;
    expect(f.value.world.lineage.worldId).toBe(worldId);
    expect(rw.value.world.lineage.worldId).toBe(worldId);
  });
});

// ===========================================================================
describe("§17.7 provenance persistence", () => {
  it("causal explanations survive a restore without provenance entering stateHash", () => {
    const { world, engine } = seededWorld();
    submitIntervention(world, iBridge(), engine);
    advance(world, engine, 5);

    const beforeEx = explain(world, key.price("RF", "grain"));
    expect(beforeEx.explained).toBe(true);
    expect(beforeEx.roots.length).toBeGreaterThan(0);

    const cp = checkpoint(world);
    const restored = structuredClone(cp.world);
    const afterEx = explain(restored, key.price("RF", "grain"));

    expect(afterEx.explained).toBe(true);
    expect(afterEx.roots.map((r) => r.interventionId)).toEqual(beforeEx.roots.map((r) => r.interventionId));
    expect(afterEx.paths).toEqual(beforeEx.paths);

    // and provenance is NOT in stateHash: stripping it must not change the world hash.
    // `dynamics` is deliberately NOT stripped here — §19.11 moved it into stateHash because
    // the tick reads it, so it is continuation state rather than history.
    const stripped = structuredClone(world);
    stripped.provenance = [];
    stripped.provenanceRefs = {};
    stripped.resolutionLog = [];
    stripped.diagnostics = [];
    stripped.interventionHistory = [];
    expect(stateHash(stripped)).toBe(stateHash(world));
    expect(traceHash(stripped)).not.toBe(traceHash(world));
  });

  it("a truncated causal history is flagged, and explanations admit incompleteness", () => {
    const { world, engine } = seededWorld();
    submitIntervention(world, iBridge(), engine);
    advance(world, engine, 3);
    expect(world.historyTruncated).toBe(false);

    // Simulate eviction of old nodes exactly as the ring buffer would.
    const evicted = structuredClone(world);
    const priceKey = key.price("RF", "grain");
    const refId = evicted.provenanceRefs[priceKey];
    expect(refId).toBeDefined();
    // drop the node the ref points at, as an overflowing buffer eventually would
    evicted.provenance = evicted.provenance.filter((n) => n.id !== refId);
    evicted.historyTruncated = true;

    const ex = explain(evicted, priceKey);
    // The honest answer is "I cannot fully explain this", NOT "nothing caused it".
    expect(ex.incomplete).toBe(true);
    expect(ex.danglingParents).toContain(refId!);
  });

  it("an explanation with a missing ancestor reports incomplete rather than a shortened chain", () => {
    const { world, engine } = seededWorld();
    submitIntervention(world, iBridge(), engine);
    advance(world, engine, 5);

    const trimmed = structuredClone(world);
    // remove the ROOT intervention node, keeping its descendants
    const rootIds = trimmed.provenance.filter((n) => n.kind === "intervention").map((n) => n.id);
    expect(rootIds.length).toBeGreaterThan(0);
    trimmed.provenance = trimmed.provenance.filter((n) => !rootIds.includes(n.id));
    trimmed.historyTruncated = true;

    const ex = explain(trimmed, key.price("RF", "grain"));
    expect(ex.incomplete).toBe(true);
    expect(ex.danglingParents.length).toBeGreaterThan(0);
    // it does not pretend the surviving nodes are the whole story
    expect(ex.roots).toHaveLength(0);
  });

  it("the truncation flag is part of traceHash, so history loss cannot be hidden", () => {
    const { world } = seededWorld();
    const a = structuredClone(world);
    const b = structuredClone(world);
    b.historyTruncated = true;
    expect(traceHash(b)).not.toBe(traceHash(a));
    // and it does not affect world identity
    expect(stateHash(b)).toBe(stateHash(a));
  });

  it("checkpoint identity surfaces the retention limits in force when it was written", () => {
    const { world } = seededWorld();
    const cp = checkpoint(world);
    expect(cp.identity.provenanceCheckpoint.limits.provenance).toBe(PROVENANCE_LIMIT);
    expect(cp.identity.provenanceCheckpoint.truncated).toBe(false);
  });
});

// ===========================================================================
describe("§17.3 process-boundary persistence (actually crossed)", () => {
  it("a checkpoint written by one process resumes identically in a FRESH process", () => {
    const { world, engine } = seededWorld();
    submitIntervention(world, iBridge(), engine);
    submitIntervention(world, iWarehouse(), engine);
    // capture with unresolved causal work pending
    expect(Object.keys(world.pendingContributions).length).toBeGreaterThan(0);

    const cp = createCheckpoint(world, "cross-process");
    const expected = continueFrom(world, 20);

    const dir = mkdtempSync(join(tmpdir(), "ce-proc-"));
    const file = join(dir, "checkpoint.json");
    try {
      writeFileSync(file, serializeCheckpoint(cp), "utf8");
      const stdout = execFileSync("npx", ["tsx", "src/poc/resume-worker.ts", file, "20"], {
        encoding: "utf8",
        shell: true,
        cwd: process.cwd(),
      });
      const lines = stdout.trim().split("\n");
      const result = JSON.parse(lines[lines.length - 1]!) as {
        ok: boolean;
        tick: number;
        stateHash: string;
        traceHash: string;
        rngState: { s: number };
      };

      expect(result.ok).toBe(true);
      expect(result.tick).toBe(expected.tick);
      expect(result.stateHash).toBe(stateHash(expected));
      expect(result.traceHash).toBe(traceHash(expected));
      expect(result.rngState.s).toBe(expected.rngState.s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("a corrupt checkpoint file fails in the child process too, with a non-zero exit", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-proc-bad-"));
    const file = join(dir, "bad.json");
    try {
      writeFileSync(file, '{"format":"ce-checkpoint","formatVersion":1}', "utf8");
      let failed = false;
      try {
        execFileSync("npx", ["tsx", "src/poc/resume-worker.ts", file, "5"], {
          encoding: "utf8",
          shell: true,
          cwd: process.cwd(),
          stdio: "pipe",
        });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
