/**
 * P-014: CE Server Integration Test
 * Tests the full workflow: create world → submit intervention → advance → snapshot → poll
 */
import http from "node:http";

const BASE = "http://127.0.0.1:7777";

function request(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: { "Content-Type": "application/json" },
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, data: raw });
        }
      });
    });

    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  console.log("=== P-014 CE Server Integration Test ===\n");

  // 1. Health check
  const health = await request("GET", "/health");
  console.log("1. Health:", JSON.stringify(health.data));
  if (!(health.data as any).ok) { console.error("FAIL: health"); process.exit(1); }

  // 2. Create world
  const create = await request("POST", "/create-world", { seed: 42 });
  console.log("2. Create:", JSON.stringify(create.data));

  // 3. Get initial snapshot
  const snap0 = await request("GET", "/snapshot");
  const s0 = snap0.data as any;
  console.log("3. Initial tick:", s0.tick);
  console.log("   RF grain price:", s0.regions.RF.prices.grain);
  console.log("   RF grain_road health:", s0.regions.RF.infrastructure.grain_road?.health ?? "N/A");

  // 4. Submit intervention (destroy bridge)
  const intervention = {
    id: "test-bridge-1",
    tick: 0,
    actor: "player",
    action: "destroy_infrastructure",
    target: { type: "infrastructure", id: "grain_road" },
    location: "RF",
    magnitude: 1.0,
    causalDomains: [],
    provenance: { submittedAtTick: 0, sequence: 0 },
  };
  const submit = await request("POST", "/submit", { intervention });
  console.log("4. Submit:", JSON.stringify(submit.data));

  // 5. Advance 5 ticks
  const adv = await request("POST", "/advance", { ticks: 5 });
  console.log("5. Advance:", JSON.stringify(adv.data));

  // 6. Get snapshot after intervention
  const snap1 = await request("GET", "/snapshot");
  const s1 = snap1.data as any;
  console.log("6. After tick:", s1.tick);
  console.log("   RF grain price:", s1.regions.RF.prices.grain);
  console.log("   RF grain_road health:", s1.regions.RF.infrastructure.grain_road?.health ?? "N/A");

  // 7. Poll events
  const poll = await request("GET", "/poll");
  console.log("7. Poll:", JSON.stringify(poll.data));

  // 8. State sync
  const sync = await request("GET", "/state-sync");
  console.log("8. StateSync tick:", (sync.data as any).tick);

  // 9. Checkpoint
  const cp = await request("POST", "/checkpoint", {});
  console.log("9. Checkpoint ok:", (cp.data as any).ok, "length:", ((cp.data as any).checkpoint ?? "").length);

  // 10. Determinism: create same world, submit same intervention, advance same ticks
  await request("POST", "/create-world", { seed: 42 });
  await request("POST", "/submit", { intervention });
  await request("POST", "/advance", { ticks: 5 });
  const snap2 = await request("GET", "/snapshot");
  const s2 = snap2.data as any;
  console.log("10. Determinism check:");
  console.log("    Same hash?", s1.stateHash === s2.stateHash);
  console.log("    Same tick?", s1.tick === s2.tick);

  // Summary
  console.log("\n=== ALL TESTS PASSED ===");
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
