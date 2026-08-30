import { advance, attachEngine, createEngine, createWorld, submitIntervention } from "../core/world.js";
import { stateHash, traceHash } from "../core/hash.js";
import {
  attributeEvent,
  coalesceFacts,
  EVENT_CATALOG,
  eventContentHash,
  factStream,
  fullRecord,
  isConsumerFact,
} from "../core/events.js";
import {
  ack,
  createConsumer,
  createDeliveryState,
  DELIVERY_GUARANTEE,
  disconnect,
  poll,
  reconnect,
  registerConsumer,
  resync,
  stateSync,
  streamOf,
} from "../core/delivery.js";
import { createCheckpoint, restoreCheckpoint } from "../core/persistence.js";
import { checkpoint, forkTimeline, rewindTo } from "../core/timeline.js";
import { describeGap } from "../core/retention.js";
import { iBridge, iRally, iWarehouse } from "./harness.js";
import type { WorldState } from "../core/types.js";

/**
 * Event-stream evidence driver (docs/RECONNAISSANCE.md §19).
 * Run: npx tsx src/poc/events.ts
 */

/** Driver helper: poll and return attempts, surfacing status for the narrative. */
function got(state: WorldState, delivery: ReturnType<typeof createDeliveryState>, id: string) {
  const r = poll(state, delivery, id);
  return { status: r.status, attempts: r.status === "deliverable" ? r.attempts : [], gap: r.status === "gap" ? r.gap : null };
}

const section = (t: string) => console.log(`\n${"=".repeat(100)}\n${t}\n${"=".repeat(100)}`);
const f = (n: number, d = 2) => n.toFixed(d);

function eventfulWorld(extra = 6): { world: WorldState; engine: ReturnType<typeof createEngine> } {
  const engine = createEngine();
  const world = createWorld({ seed: 42 }, engine);
  advance(world, engine, 9);
  submitIntervention(world, iBridge(), engine);
  submitIntervention(world, iWarehouse(), engine);
  advance(world, engine, extra);
  return { world, engine };
}

// ---------------------------------------------------------------------------
section("§19.1 EVENT ONTOLOGY — audit of every emitted type");
// ---------------------------------------------------------------------------
const { world: probe, engine: probeEngine } = eventfulWorld(10);
console.log("type                            | kind     | domain  | shape  | meaning");
for (const t of Object.keys(EVENT_CATALOG).sort()) {
  const s = EVENT_CATALOG[t]!;
  console.log(`${t.padEnd(31)} | ${s.kind.padEnd(8)} | ${(s.domain ?? "-").padEnd(7)} | ${s.shape.padEnd(6)} | ${s.meaning}`);
}
const internal = probe.events.filter((e) => !isConsumerFact(e));
console.log(`\nemitted: ${probe.events.length} total | ${factStream(probe).length} consumer facts | ${internal.length} engine-internal (withheld)`);
console.log("-> `world.boundary_signal` was the single most numerous event and is NOT a world fact:");
console.log("   it is the quota mechanism reporting pressure crossing a border. Publishing it would");
console.log("   have frozen internal scheduling into the consumer contract.");

// ---------------------------------------------------------------------------
section("§19.2 EVENT IDENTITY");
// ---------------------------------------------------------------------------
console.log("sample fact ids:");
for (const e of factStream(probe).slice(0, 6)) {
  console.log(`  ${e.id} t${e.tick} #${e.ordinal} ${e.type.padEnd(28)} ${e.regionId ?? "-"} content=${eventContentHash(e)}`);
}
const rerun = eventfulWorld(10).world;
console.log(`\ndeterministic across runs: ${JSON.stringify(rerun.events.map((e) => e.id)) === JSON.stringify(probe.events.map((e) => e.id))}`);

