/**
 * Public API surface tests (§21.22 acceptance test).
 *
 * Three suites:
 * 1. Misuse-attack: invalid inputs, stale ticks, missing targets
 * 2. Immutability/ownership: snapshot isolation, fork independence
 * 3. Full deterministic scenario: run entirely through public API
 */
import { describe, it, expect } from "vitest";
import {
  createEngine,
  createWorld,
  submitIntervention,
  tick,
  advance,
  snapshot,
  attachEngine,
  stateHash,
  traceHash,
  factStream,
  fullRecord,
  isConsumerFact,
  createCheckpoint,
  serializeCheckpoint,
  deserializeCheckpoint,
  validateCheckpoint,
  restoreCheckpoint,
  DEFAULT_CONFIG,
  makeConfig,
  type Engine,
  type WorldState,
  type Intervention,
} from "../api/public.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function minimalIntervention(overrides: Partial<Intervention> = {}): Intervention {
  return {
    id: `test-${Date.now()}`,
    tick: 0, // engine injects
    actor: "player",
    action: "destroy_infrastructure",
    target: { type: "infrastructure", id: "grain_road" },
    location: "RC",
    magnitude: 0.8,
    causalDomains: [
      { domain: "economy", pressure: 0.8, valence: 1, scope: "regional" },
    ],
    provenance: { submittedAtTick: 0, sequence: 0 },
    ...overrides,
  };
}

