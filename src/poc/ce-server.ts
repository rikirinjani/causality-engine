/**
 * P-014: CE HTTP Server — local IPC wrapper for Godot integration
 *
 * This server exposes CE's public API via HTTP endpoints.
 * Godot communicates with CE through this server (local IPC, not networking).
 *
 * Run: npx tsx src/poc/ce-server.ts
 *
 * Endpoints:
 * POST /create-world    — Create a new CE world
 * POST /submit          — Submit an intervention
 * POST /advance         — Advance simulation
 * GET  /poll            — Poll for events
 * POST /ack             — Acknowledge events
 * GET  /state-sync      — Get current state snapshot
 * POST /resync          — Recover from gap
 * POST /checkpoint      — Save state
 * POST /restore         — Restore state
 * GET  /health          — Health check
 */
import http from "node:http";
import {
  createEngine, createWorld, submitIntervention, advance, snapshot,
  stateHash, traceHash,
  createCheckpoint, serializeCheckpoint, deserializeCheckpoint,
  validateCheckpoint, restoreCheckpoint,
  makeConfig, attachEngine,
  poll, ack, stateSync, resync,
  createDeliveryState, registerConsumer,
  serializeDelivery, deserializeDelivery,
  enforceRetention, EVENT_RETENTION_LIMIT,
  type Engine, type WorldState, type Intervention, type DeliveryState,
} from "../api/public.js";

// ── State ──────────────────────────────────────────────────────────────────

let engine: Engine;
let world: WorldState;
let delivery: DeliveryState;
const CONSUMER_ID = "godot-adapter";

function initWorld(seed = 42) {
  engine = createEngine();
  world = createWorld(makeConfig({ seed }), engine);
  delivery = createDeliveryState();
  registerConsumer(delivery, CONSUMER_ID);
}

initWorld();

