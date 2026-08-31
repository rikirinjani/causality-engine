/**
 * P-017: CE WebSocket Push Server — transport-neutral delivery boundary
 *
 * WebSocket is a PUSH TRANSPORT over the SAME delivery contract as HTTP polling:
 *   poll/ack/stateSync/resync semantics are preserved; the server pushes what a
 *   polling adapter would have pulled. CE tick timing stays CLIENT-DRIVEN (the
 *   game sends `advance`); the server never ticks on its own. WS therefore adds
 *   no fourth causal clock: T_ce owns causality, T_adp owns visibility, T_render
 *   owns rendering — unchanged.
 *
 * Protocol (JSON text frames):
 *   Client → Server:
 *     {"type":"create-world","seed":42}
 *     {"type":"submit","intervention":{...}}
 *     {"type":"submit-batch","interventions":[{...}]}
 *     {"type":"advance","ticks":5}
 *     {"type":"ack","streamSeq":42}
 *     {"type":"state-sync"}
 *     {"type":"checkpoint"}
 *     {"type":"restore","checkpoint":"...","delivery":"..."}
 *     {"type":"ping"}
 *   Server → Client (push):
 *     {"type":"welcome","consumerId","tick","streamSeq","stateHash"}
 *     {"type":"events","events":[{eventId,attempt,streamSeq,event}]}   (delivery order)
 *     {"type":"gap","gap":{...RetentionGap}}                           (explicit, never silent)
 *     {"type":"sync","sync":{...StateSync}}
 *     {"type":"result","ok","errors","interventionSeq"}                (submit reply)
 *     {"type":"advanced","tick","stateHash","traceHash"}
 *     {"type":"checkpointed","checkpoint","delivery"}
 *     {"type":"restored","tick","stateHash"}
 *     {"type":"pong"}
 *
 * Backpressure: before pushing events the server checks `ws.bufferedAmount`.
 * If the socket is saturated, the server SKIPS the push for that round — the
 * consumer's cursor is NOT advanced, facts remain in CE's bounded retention,
 * and the consumer learns it fell behind via an explicit gap. CE's tick/advance
 * never blocks on the socket.
 *
 * Run standalone: npx tsx src/poc/ce-ws-server.ts   (port 7778)
 */
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import {
  createEngine, createWorld, submitIntervention, submitBatch, advance, snapshot,
  stateHash, traceHash,
  createCheckpoint, serializeCheckpoint, deserializeCheckpoint,
  validateCheckpoint, restoreCheckpoint,
  makeConfig, attachEngine,
  poll, ack, stateSync, resync,
  createDeliveryState, registerConsumer,
  serializeDelivery, deserializeDelivery,
  type Engine, type WorldState, type Intervention, type DeliveryState,
  type PollResult,
} from "../api/public.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface CeWsOptions {
  port?: number;
  seed?: number;
  /** Max bytes of unsent data before the server stops pushing (backpressure). */
  bufferedAmountLimit?: number;
}

export interface CeWsHandle {
  server: WebSocketServer;
  port: number;
  stop(): Promise<void>;
  getWorld(): WorldState;
  getDelivery(): DeliveryState;
  getEngine(): Engine;
}

// ── Runtime (shared world + delivery) ──────────────────────────────────────

interface Runtime {
  engine: Engine;
  world: WorldState;
  delivery: DeliveryState;
  consumerCount: number;
}

function createRuntime(seed: number): Runtime {
  const engine = createEngine();
  const world = createWorld(makeConfig({ seed }), engine);
  const delivery = createDeliveryState();
  return { engine, world, delivery, consumerCount: 0 };
}