function freshWorld(): { engine: Engine; world: WorldState } {
  const engine = createEngine();
  const world = createWorld({ seed: 42 }, engine);
  return { engine, world };
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 1: MISUSE-ATTACK
// ═══════════════════════════════════════════════════════════════════════════

describe("Public API — misuse-attack", () => {
  it("rejects unknown action type", () => {
    const { engine, world } = freshWorld();
    const result = submitIntervention(world, minimalIntervention({ action: "nonexistent_action" }), engine);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("unknown action");
  });

  it("rejects disallowed target type", () => {
    const { engine, world } = freshWorld();
    // destroy_infrastructure only allows "infrastructure" targets
    const result = submitIntervention(
      world,
      minimalIntervention({ target: { type: "entity", id: "npc-1" } }),
      engine,
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("target type");
  });

  it("rejects intervention targeting unknown region", () => {
    const { engine, world } = freshWorld();
    const result = submitIntervention(
      world,
      minimalIntervention({ location: "NONEXISTENT" }),
      engine,
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("unknown region");
  });

  it("rejects intervention targeting nonexistent infrastructure", () => {
    const { engine, world } = freshWorld();
    const result = submitIntervention(
      world,
      minimalIntervention({ target: { type: "infrastructure", id: "fake_structure" }, location: "RF" }),
      engine,
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("not found");
  });

  it("accepts valid intervention", () => {
    const { engine, world } = freshWorld();
    const result = submitIntervention(
      world,
      minimalIntervention({ location: "RF", target: { type: "infrastructure", id: "grain_road" } }),
      engine,
    );
    expect(result.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 2: IMMUTABILITY / OWNERSHIP
// ═══════════════════════════════════════════════════════════════════════════

describe("Public API — immutability/ownership", () => {
  it("snapshot is a deep copy — mutating snapshot does not affect original", () => {
    const { world } = freshWorld();
    const beforeHash = stateHash(world);
    const snap = snapshot(world);

    // Mutate the snapshot
    snap.tick = 9999;
    snap.relations["test_relation"] = 42;

    // Original is unchanged
    expect(stateHash(world)).toBe(beforeHash);
    expect(world.tick).toBe(0);
    expect(world.relations["test_relation"]).toBeUndefined();
  });

  it("stateHash is stable across reads", () => {
    const { world } = freshWorld();
    const h1 = stateHash(world);
    const h2 = stateHash(world);
    expect(h1).toBe(h2);
  });

  it("stateHash changes after tick", () => {
    const { engine, world } = freshWorld();
    const h1 = stateHash(world);
    tick(world, engine);
    const h2 = stateHash(world);
    expect(h1).not.toBe(h2);
  });

  it("traceHash changes after successful intervention", () => {
    const { engine, world } = freshWorld();
    const h1 = traceHash(world);
    submitIntervention(
      world,
      minimalIntervention({ location: "RF", target: { type: "infrastructure", id: "grain_road" } }),
      engine,
    );
    const h2 = traceHash(world);
    expect(h1).not.toBe(h2);
  });

  it("factStream returns consumer-filtered events", () => {
    const { world } = freshWorld();
    const events = factStream(world);
    expect(Array.isArray(events)).toBe(true);
    // No events at tick 0
    expect(events.length).toBe(0);
  });

  it("fullRecord includes internal events", () => {
    const { world } = freshWorld();
    const all = fullRecord(world);
    expect(Array.isArray(all)).toBe(true);
  });

  it("isConsumerFact correctly filters", () => {
    // boundary_signal is internal, not a consumer fact
    const internalEvent = {
      id: "test",
      type: "world.boundary_signal",
      source: "test",
      data: {},
      tick: 0,
      ordinal: 0,
      streamSeq: 1,
    };
    expect(isConsumerFact(internalEvent)).toBe(false);

    const publicEvent = {
      id: "test2",
      type: "economy.price_change",
      source: "test",
      data: {},
      tick: 0,
      ordinal: 0,
      streamSeq: 1,
    };
    expect(isConsumerFact(publicEvent)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 3: FULL DETERMINISTIC SCENARIO (through public API only)
// ═══════════════════════════════════════════════════════════════════════════

describe("Public API — full deterministic scenario", () => {
  it("runs a complete game loop through public API only", () => {
    // 1. Create world
    const engine = createEngine();
    const world = createWorld({ seed: 42 }, engine);
    expect(world.tick).toBe(0);
    expect(world.config.seed).toBe(42);

    const h0 = stateHash(world);

    // 2. Run 30 ticks with no interventions
    advance(world, engine, 30);
    expect(world.tick).toBe(30);

    const h30 = stateHash(world);
    expect(h30).not.toBe(h0);

    // 3. Submit an intervention
    const result = submitIntervention(
      world,
      minimalIntervention({
        id: "bridge-destroy",
        action: "destroy_infrastructure",
        target: { type: "infrastructure", id: "grain_road" },
        location: "RF",
        magnitude: 0.8,
        causalDomains: [
          { domain: "economy", pressure: 0.8, valence: 1, scope: "regional" },
          { domain: "faction", pressure: 0.4, valence: 1, scope: "regional" },
        ],
      }),
      engine,
    );
    expect(result.ok).toBe(true);

    // 4. Run 20 more ticks
    advance(world, engine, 20);
    expect(world.tick).toBe(50);

    const h50 = stateHash(world);
    expect(h50).not.toBe(h30);

    // 5. Snapshot
    const snap = snapshot(world);
    expect(stateHash(snap)).toBe(stateHash(world));
    expect(snap.tick).toBe(50);

    // 6. Verify snapshot independence
    advance(world, engine, 10);
    expect(world.tick).toBe(60);
    expect(snap.tick).toBe(50); // snap unchanged
    expect(stateHash(snap)).not.toBe(stateHash(world));

    // 7. Events are present
    const events = factStream(world);
    expect(events.length).toBeGreaterThan(0);

    // 8. Determinism: re-run from same seed produces same hash
    const engine2 = createEngine();
    const world2 = createWorld({ seed: 42 }, engine2);
    // Replicate exact same sequence: 30 ticks, then intervention, then 20 ticks
    advance(world2, engine2, 30);
    submitIntervention(
      world2,
      minimalIntervention({
        id: "bridge-destroy",
        action: "destroy_infrastructure",
        target: { type: "infrastructure", id: "grain_road" },
        location: "RF",
        magnitude: 0.8,
        causalDomains: [
          { domain: "economy", pressure: 0.8, valence: 1, scope: "regional" },
          { domain: "faction", pressure: 0.4, valence: 1, scope: "regional" },
        ],
      }),
      engine2,
    );
    advance(world2, engine2, 20);
    expect(stateHash(world2)).toBe(h50);
  });

  it("checkpoint round-trip preserves stateHash", () => {
    const { engine, world } = freshWorld();
    advance(world, engine, 25);

    const h25 = stateHash(world);

    // Create checkpoint
    const env = createCheckpoint(world, "test-checkpoint");
    const serialized = serializeCheckpoint(env);

    // Deserialize
    const loaded = deserializeCheckpoint(serialized);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    // Validate
    const validated = validateCheckpoint(loaded.value);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    // Restore
    const restored = restoreCheckpoint(validated.value);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    // stateHash preserved
    expect(stateHash(restored.value.world)).toBe(h25);
    expect(restored.value.world.tick).toBe(25);
  });

  it("config and makeConfig are accessible", () => {
    expect(DEFAULT_CONFIG.seed).toBeDefined();
    const custom = makeConfig({ seed: 99, ledgerDecayPerTick: 0.5 });
    expect(custom.seed).toBe(99);
    expect(custom.ledgerDecayPerTick).toBe(0.5);
    // Other fields default
    expect(custom.convergenceEpsilon).toBe(DEFAULT_CONFIG.convergenceEpsilon);
  });

  it("attachEngine re-attaches to a snapshot", () => {
    const { engine, world } = freshWorld();
    advance(world, engine, 10);
    const snap = snapshot(world);

    // Create new engine, attach to snap
    const engine2 = createEngine();
    const reattached = attachEngine(snap, engine2);
    expect(reattached).toBe(engine2);

    // Can continue ticking from snapshot
    tick(snap, engine2);
    expect(snap.tick).toBe(11);
  });
});