// ── HTTP Server ────────────────────────────────────────────────────────────

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString();
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // CORS headers for Godot
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    // Health check
    if (url.pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        tick: world.tick,
        stateHash: stateHash(world),
        traceHash: traceHash(world),
      });
      return;
    }

    // Create world
    if (url.pathname === "/create-world" && req.method === "POST") {
      const body = await parseBody(req);
      const seed = (body.seed as number) ?? 42;
      initWorld(seed);
      sendJson(res, 200, {
        ok: true,
        tick: world.tick,
        stateHash: stateHash(world),
      });
      return;
    }

    // Submit intervention
    if (url.pathname === "/submit" && req.method === "POST") {
      const body = await parseBody(req);
      const intervention = body.intervention as Intervention;
      if (!intervention) {
        sendJson(res, 400, { ok: false, error: "missing intervention" });
        return;
      }
      const result = submitIntervention(world, intervention, engine);
      sendJson(res, 200, {
        ok: result.ok,
        errors: result.errors,
        interventionSeq: world.interventionSeq,
      });
      return;
    }

    // Advance
    if (url.pathname === "/advance" && req.method === "POST") {
      const body = await parseBody(req);
      const ticks = (body.ticks as number) ?? 1;
      advance(world, engine, ticks);
      enforceRetention(world, EVENT_RETENTION_LIMIT);
      sendJson(res, 200, {
        ok: true,
        tick: world.tick,
        stateHash: stateHash(world),
      });
      return;
    }

    // Poll events
    if (url.pathname === "/poll" && req.method === "GET") {
      const result = poll(world, delivery, CONSUMER_ID);
      if (result.status === "deliverable") {
        const maxSeq = Math.max(...result.attempts.map((a) => a.streamSeq));
        ack(world, delivery, CONSUMER_ID, maxSeq);
        sendJson(res, 200, {
          status: "deliverable",
          events: result.attempts.map((a) => ({
            id: a.event.id,
            type: a.event.type,
            regionId: a.event.regionId,
            data: a.event.data,
            tick: a.event.tick,
            streamSeq: a.streamSeq,
          })),
        });
      } else {
        sendJson(res, 200, {
          status: result.status,
          events: [],
        });
      }
      return;
    }

    // Ack
    if (url.pathname === "/ack" && req.method === "POST") {
      const body = await parseBody(req);
      const streamSeq = body.streamSeq as number;
      const result = ack(world, delivery, CONSUMER_ID, streamSeq);
      sendJson(res, 200, {
        ok: result.ok,
        cursor: result.cursor,
      });
      return;
    }

    // State sync
    if (url.pathname === "/state-sync" && req.method === "GET") {
      const sync = stateSync(world);
      sendJson(res, 200, sync);
      return;
    }

    // Resync
    if (url.pathname === "/resync" && req.method === "POST") {
      const sync = stateSync(world);
      const result = resync(delivery, CONSUMER_ID, sync);
      sendJson(res, 200, {
        ok: result.ok,
        cursor: result.cursor,
      });
      return;
    }

    // Snapshot (full state for projection)
    if (url.pathname === "/snapshot" && req.method === "GET") {
      const snap = snapshot(world);
      sendJson(res, 200, {
        tick: snap.tick,
        stateHash: stateHash(world),
        traceHash: traceHash(world),
        regions: Object.fromEntries(
          Object.entries(snap.regions).map(([id, r]) => [
            id,
            {
              name: r.name,
              neighbors: r.neighbors,
              prices: r.prices,
              stocks: r.stocks,
              infrastructure: Object.fromEntries(
                Object.entries(r.infrastructure).map(([sid, s]) => [
                  sid,
                  { type: s.type, health: s.health, endpoints: s.endpoints },
                ]),
              ),
              unrest: r.unrest,
              patrolDemand: r.patrolDemand,
              tradeInvestment: r.tradeInvestment,
            },
          ]),
        ),
        relations: snap.relations,
        entities: Object.fromEntries(
          Object.entries(snap.entities).map(([id, e]) => [
            id,
            { id: e.id, type: e.type, role: e.role, location: e.location },
          ]),
        ),
      });
      return;
    }

    // Checkpoint
    if (url.pathname === "/checkpoint" && req.method === "POST") {
      const cp = createCheckpoint(world, "godot-save");
      const serialized = serializeCheckpoint(cp);
      const deliveryData = serializeDelivery(delivery);
      sendJson(res, 200, {
        ok: true,
        checkpoint: serialized,
        delivery: deliveryData,
      });
      return;
    }

    // Restore
    if (url.pathname === "/restore" && req.method === "POST") {
      const body = await parseBody(req);
      const env = deserializeCheckpoint(body.checkpoint as string);
      if (!env.ok) {
        sendJson(res, 400, { ok: false, error: "invalid checkpoint" });
        return;
      }
      const validated = validateCheckpoint(env.value);
      if (!validated.ok) {
        sendJson(res, 400, { ok: false, error: "checkpoint validation failed" });
        return;
      }
      const restored = restoreCheckpoint(validated.value);
      if (!restored.ok) {
        sendJson(res, 500, { ok: false, error: "restore failed" });
        return;
      }
      world = restored.value.world;
      engine = createEngine();
      attachEngine(world, engine);
      if (body.delivery) {
        delivery = deserializeDelivery(body.delivery as string);
      }
      registerConsumer(delivery, CONSUMER_ID);
      sendJson(res, 200, {
        ok: true,
        tick: world.tick,
        stateHash: stateHash(world),
      });
      return;
    }

    // 404
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    console.error("Server error:", e);
    sendJson(res, 500, { error: String(e) });
  }
});

const PORT = 7777;
server.listen(PORT, "127.0.0.1", () => {
  console.log(`CE Server running on http://127.0.0.1:${PORT}`);
  console.log("Endpoints:");
  console.log("  GET  /health");
  console.log("  POST /create-world");
  console.log("  POST /submit");
  console.log("  POST /advance");
  console.log("  GET  /poll");
  console.log("  POST /ack");
  console.log("  GET  /state-sync");
  console.log("  POST /resync");
  console.log("  GET  /snapshot");
  console.log("  POST /checkpoint");
  console.log("  POST /restore");
});