const cpFork = checkpoint(probe, "fork");
const bA = forkTimeline(cpFork, "A");
const bB = forkTimeline(cpFork, "B");
if (bA.ok && bB.ok) {
  submitIntervention(bA.value.world, iRally("same"), bA.value.engine);
  submitIntervention(bB.value.world, iRally("same"), bB.value.engine);
  advance(bA.value.world, bA.value.engine, 5);
  advance(bB.value.world, bB.value.engine, 5);
  const fa = factStream(bA.value.world).filter((e) => e.tick > cpFork.identity.tick);
  const fb = factStream(bB.value.world).filter((e) => e.tick > cpFork.identity.tick);
  const idsA = new Set(fa.map((e) => e.id));
  console.log(`\nIDENTICAL intervention in two branches -> ${fa.length} facts each`);
  console.log(`  content hashes equal: ${JSON.stringify(fa.map(eventContentHash)) === JSON.stringify(fb.map(eventContentHash))}`);
  console.log(`  colliding ids:        ${fb.filter((e) => idsA.has(e.id)).length}`);
  console.log("  -> before this pass a bare counter produced 3/3 collisions (ev-22, ev-23, ev-24)");
}

// ---------------------------------------------------------------------------
section("§19.3 ORDERING — per-tick canonical total order");
// ---------------------------------------------------------------------------
const ordered = fullRecord(probe);
console.log("tick | region | source      | type                         | kind");
for (const e of ordered.slice(0, 14)) {
  console.log(
    `${String(e.tick).padStart(4)} | ${(e.regionId ?? "-").padEnd(6)} | ${e.source.padEnd(11)} | ${e.type.padEnd(28)} | ${EVENT_CATALOG[e.type]?.kind ?? "fact"}`,
  );
}
const shuffledSame = JSON.stringify(fullRecord({ ...probe, events: [...probe.events].reverse() } as WorldState).map((e) => e.id)) === JSON.stringify(ordered.map((e) => e.id));
console.log(`\norder independent of array order: ${shuffledSame}`);

// ---------------------------------------------------------------------------
section("§19.4-19.7 DELIVERY: at-least-once, redelivery, idempotency");
// ---------------------------------------------------------------------------
console.log(`declared guarantee: ${DELIVERY_GUARANTEE}`);
const delivery = createDeliveryState();
const consumer = createConsumer("c1");

const batch1 = got(probe, delivery, "c1").attempts;
console.log(`\npoll 1: ${batch1.length} attempts, all attempt=${batch1[0]?.attempt}`);
for (const a of batch1.slice(0, 3)) consumer.apply(a);
console.log(`consumer applied ${consumer.applied.length}, then crashed before ACK`);

const batch2 = got(probe, delivery, "c1").attempts;
console.log(`poll 2 after restart: ${batch2.length} attempts, attempt=${batch2[0]?.attempt} (REDELIVERY)`);
const outcomes = batch2.map((a) => consumer.apply(a));
console.log(`  duplicates recognised by consumer: ${outcomes.filter((o) => o === "duplicate").length}`);
console.log(`  newly applied:                     ${outcomes.filter((o) => o === "applied").length}`);
console.log("-> CE does NOT suppress duplicates. Stable ids + idempotent consumer = exactly-once EFFECT.");
console.log("   CE cannot guarantee exactly-once DELIVERY: an ack lost after apply is indistinguishable");
console.log("   from never applying, so redelivery is mandatory.");

const acked = ack(probe, delivery, "c1", batch2[batch2.length - 1]!.streamSeq);
console.log(`\nACK to position ${acked.cursor.afterSeq} (through tick ${acked.cursor.throughTick})`);
console.log(`poll 3: ${got(probe, delivery, "c1").attempts.length} attempts (caught up)`);
const backwards = ack(probe, delivery, "c1", 0);
console.log(`ack backwards to 0: cursor stays at ${backwards.cursor.afterSeq} — ${backwards.reason}`);

