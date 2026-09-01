import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepare, preflight } from "../src/adapter.mjs";

const config = { serverUrl: "https://bridge.example.com", connectionId: "dbc_0123456789abcdef01234567", connectionSecret: "s".repeat(48), lane: "hugo-demo" };
const manifest = { site_origin: "https://hugo.example.com", pages: [
  { key: "to-bridge", mode: "to_discourse", canonical_url: "https://hugo.example.com/to/", title: "To Bridge", content_html: "<h2>Article</h2>\n<p>Useful content.</p>\n<section class=\"discussionbridge-presentation\"><p>Preparing</p></section>" },
  { key: "from-bridge", mode: "from_discourse", canonical_url: "https://hugo.example.com/from/", title: "From Bridge", resource_id: "11111111-1111-4111-8111-111111111111" },
  { key: "simple", mode: "simple", canonical_url: "https://hugo.example.com/simple/", title: "Simple", topic_id: 23 }
] };

test("whole-corpus preflight is deterministic and rejects collisions", () => {
  assert.deepEqual(preflight(manifest, { ...config }).map((p) => p.key), ["from-bridge", "simple", "to-bridge"]);
  const collision = structuredClone(manifest); collision.pages[1].canonical_url = collision.pages[0].canonical_url;
  assert.throws(() => preflight(collision, { ...config }), /Duplicate canonical URL/);
});

test("prepare resolves and retrieves then writes only nonsecret presentation state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-"));
  const manifestPath = path.join(dir, "manifest.json"); const outputPath = path.join(dir, "records.json");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(manifestPath, JSON.stringify(manifest)));
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    if (init.method === "POST") return new Response(JSON.stringify({ outcome: "created", core_fallback: false, direction: "to_discourse", resource_id: "22222222-2222-4222-8222-222222222222", topic_id: 21, topic_url: "https://bridge.example.com/t/to-bridge/21" }), { status: 201, headers: { "content-type": "application/json" } });
    if (String(url).includes("/t/23.json")) return new Response(JSON.stringify({ slug: "simple", post_stream: { stream: [230, 231], posts: [{ id: 230, post_number: 1, username: "author", created_at: "2026-08-31T00:00:00Z", cooked: "<p>First post</p>" }, { id: 231, post_number: 2, username: "doc-bot", name: "Doc Bot", created_at: "2026-08-31T01:00:00Z", cooked: "<p>Helpful reply.</p>", avatar_template: "/letter_avatar_proxy/v4/letter/d/{size}.png" }] } }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ bridge_record: { resource_id: "11111111-1111-4111-8111-111111111111", direction: "from_discourse", state: "healthy", title: "Forum article", topic_id: 22, topic_url: "https://bridge.example.com/t/from-bridge/22", content_html: "<h2>Forum owned</h2><script>bad()</script><p>Safe.</p>" } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await prepare({ manifestPath, outputPath, config: { ...config }, fetchImpl });
  assert.deepEqual(result, { pages: 3, records: 3 });
  assert.equal(requests.length, 3);
  assert.equal(requests.every((r) => r.init.redirect === "error"), true);
  const requestBody = JSON.parse(requests.find((r) => r.init.method === "POST").init.body).bridge_record;
  assert.match(requestBody.external_id, /^hugo-page:[0-9a-f]{64}$/);
  assert.doesNotMatch(requestBody.content_html, /Preparing|discussionbridge-presentation/);
  const output = await readFile(outputPath, "utf8");
  assert.doesNotMatch(output, /ssssssss/);
  assert.doesNotMatch(output, /script|bad\(\)/);
  assert.match(output, /Forum owned/);
  assert.match(output, /Helpful reply/);
  assert.doesNotMatch(output, /First post/);
});

test("invalid later page prevents every request and output write", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-"));
  const manifestPath = path.join(dir, "manifest.json"); const outputPath = path.join(dir, "records.json");
  const invalid = structuredClone(manifest); invalid.pages.push({ key: "bad", mode: "to_discourse", canonical_url: "https://evil.example/bad/", title: "Bad", content_html: "<p>Bad</p>" });
  await import("node:fs/promises").then(({ writeFile }) => writeFile(manifestPath, JSON.stringify(invalid)));
  let calls = 0;
  await assert.rejects(() => prepare({ manifestPath, outputPath, config: { ...config }, fetchImpl: async () => { calls++; } }), /outside the Hugo site origin/);
  assert.equal(calls, 0);
  await assert.rejects(() => readFile(outputPath), /ENOENT/);
});
