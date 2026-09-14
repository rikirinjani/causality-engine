/**
 * P-018 probe: WS checkpoint round-trip against the real server (in-process).
 * Run: npx tsx src/poc/probe-ws-checkpoint.ts
 */
import WebSocket from "ws";
import { startCeWsServer } from "./ce-ws-server.js";

async function main() {
  const h = await startCeWsServer({ seed: 42 });
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}`);
  await new Promise<void>((r) => ws.on("open", () => r()));
  const wait = (t: string) =>
    new Promise<Record<string, unknown>>((r) => {
      const handler = (d: WebSocket.RawData) => {
        const m = JSON.parse(d.toString()) as Record<string, unknown>;
        if (m["type"] === t) { ws.off("message", handler); r(m); }
      };
      ws.on("message", handler);
    });

  ws.send(JSON.stringify({ type: "create-world", seed: 42 }));
  await wait("result");
  ws.send(JSON.stringify({
    type: "submit",
    intervention: {
      id: "x", tick: 0, actor: "p", action: "destroy_infrastructure",
      target: { type: "infrastructure", id: "grain_road" }, location: "RF",
      magnitude: 1, causalDomains: [], provenance: { submittedAtTick: 0, sequence: 0 },
    },
  }));
  await wait("result");
  ws.send(JSON.stringify({ type: "advance", ticks: 5 }));
  await wait("advanced");

  const t0 = Date.now();
  ws.send(JSON.stringify({ type: "checkpoint" }));
  const cp = await wait("checkpointed");
  console.log("checkpoint round-trip ms:", Date.now() - t0);
  console.log("checkpoint length:", String(cp["checkpoint"]).length);
  console.log("delivery length:", String(cp["delivery"]).length);
  console.log("PROBE OK");

  ws.close();
  await h.stop();
  process.exit(0);
}

main().catch((e) => { console.error("PROBE FAIL", e); process.exit(1); });
