import { describe, expect, it } from "vitest";
import { advance, createEngine, createWorld } from "../core/world.js";
import { sortKeys, stateHash } from "../core/hash.js";
import { makeConfig } from "../core/config.js";
import { WORLD_SEED } from "../game/content.js";
import type { WorldState } from "../core/types.js";

/**
 * Regression tests for the `__proto__` stateHash defect (QMS NCR-2026-001).
 *
 * `Entity.attrs` (core/types.ts §169) is `Record<string, number | string | boolean>` —
 * arbitrary keys are legal. `deserializeCheckpoint` uses a raw `JSON.parse`
 * (core/persistence.ts:458), and V8's JSON.parse creates a REAL own data property for
 * the key `__proto__` (CreateDataProperty semantics, not the assignment semantics that
 * trigger the inherited setter). So an own `__proto__` data key can be live in a
 * restored world.
 *
 * The old `sortKeys` built its output with `out[k] = ...`. For `k === "__proto__"`
 * that assignment invokes the `Object.prototype.__proto__` setter instead of creating
 * an own key — the data is silently dropped from the canonical JSON, and two worlds
 * differing only by that key hashed identically under `stateHash`.
 *
 * Every invariant the fix must hold is pinned here:
 *   - own `__proto__` data keys survive canonicalization (the fix),
 *   - stateHash no longer collides on worlds differing only by that key (the defect),
 *   - ordinary data canonicalizes byte-identically to the pre-fix output (zero drift,
 *     required by the P-019 research freeze).
 */

type Attrs = Record<string, number | string | boolean>;

/** Rebuild attrs so the FIRST key is an own `__proto__` data key, exactly as raw JSON.parse of a crafted save would produce. */
function attrsWithProtoKey(attrs: Attrs, value: number | string | boolean = "injected"): Attrs {
  return JSON.parse(JSON.stringify(attrs).replace("{", `{"__proto__":${JSON.stringify(value)},`));
}

/** A real world (JSON round-trip, mirroring the persistence path) with exactly one entity's attrs carrying an own `__proto__` key. */
function poisonedCloneOf(world: WorldState): { control: WorldState; poisoned: WorldState; entityId: string } {
  const control = JSON.parse(JSON.stringify(world)) as WorldState;
  const poisoned = JSON.parse(JSON.stringify(world)) as WorldState;
  const entityId = Object.keys(poisoned.entities).sort()[0]!;
  poisoned.entities[entityId]!.attrs = attrsWithProtoKey(poisoned.entities[entityId]!.attrs);
  return { control, poisoned, entityId };
}

describe("hash: own `__proto__` data keys (NCR-2026-001)", () => {
  it("(a) an own `__proto__` key survives sortKeys and appears in the canonical JSON", () => {
    const src = JSON.parse('{"__proto__":"data","a":1}') as Record<string, unknown>;
    // the defect's precondition: JSON.parse really did create an own data key
    expect(Object.prototype.hasOwnProperty.call(src, "__proto__")).toBe(true);

    const sorted = sortKeys(src) as Record<string, unknown>;
    expect(Object.getOwnPropertyNames(sorted).sort()).toEqual(["__proto__", "a"]);
    // sorted order: "__proto__" (0x5f) sorts before "a" (0x61)
    expect(JSON.stringify(sorted)).toBe('{"__proto__":"data","a":1}');
  });

  it("(b) stateHash no longer collides for two world-shaped objects differing ONLY by an own `__proto__` key", () => {
    const engine = createEngine();
    const world = createWorld(makeConfig({ seed: WORLD_SEED }), engine);
    advance(world, engine, 10);

    const { control, poisoned, entityId } = poisonedCloneOf(world);
    // the two worlds differ ONLY by that one key
    expect(Object.prototype.hasOwnProperty.call(poisoned.entities[entityId]!.attrs, "__proto__")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(control.entities[entityId]!.attrs, "__proto__")).toBe(false);
    // ...and that key is real data: JSON.stringify sees it (this is what stateHash must hash)
    expect(JSON.stringify(poisoned.entities[entityId]!.attrs)).not.toBe(JSON.stringify(control.entities[entityId]!.attrs));

    expect(stateHash(poisoned)).not.toBe(stateHash(control));
    // the fix must not pay for its lunch with prototype pollution
    expect((Object.prototype as Record<string, unknown>).injected).toBeUndefined();
  });

  it("(c) persistence round-trip: attrs gaining `__proto__` via JSON.parse keep the key and change stateHash", () => {
    const engine = createEngine();
    const world = createWorld(makeConfig({ seed: WORLD_SEED }), engine);
    advance(world, engine, 5);

    const { control, poisoned, entityId } = poisonedCloneOf(world);
    // core/persistence.ts:458 path — raw JSON.parse yields a REAL own data key
    const parsedAttrs = poisoned.entities[entityId]!.attrs;
    expect(Object.prototype.hasOwnProperty.call(parsedAttrs, "__proto__")).toBe(true);

    // key preserved through canonicalization
    expect(JSON.stringify(sortKeys(parsedAttrs))).toContain('"__proto__":"injected"');

    // and the parsed world's identity reflects it
    expect(stateHash(poisoned)).not.toBe(stateHash(control));
  });

  it("(d) golden: canonical stringify of ordinary objects/arrays is byte-identical to the expected literals (zero drift)", () => {
    expect(JSON.stringify(sortKeys({ b: 2, a: 1 }))).toBe('{"a":1,"b":2}');
    expect(JSON.stringify(sortKeys({ z: { d: 4, c: 3 }, y: [3, 1, { k: 2, j: 1 }] }))).toBe(
      '{"y":[3,1,{"j":1,"k":2}],"z":{"c":3,"d":4}}',
    );
    expect(JSON.stringify(sortKeys([2, 1, { b: 1, a: 0 }]))).toBe('[2,1,{"a":0,"b":1}]');
    expect(JSON.stringify(sortKeys({ s: "x", n: 1, f: 0.5, t: true, no: false, nil: null, e: {} }))).toBe(
      '{"e":{},"f":0.5,"n":1,"nil":null,"no":false,"s":"x","t":true}',
    );
    // insertion order never leaks into the canonical form
    expect(JSON.stringify(sortKeys({ a: 1, b: 2 }))).toBe(JSON.stringify(sortKeys({ b: 2, a: 1 })));
    // and a real world's canonical form round-trips stably (order already sorted)
    const engine = createEngine();
    const world = createWorld(makeConfig({ seed: WORLD_SEED }), engine);
    advance(world, engine, 3);
    const once = JSON.stringify(sortKeys(world));
    const twice = JSON.stringify(sortKeys(JSON.parse(once)));
    expect(twice).toBe(once);
  });

  it("(e) recursive cases: nested objects and array elements carry their own `__proto__` keys through", () => {
    const nested = JSON.parse('{"outer":{"__proto__":"deep","z":1},"arr":[{"__proto__":"in-array"},2]}');
    expect(JSON.stringify(sortKeys(nested))).toBe('{"arr":[{"__proto__":"in-array"},2],"outer":{"__proto__":"deep","z":1}}');
  });

  it("(f) a primitive `__proto__` value does not crash and the key is preserved", () => {
    for (const value of ["x", 7]) {
      const src = JSON.parse(`{"__proto__":${JSON.stringify(value)}}`) as Record<string, unknown>;
      const sorted = sortKeys(src) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(sorted, "__proto__")).toBe(true);
      expect(sorted["__proto__"]).toBe(value);
      expect(JSON.stringify(sorted)).toBe(`{"__proto__":${JSON.stringify(value)}}`);
    }
  });
});
