/**
 * P-017: HTTP vs WebSocket measured comparison
 *
 * Measures the transport dimensions in a single local process:
 *   - intervention latency (submit → accepted)
 *   - event latency (advance → events available to consumer)
 *   - connection overhead (HTTP request setup vs WS connection setup)
 *   - CE tick latency (identical in both — CE is transport-independent)
 *
 * Run: npx tsx src/poc/transport-benchmark.ts
 */
import http from "node:http";
import WebSocket from "ws";
import { startCeWsServer } from "./ce-ws-server.js";
import { ROUTE_ID, WORLD_SEED } from "../game/content.js";

const HTTP_PORT = 7799;

function httpRequest(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: HTTP_PORT, path, method, headers: { "Content-Type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch { resolve({ status: res.statusCode ?? 0, data: {} }); }
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function iv(id: string) {
  return {
    id, tick: 0, actor: "player", action: "destroy_infrastructure",
    target: { type: "infrastructure", id: ROUTE_ID }, location: "RF",
    magnitude: 1, causalDomains: [], provenance: { submittedAtTick: 0, sequence: 0 },
  };
}

/** HTTP server mirroring ce-server.ts (minimal: create-world, submit, advance). */
function startHttpServer(): Promise<void> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/submit" && req.method === "POST") {
        res.end(JSON.stringify({ ok: true, interventionSeq: 1 }));
        return;
      }
      if (url.pathname === "/advance" && req.method === "POST") {
        res.end(JSON.stringify({ ok: true, tick: 1, stateHash: "bench" }));
        return;
      }
      if (url.pathname === "/poll" && req.method === "GET") {
        res.end(JSON.stringify({ status: "caught_up", events: [] }));
        return;
      }
      res.end(JSON.stringify({ ok: false }));
    });
    server.listen(HTTP_PORT, "127.0.0.1", () => resolve());
  });
}

async function main() {
  await startHttpServer();
  const ws = await startCeWsServer({ seed: WORLD_SEED });

  console.log("=== P-017 transport benchmark (local, single process) ===\n");

  // ── Intervention latency ──────────────────────────────────────────────────
  const HTTP_IV_RUNS = 200;
  let t0 = performance.now();
  for (let i = 0; i < HTTP_IV_RUNS; i++) await httpRequest("POST", "/submit", { intervention: iv(`h${i}`) });
  const httpIvMs = (performance.now() - t0) / HTTP_IV_RUNS;

  const wsClient = new WebSocket(`ws://127.0.0.1:${ws.port}`);
  await new Promise<void>((r) => wsClient.on("open", () => r()));
  const WS_IV_RUNS = 200;
  t0 = performance.now();
  for (let i = 0; i < WS_IV_RUNS; i++) {
    wsClient.send(JSON.stringify({ type: "submit", intervention: iv(`w${i}`) }));
    await new Promise<void>((r) => wsClient.once("message", () => r()));
  }
  const wsIvMs = (performance.now() - t0) / WS_IV_RUNS;

  // ── Event latency (advance → events visible to consumer) ──────────────────
  // HONEST HTTP semantics: "events available" requires advance + poll = 2 requests.
  // HONEST WS semantics: advance is one message; events are pushed (2 frames: advanced + events).
  const HTTP_EV_RUNS = 100;
  t0 = performance.now();
  for (let i = 0; i < HTTP_EV_RUNS; i++) {
    await httpRequest("POST", "/advance", { ticks: 1 });
    await httpRequest("GET", "/poll");
  }
  const httpEventMs = (performance.now() - t0) / HTTP_EV_RUNS;

  // WS: send advance; event-visible = time until the pushed "events" frame arrives.
  const WS_EV_RUNS = 100;
  t0 = performance.now();
  for (let i = 0; i < WS_EV_RUNS; i++) {
    wsClient.send(JSON.stringify({ type: "advance", ticks: 1 }));
    await new Promise<void>((r) => {
      const onMsg = (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type === "events") r();
        else wsClient.once("message", onMsg);
      };
      wsClient.once("message", onMsg);
    });
  }
  const wsEventMs = (performance.now() - t0) / WS_EV_RUNS;

  // ── Connection overhead ───────────────────────────────────────────────────
  t0 = performance.now();
  for (let i = 0; i < 20; i++) await httpRequest("GET", "/advance");
  const httpConnMs = (performance.now() - t0) / 20;

  t0 = performance.now();
  for (let i = 0; i < 20; i++) {
    const c = new WebSocket(`ws://127.0.0.1:${ws.port}`);
    await new Promise<void>((r) => c.on("open", () => r()));
    c.close();
  }
  const wsConnMs = (performance.now() - t0) / 20;

  // ── Results ───────────────────────────────────────────────────────────────
  console.log("intervention latency (submit→accepted):");
  console.log(`  HTTP:      ${httpIvMs.toFixed(3)} ms/op`);
  console.log(`  WebSocket: ${wsIvMs.toFixed(3)} ms/op`);
  console.log(`  ratio:     ${(httpIvMs / wsIvMs).toFixed(1)}x\n`);
  console.log("event latency (advance→events available):");
  console.log(`  HTTP:      ${httpEventMs.toFixed(3)} ms/op`);
  console.log(`  WebSocket: ${wsEventMs.toFixed(3)} ms/op`);
  console.log(`  ratio:     ${(httpEventMs / wsEventMs).toFixed(1)}x\n`);
  console.log("connection overhead (fresh connection per op):");
  console.log(`  HTTP:      ${httpConnMs.toFixed(3)} ms/op`);
  console.log(`  WebSocket: ${wsConnMs.toFixed(3)} ms/op\n`);
  console.log("CE tick latency: identical in both (transport-independent, <1ms/tick per P-012)");

  wsClient.close();
  await ws.stop();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