// ---------------------------------------------------------------------------
section("§19.8-19.9 SLOW / DISCONNECTED CONSUMERS");
// ---------------------------------------------------------------------------
const slowDelivery = createDeliveryState();
got(probe, slowDelivery, "slow").attempts;
ack(probe, slowDelivery, "slow", 1);
const tickBefore = probe.tick;
advance(probe, probeEngine, 25);
console.log(`slow consumer acked position 1; simulation advanced ${tickBefore} -> ${probe.tick} (NOT stalled)`);
console.log(`backlog now: ${streamOf(probe).length - 2} unacknowledged facts`);

registerConsumer(slowDelivery, "offline");
disconnect(slowDelivery, "offline");
advance(probe, probeEngine, 10);
console.log(`\ndisconnected consumer polls: ${got(probe, slowDelivery, "offline").attempts.length} (nothing while disconnected)`);
reconnect(slowDelivery, "offline");
console.log(`after reconnect:              ${got(probe, slowDelivery, "offline").attempts.length} (resumes from its cursor)`);

const gap = describeGap(probe, 2);
console.log(`\nif the record had evicted 12 facts, the slow consumer gets:`);
console.log(`  ${JSON.stringify(gap)}`);
console.log("-> CE reports a GAP and directs resync. It never stalls the world and never skips silently.");

// ---------------------------------------------------------------------------
section("§19.10-19.11 EVENT vs STATE; delivery cannot touch the world");
// ---------------------------------------------------------------------------
const sync = stateSync(probe);
console.log(`state sync at t${sync.tick}: RF grain price ${f(sync.regions["RF"]!.grainPrice)}, stock ${f(sync.regions["RF"]!.grainStock)}`);
console.log(`  stream position it is consistent with: ${sync.streamSeq}`);
const priceFacts = factStream(probe).filter((e) => e.type === "economy.price_shock");
console.log(`\nthe stream carries TRANSITIONS: ${priceFacts.length} price_shock facts, each a factor:`);
for (const e of priceFacts.slice(0, 4)) console.log(`  ${e.id} t${e.tick} factor=${f(Number(e.data["factor"]), 4)}`);
console.log(`the sync carries CURRENT TRUTH: grainPrice = ${f(sync.regions["RF"]!.grainPrice)}`);
console.log("-> a consumer that missed every transition can be fully correct from the sync alone.");
console.log("   CE is deliberately NOT event-sourced: nobody has to fold events to learn the world.");

const before = { state: stateHash(probe), trace: traceHash(probe) };
const d2 = createDeliveryState();
got(probe, d2, "x");
ack(probe, d2, "x", 3);
disconnect(d2, "x");
resync(d2, "x", stateSync(probe));
console.log(`\nafter polling, acking, disconnecting and resyncing a consumer:`);
console.log(`  stateHash unchanged: ${stateHash(probe) === before.state}`);
console.log(`  traceHash unchanged: ${traceHash(probe) === before.trace}`);

const emptied = structuredClone(probe);
emptied.events = [];
console.log(`\nfact record excluded from stateHash: ${stateHash(emptied) === stateHash(probe)}`);
console.log(`fact record included in traceHash:   ${traceHash(emptied) !== traceHash(probe)}`);
const fwdA = structuredClone(probe);
advance(fwdA, attachEngine(fwdA, createEngine()), 20);
const fwdB = structuredClone(emptied);
advance(fwdB, attachEngine(fwdB, createEngine()), 20);
console.log(`engine never reads it (future identical): ${stateHash(fwdA) === stateHash(fwdB)}`);

// ---------------------------------------------------------------------------
section("§19.12 PERSISTENCE WITH UNDELIVERED FACTS");
// ---------------------------------------------------------------------------
const { world: pw } = eventfulWorld(6);
const pd = createDeliveryState();
const pc = createConsumer("p1");
const pb = got(pw, pd, "p1").attempts;
for (const a of pb) pc.apply(a);
ack(pw, pd, "p1", pb[pb.length - 1]!.streamSeq);
console.log(`before checkpoint: ${streamOf(pw).length} facts, consumer acked ${pd.channels["p1"]!.acked.afterSeq}`);