// ── Message handling ───────────────────────────────────────────────────────

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function pushForConsumer(rt: Runtime, socket: WebSocket, consumerId: string, limit: number): void {
  // Backpressure: if the socket is saturated, skip pushing this round. The cursor is
  // NOT advanced; facts remain in CE retention; a later push or gap resolves it.
  if (socket.bufferedAmount > limit) {
    return;
  }
  const result: PollResult = poll(rt.world, rt.delivery, consumerId);
  if (result.status === "deliverable") {
    send(socket, {
      type: "events",
      events: result.attempts.map((a) => ({
        eventId: a.eventId,
        attempt: a.attempt,
        streamSeq: a.streamSeq,
        event: a.event,
      })),
    });
  } else if (result.status === "gap") {
    send(socket, { type: "gap", gap: result.gap });
  }
  // caught_up / disconnected / wrong_timeline: nothing to push (no spurious frames).
}

function handleMessage(rt: Runtime, socket: WebSocket, consumerId: string, raw: string, limit: number): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    send(socket, { type: "result", ok: false, errors: ["malformed JSON"] });
    return;
  }
  const type = msg["type"];

  switch (type) {
    case "create-world": {
      const seed = typeof msg["seed"] === "number" ? msg["seed"] : 42;
      const fresh = createRuntime(seed);
      rt.engine = fresh.engine;
      rt.world = fresh.world;
      rt.delivery = fresh.delivery;
      registerConsumer(rt.delivery, consumerId);
      send(socket, { type: "result", ok: true, tick: rt.world.tick, stateHash: stateHash(rt.world) });
      break;
    }
    case "submit": {
      const intervention = msg["intervention"] as Intervention;
      if (!intervention) {
        send(socket, { type: "result", ok: false, errors: ["missing intervention"] });
        break;
      }
      const result = submitIntervention(rt.world, intervention, rt.engine);
      send(socket, {
        type: "result",
        ok: result.ok,
        errors: result.errors,
        interventionSeq: rt.world.interventionSeq,
      });
      break;
    }
    case "submit-batch": {
      const interventions = (msg["interventions"] as Intervention[]) ?? [];
      const results = submitBatch(rt.world, interventions, rt.engine);
      send(socket, { type: "result", ok: true, results });
      break;
    }
    case "advance": {
      const ticks = typeof msg["ticks"] === "number" ? msg["ticks"] : 1;
      advance(rt.world, rt.engine, ticks);
      send(socket, {
        type: "advanced",
        tick: rt.world.tick,
        stateHash: stateHash(rt.world),
        traceHash: traceHash(rt.world),
      });
      // Push any facts this advance produced (delivery order), or an explicit gap.
      pushForConsumer(rt, socket, consumerId, limit);
      break;
    }
    case "ack": {
      const streamSeq = msg["streamSeq"] as number;
      const result = ack(rt.world, rt.delivery, consumerId, streamSeq);
      send(socket, { type: "result", ok: result.ok, cursor: result.cursor, reason: result.reason });
      break;
    }
    case "state-sync": {
      send(socket, { type: "sync", sync: stateSync(rt.world) });
      break;
    }
    case "snapshot": {
      // Mirror the HTTP /snapshot projection (regions incl. infrastructure health)
      // so either transport exposes the same state to the game.
      const snap = snapshot(rt.world);
      send(socket, {
        type: "snapshot",
        tick: snap.tick,
        stateHash: stateHash(rt.world),
        traceHash: traceHash(rt.world),
        regions: Object.fromEntries(
          Object.entries(snap.regions).map(([id, r]) => [
            id,
            {
              name: r.name,
              prices: r.prices,
              stocks: r.stocks,
              infrastructure: Object.fromEntries(
                Object.entries(r.infrastructure).map(([sid, s]) => [sid, { type: s.type, health: s.health }]),
              ),
              unrest: r.unrest,
              patrolDemand: r.patrolDemand,
              tradeInvestment: r.tradeInvestment,
            },
          ]),
        ),
        relations: snap.relations,
      });
      break;
    }
    case "resync": {
      const sync = msg["sync"] as Parameters<typeof resync>[2];
      if (!sync) {
        send(socket, { type: "result", ok: false, errors: ["missing sync"] });
        break;
      }
      const result = resync(rt.delivery, consumerId, sync);
      send(socket, { type: "result", ok: result.ok, cursor: result.cursor, reason: result.reason });
      break;
    }
    case "checkpoint": {
      const cp = serializeCheckpoint(createCheckpoint(rt.world, "ws-save"));
      const dlv = serializeDelivery(rt.delivery);
      send(socket, { type: "checkpointed", checkpoint: cp, delivery: dlv });
      break;
    }
    case "restore": {
      try {
        const env = deserializeCheckpoint(msg["checkpoint"] as string);
        if (!env.ok) { send(socket, { type: "result", ok: false, errors: ["invalid checkpoint"] }); break; }
        const validated = validateCheckpoint(env.value);
        if (!validated.ok) { send(socket, { type: "result", ok: false, errors: ["checkpoint validation failed"] }); break; }
        const restored = restoreCheckpoint(validated.value);
        if (!restored.ok) { send(socket, { type: "result", ok: false, errors: ["restore failed"] }); break; }
        rt.world = restored.value.world;
        rt.engine = createEngine();
        attachEngine(rt.world, rt.engine);
        if (typeof msg["delivery"] === "string") {
          rt.delivery = deserializeDelivery(msg["delivery"]);
        }
        registerConsumer(rt.delivery, consumerId);
        send(socket, { type: "restored", tick: rt.world.tick, stateHash: stateHash(rt.world) });
      } catch (e) {
        send(socket, { type: "result", ok: false, errors: [String(e)] });
      }
      break;
    }
    case "ping": {
      send(socket, { type: "pong", tick: rt.world.tick, stateHash: stateHash(rt.world) });
      break;
    }
    default:
      send(socket, { type: "result", ok: false, errors: [`unknown message type: ${String(type)}`] });
  }
}

