import { readFile } from "node:fs/promises";
import { prepare } from "../src/adapter.mjs";

const [manifestPath, outputPath, statePath] = process.argv.slice(2);
if (!manifestPath || !outputPath || !statePath) throw new Error("Fixture paths are required.");

await prepare({
  manifestPath,
  outputPath,
  statePath,
  config: {
    serverUrl: "https://bridge.example.com",
    connectionId: "dbc_0123456789abcdef01234567",
    connectionSecret: "s".repeat(48),
    lane: "hugo-demo",
  },
  fetchImpl: async () => new Response(JSON.stringify({
    outcome: "created",
    core_fallback: false,
    direction: "to_discourse",
    resource_id: "22222222-2222-4222-8222-222222222222",
    topic_id: 21,
    topic_url: "https://bridge.example.com/t/to-bridge/21",
  }), { status: 201, headers: { "content-type": "application/json" } }),
  dependencies: {
    lockOptions: { staleMs: 2_000, updateMs: 1_000 },
    afterResultStaged: async () => {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const operation = Object.values(state.operations)[0];
      process.stdout.write(`${JSON.stringify({
        correlationId: operation.correlationId,
        externalId: operation.externalId,
      })}\n`);
      await new Promise(() => {});
    },
  },
});
