/**
 * CE Mac mini: deterministic replay smoke (ESM).
 * Run: npx tsx scripts/replay-smoke.ts
 */
import { createEngine, createWorld, submitIntervention, advance, stateHash, makeConfig } from "../src/api/public.js";

const iv = {
  id: "audit-1", tick: 0, actor: "audit",
  action: "destroy_infrastructure",
  target: { type: "infrastructure" as const, id: "grain_road" },
  location: "RF", magnitude: 1, causalDomains: [] as string[],
  provenance: { submittedAtTick: 0, sequence: 0 },
};

const run = (): string => {
  const e = createEngine();
  const w = createWorld(makeConfig({ seed: 42 }), e);
  submitIntervention(w, iv, e);
  advance(w, e, 5);
  return stateHash(w);
};

const a = run();
const b = run();
console.log(`replay identical: ${a === b}`);
console.log(`hash: ${a.slice(0, 16)}…`);
console.log(`expected (P-014 baseline): 5404d32e6ca92e9e…`);
console.log(`matches: ${a.startsWith("5404d32e")}`);
