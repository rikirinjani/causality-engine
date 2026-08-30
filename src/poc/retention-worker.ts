/**
 * Retention restart worker (docs/RECONNAISSANCE.md §20.14).
 *
 * Loads a checkpoint AND an externally-persisted delivery state, resumes in a FRESH PROCESS,
 * polls as the named consumer, and reports what it saw. Exists to prove that retention metadata
 * and cursors survive a real process boundary under the chosen ownership model — CE persists the
 * boundary inside the world, the ADAPTER persists the cursor beside it.
 *
 * Usage: tsx src/poc/retention-worker.ts <checkpointFile> <deliveryFile> <consumerId> <ticks>
 */
import { readFileSync } from "node:fs";
import { advance, attachEngine, createEngine } from "../core/world.js";
import { stateHash, traceHash } from "../core/hash.js";
import { deserializeCheckpoint, restoreCheckpoint } from "../core/persistence.js";
import { deserializeDelivery, poll, ack, serializeDelivery } from "../core/delivery.js";
import { retentionWindow } from "../core/retention.js";
import { EVENT_RETENTION_LIMIT } from "../core/retention.js";

function main(): void {
  const [cpFile, deliveryFile, consumerId, ticksArg] = process.argv.slice(2);
  if (!cpFile || !deliveryFile || !consumerId) {
    console.log(JSON.stringify({ ok: false, error: "usage: retention-worker <cp> <delivery> <consumerId> [ticks]" }));
    process.exit(2);
  }

  const parsed = deserializeCheckpoint(readFileSync(cpFile, "utf8"));
  if (!parsed.ok) {
    console.log(JSON.stringify({ ok: false, error: "deserialize failed", errors: parsed.errors }));
    process.exit(1);
  }
  const restored = restoreCheckpoint(parsed.value);
  if (!restored.ok) {
    console.log(JSON.stringify({ ok: false, error: "restore failed", errors: restored.errors }));
    process.exit(1);
  }

  const world = restored.value.world;
  const engine = attachEngine(world, createEngine());
  const delivery = deserializeDelivery(readFileSync(deliveryFile, "utf8"));

  const ticks = Number(ticksArg ?? 0);
  if (ticks > 0) advance(world, engine, ticks);

  const result = poll(world, delivery, consumerId);
  let ackedTo: number | null = null;
  if (result.status === "deliverable") {
    const last = result.attempts[result.attempts.length - 1]!;
    ack(world, delivery, consumerId, last.streamSeq);
    ackedTo = last.streamSeq;
  }

  console.log(
    JSON.stringify({
      ok: true,
      tick: world.tick,
      stateHash: stateHash(world),
      traceHash: traceHash(world),
      window: retentionWindow(world, EVENT_RETENTION_LIMIT),
      pollStatus: result.status,
      delivered: result.attempts.map((a) => ({ eventId: a.eventId, streamSeq: a.streamSeq, attempt: a.attempt })),
      gap: result.status === "gap" ? result.gap : null,
      ackedTo,
      cursorAfter: delivery.channels[consumerId]?.acked ?? null,
      deliveryState: serializeDelivery(delivery),
    }),
  );
}

main();