// ── Factory (used by tests) and standalone entry ───────────────────────────

export function startCeWsServer(opts: CeWsOptions = {}): Promise<CeWsHandle> {
  const port = opts.port ?? 0;
  const seed = opts.seed ?? 42;
  const limit = opts.bufferedAmountLimit ?? 64 * 1024; // 64 KiB default
  const rt = createRuntime(seed);

  const wss = new WebSocketServer({ port, host: "127.0.0.1" });

  wss.on("connection", (socket) => {
    const consumerId = `ws-${++rt.consumerCount}`;
    registerConsumer(rt.delivery, consumerId);
    send(socket, {
      type: "welcome",
      consumerId,
      tick: rt.world.tick,
      streamSeq: rt.world.highestEmittedSeq,
      stateHash: stateHash(rt.world),
    });
    // Catch-up on connect: deliver everything already retained (or an explicit gap).
    pushForConsumer(rt, socket, consumerId, limit);

    socket.on("message", (data) => {
      handleMessage(rt, socket, consumerId, data.toString(), limit);
    });
    socket.on("close", () => {
      // DeliveryState is OUTSIDE WorldState: a disconnect must not touch simulation.
      // Cursor persists; reconnect redelivers from it (at-least-once).
      const ch = rt.delivery.channels[consumerId];
      if (ch) ch.connected = false;
    });
  });

  return new Promise((resolve) => {
    wss.on("listening", () => {
      const address = wss.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        server: wss,
        port: actualPort,
        async stop() {
          for (const client of wss.clients) client.terminate();
          await new Promise<void>((r) => wss.close(() => r()));
        },
        getWorld: () => rt.world,
        getDelivery: () => rt.delivery,
        getEngine: () => rt.engine,
      });
    });
  });
}

// Standalone entry: npx tsx src/poc/ce-ws-server.ts
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop() ?? "");
if (isMain) {
  const PORT = 7778;
  startCeWsServer({ port: PORT, seed: 42 }).then((h) => {
    console.log(`CE WebSocket server running on ws://127.0.0.1:${h.port}`);
    console.log(`  (also reachable at ws://127.0.0.1:${PORT})`);
  });
}