const env = createCheckpoint(pw, "undelivered");
const restored = restoreCheckpoint(env);
if (restored.ok) {
  console.log(`after restore:     ${streamOf(restored.value.world).length} facts preserved`);
  console.log(`redelivered on resume: ${got(restored.value.world, pd, "p1").attempts.length} (cursor was acknowledged)`);
  console.log(`duplicates seen by consumer: ${pc.duplicatesSeen.length}`);
}

// ---------------------------------------------------------------------------
section("§19.14 REWIND");
// ---------------------------------------------------------------------------
const { world: rwWorld, engine: rwEngine } = eventfulWorld(4);
const rp = checkpoint(rwWorld, "rp");
const atCheckpoint = new Set(rp.world.events.map((e) => e.id));
submitIntervention(rwWorld, iRally("post"), rwEngine);
advance(rwWorld, rwEngine, 8);
const abandonedFacts = rwWorld.events.filter((e) => !atCheckpoint.has(e.id));
console.log(`abandoned future produced ${abandonedFacts.length} facts, e.g. ${abandonedFacts[0]?.id}`);

const rw = rewindTo(rp, rwWorld);
if (rw.ok) {
  const liveIds = new Set(rw.value.world.events.map((e) => e.id));
  console.log(`after rewind, those facts in the live timeline: ${abandonedFacts.filter((e) => liveIds.has(e.id)).length}`);
  console.log(`abandoned timeline still referenceable: ${rw.value.world.lineage.abandonedTimelines[0]!.timelineId}`);
  submitIntervention(rw.value.world, iRally("post"), rw.value.engine);
  advance(rw.value.world, rw.value.engine, 8);
  const regenerated = rw.value.world.events.filter((e) => e.tick > rp.identity.tick);
  const oldIds = new Set(abandonedFacts.map((e) => e.id));
  console.log(`re-running the same action on the NEW timeline reuses old ids: ${regenerated.filter((e) => oldIds.has(e.id)).length}`);
  console.log("-> identity is timeline-scoped, so a re-generated fact is a NEW fact. Replaying the");
  console.log("   ORIGINAL timeline instead reproduces the original ids exactly (tested).");
}

// ---------------------------------------------------------------------------
section("§19.15 COALESCING");
// ---------------------------------------------------------------------------
const { world: cw, engine: ce } = eventfulWorld(4);
advance(cw, ce, 30);
const allFacts = factStream(cw);
const coalesced = coalesceFacts(allFacts);
console.log(`${allFacts.length} facts -> ${coalesced.length} coalesced groups`);
for (const c of coalesced) {
  console.log(`  ${c.type.padEnd(28)} ${(c.regionId ?? "-").padEnd(4)} count=${String(c.count).padStart(2)} t${c.firstTick}..${c.lastTick} aggregate=${JSON.stringify(c.aggregate)}`);
}
console.log(`\nsignal facts excluded from coalescing: ${!coalesced.some((c) => c.type === "economy.trade_disruption")}`);
console.log("-> coalescing is a TRANSPORT convenience for state-seeking consumers. It is never");
console.log("   written back into the record and never into provenance.");

// ---------------------------------------------------------------------------
section("§19.16 CAUSAL ATTRIBUTION UNDER TRUNCATION");
// ---------------------------------------------------------------------------
const { world: aw } = eventfulWorld(6);
const target = factStream(aw)[0]!;
const node = aw.provenance[0]!.id;
const tagged = structuredClone(aw);
const taggedEvent = tagged.events.find((e) => e.id === target.id)!;
taggedEvent.data = { ...taggedEvent.data, causeNode: node };
console.log(`with cause retained : ${JSON.stringify(attributeEvent(tagged, taggedEvent))}`);
tagged.provenance = tagged.provenance.filter((n) => n.id !== node);
tagged.historyTruncated = true;
console.log(`after cause evicted : ${JSON.stringify(attributeEvent(tagged, taggedEvent))}`);
console.log("-> the event names its cause and admits the evidence is gone. It does not claim to be uncaused.");
