import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepare, preflight, syncNativePublications } from "../src/adapter.mjs";
import { readOperationalState, summarizeOperationalState } from "../src/operational-state.mjs";
import { PRODUCT_VERSION } from "../src/version.mjs";

const config = { serverUrl: "https://bridge.example.com", connectionId: "dbc_0123456789abcdef01234567", connectionSecret: "s".repeat(48), lane: "hugo-demo" };
const manifest = { site_origin: "https://hugo.example.com", pages: [
  { key: "to-bridge", mode: "to_discourse", canonical_url: "https://hugo.example.com/to/", title: "To Bridge", content_html: "<h2>Article</h2>\n<p>Useful content.</p>\n<section class=\"discussionbridge-presentation\"><p>Preparing</p></section>" },
  { key: "from-bridge", mode: "from_discourse", canonical_url: "https://hugo.example.com/from/", title: "From Bridge", resource_id: "11111111-1111-4111-8111-111111111111" },
  { key: "simple", mode: "simple", canonical_url: "https://hugo.example.com/simple/", title: "Simple", topic_id: 23 }
] };

test("package and runtime versions are identical", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(pkg.version, PRODUCT_VERSION);
  assert.equal(lock.version, PRODUCT_VERSION);
  assert.equal(lock.packages[""].version, PRODUCT_VERSION);
});

test("whole-corpus preflight is deterministic and rejects collisions", () => {
  assert.deepEqual(preflight(manifest, { ...config }).map((p) => p.key), ["from-bridge", "simple", "to-bridge"]);
  const collision = structuredClone(manifest); collision.pages[1].canonical_url = collision.pages[0].canonical_url;
  assert.throws(() => preflight(collision, { ...config }), /Duplicate canonical URL/);
  assert.throws(() => preflight(manifest, { ...config, connectionSecret: "s".repeat(31) }), /connection secret/);
  assert.throws(() => preflight(manifest, { ...config, connectionSecret: "é".repeat(129) }), /connection secret/);
  assert.throws(() => preflight(manifest, { ...config, connectionSecret: `${"s".repeat(32)}\n` }), /connection secret/);
  assert.throws(() => preflight(manifest, { ...config, lane: "Bad Lane" }), /lane/);
});

test("prepare resolves and retrieves then writes only nonsecret presentation state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-"));
  const manifestPath = path.join(dir, "manifest.json"); const outputPath = path.join(dir, "records.json");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(manifestPath, JSON.stringify(manifest)));
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    if (new URL(url).pathname === "/") {
      const settings = JSON.stringify({ enable_powered_by_discourse: true });
      const preload = JSON.stringify({ siteSettings: settings });
      return new Response(`<script type="application/json" id="data-preloaded">${preload}</script>`, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (init.method === "POST") return new Response(JSON.stringify({ outcome: "created", core_fallback: false, direction: "to_discourse", resource_id: "22222222-2222-4222-8222-222222222222", topic_id: 21, topic_url: "https://bridge.example.com/t/to-bridge/21" }), { status: 201, headers: { "content-type": "application/json" } });
    if (String(url).includes("/t/23.json")) return new Response(JSON.stringify({ slug: "simple", post_stream: { stream: [230, 231], posts: [{ id: 230, post_number: 1, username: "author", created_at: "2026-08-31T00:00:00Z", cooked: "<p>First post</p>" }, { id: 231, post_number: 2, username: "doc-bot", name: "Doc Bot", created_at: "2026-08-31T01:00:00Z", cooked: "<p>Helpful reply.</p>", avatar_template: "/letter_avatar_proxy/v4/letter/d/{size}.png" }] } }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ bridge_record: { resource_id: "11111111-1111-4111-8111-111111111111", direction: "from_discourse", state: "healthy", title: "Forum article", topic_id: 22, topic_url: "https://bridge.example.com/t/from-bridge/22", content_html: "<h2>Forum owned</h2><script>bad()</script><p>Safe.</p>" } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await prepare({ manifestPath, outputPath, config: { ...config }, fetchImpl });
  assert.deepEqual(result, { pages: 3, records: 3 });
  assert.equal(requests.length, 4);
  assert.equal(requests.every((r) => r.init.redirect === "error"), true);
  assert.match(requests.find((r) => new URL(r.url).pathname === "/").init.headers["User-Agent"], /^Mozilla\/5\.0/);
  const requestBody = JSON.parse(requests.find((r) => r.init.method === "POST").init.body).bridge_record;
  assert.match(requestBody.external_id, /^hugo-page:[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(requestBody, "visibility"), false);
  assert.doesNotMatch(requestBody.content_html, /Preparing|discussionbridge-presentation/);
  const output = await readFile(outputPath, "utf8");
  assert.doesNotMatch(output, /ssssssss/);
  assert.doesNotMatch(output, /script|bad\(\)/);
  assert.match(output, /Forum owned/);
  assert.match(output, /Helpful reply/);
  assert.match(output, /Powered by Discourse/);
  assert.match(output, /discussionbridge-powered-by__wordmark/);
  assert.doesNotMatch(output, /First post/);
});

test("publish state survives an ambiguous failure and exact retry reuses correlation and identity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-state-"));
  const manifestPath = path.join(dir, "manifest.json");
  const outputPath = path.join(dir, "records.json");
  const statePath = path.join(dir, "publication-state.json");
  const onePage = { site_origin: "https://hugo.example.com", pages: [manifest.pages[0]] };
  await import("node:fs/promises").then(({ writeFile }) => writeFile(manifestPath, JSON.stringify(onePage)));
  const correlations = [];
  let attempt = 0;
  const fetchImpl = async (_url, init) => {
    correlations.push(JSON.parse(init.body).bridge_record.correlation_id);
    attempt++;
    if (attempt === 1) throw new Error("connection reset after request transmission");
    return new Response(JSON.stringify({ outcome: "resolved", core_fallback: false, direction: "to_discourse", resource_id: "22222222-2222-4222-8222-222222222222", topic_id: 21, topic_url: "https://bridge.example.com/t/to-bridge/21" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(() => prepare({ manifestPath, outputPath, statePath, config: { ...config }, fetchImpl }), /connection reset/);
  const failed = await readOperationalState(statePath);
  const failedOperation = Object.values(failed.operations)[0];
  assert.equal(failedOperation.outcome, "retryable_failure");
  assert.equal(failedOperation.attempts, 1);
  assert.deepEqual(summarizeOperationalState(failed), { operations: 1, pending: 0, healthy: 0, retryable: 1, reconciliationRequired: 0, rejected: 0 });
  await prepare({ manifestPath, outputPath, statePath, config: { ...config }, fetchImpl });
  const recovered = await readOperationalState(statePath);
  const operation = Object.values(recovered.operations)[0];
  assert.equal(operation.outcome, "resolved");
  assert.equal(operation.attempts, 2);
  assert.equal(operation.resourceId, "22222222-2222-4222-8222-222222222222");
  assert.equal(operation.topicId, 21);
  assert.equal(correlations[0], correlations[1]);
  assert.doesNotMatch(JSON.stringify(recovered), new RegExp(config.connectionSecret));
});

test("a failed final output commit remains non-healthy and retries the same identity", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-output-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifestPath = path.join(dir, "manifest.json");
  const outputPath = path.join(dir, "records.json");
  const statePath = path.join(dir, "publication-state.json");
  await writeFile(manifestPath, JSON.stringify({ site_origin: "https://hugo.example.com", pages: [manifest.pages[0]] }));
  const correlations = [];
  let requests = 0;
  const fetchImpl = async (_url, init) => {
    correlations.push(JSON.parse(init.body).bridge_record.correlation_id);
    requests++;
    return new Response(JSON.stringify({ outcome: requests === 1 ? "created" : "resolved", core_fallback: false, direction: "to_discourse", resource_id: "22222222-2222-4222-8222-222222222222", topic_id: 21, topic_url: "https://bridge.example.com/t/to-bridge/21" }), { status: requests === 1 ? 201 : 200, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(() => prepare({
    manifestPath, outputPath, statePath, config: { ...config }, fetchImpl,
    dependencies: { atomicWrite: async () => { throw new Error("injected final output rename failure"); } },
  }), /injected final output rename failure/);
  await assert.rejects(() => readFile(outputPath), /ENOENT/);
  const failed = await readOperationalState(statePath);
  const failedOperation = Object.values(failed.operations)[0];
  assert.equal(failedOperation.outcome, "reconciliation_required");
  assert.equal(failedOperation.retryable, true);
  assert.equal(summarizeOperationalState(failed).healthy, 0);

  await prepare({ manifestPath, outputPath, statePath, config: { ...config }, fetchImpl });
  const recovered = await readOperationalState(statePath);
  const recoveredOperation = Object.values(recovered.operations)[0];
  assert.equal(correlations[0], correlations[1]);
  assert.equal(recoveredOperation.outcome, "resolved");
  assert.equal(recoveredOperation.attempts, 2);
  assert.equal(recoveredOperation.reconciliationRequired, false);
  assert.match(await readFile(outputPath, "utf8"), /22222222-2222-4222-8222-222222222222/);
});

test("an interruption after remote success leaves pending state until output commits", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-interruption-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifestPath = path.join(dir, "manifest.json");
  const outputPath = path.join(dir, "records.json");
  const statePath = path.join(dir, "publication-state.json");
  await writeFile(manifestPath, JSON.stringify({ site_origin: "https://hugo.example.com", pages: [manifest.pages[0]] }));
  const correlations = [];
  let requests = 0;
  const fetchImpl = async (_url, init) => {
    correlations.push(JSON.parse(init.body).bridge_record.correlation_id);
    requests++;
    return new Response(JSON.stringify({ outcome: requests === 1 ? "created" : "resolved", core_fallback: false, direction: "to_discourse", resource_id: "22222222-2222-4222-8222-222222222222", topic_id: 21, topic_url: "https://bridge.example.com/t/to-bridge/21" }), { status: requests === 1 ? 201 : 200, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(() => prepare({
    manifestPath, outputPath, statePath, config: { ...config }, fetchImpl,
    dependencies: { afterResultStaged: async () => { throw new Error("simulated process interruption"); } },
  }), /simulated process interruption/);
  await assert.rejects(() => readFile(outputPath), /ENOENT/);
  const interrupted = await readOperationalState(statePath);
  const interruptedOperation = Object.values(interrupted.operations)[0];
  assert.equal(interruptedOperation.outcome, "pending");
  assert.equal(interruptedOperation.retryable, true);
  assert.equal(interruptedOperation.reconciliationRequired, true);
  assert.equal(summarizeOperationalState(interrupted).healthy, 0);

  await prepare({ manifestPath, outputPath, statePath, config: { ...config }, fetchImpl });
  const recovered = await readOperationalState(statePath);
  assert.equal(correlations[0], correlations[1]);
  assert.equal(Object.values(recovered.operations)[0].outcome, "resolved");
  assert.equal(Object.values(recovered.operations)[0].attempts, 2);
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

test("native publication creates once, retries unchanged, and skips presentation-only records", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-native-"));
  const source = {
    resource_id: "33333333-3333-4333-8333-333333333333",
    direction: "from_discourse",
    state: "healthy",
    title: "The Bridge publishes everywhere",
    topic_id: 53,
    topic_url: "https://bridge.example.com/t/publisher/53",
    source: {
      platform: "discourse",
      origin: "https://bridge.example.com",
      topic_id: 53,
      post_id: 149,
      post_number: 1,
      post_version: 1,
      revision: "post:149:version:1",
      updated_at: "2026-09-01T06:57:52.495021Z",
      author: { name: "DiscussionBridge", profile_url: "https://bridge.example.com/u/discussionbridge" },
    },
    bindings: [{ role: "presentation", state: "active", canonical_url: "https://hugo.example.com/discussionbridge/the-bridge-publishes-everywhere/", native_materialization: true }],
  };
  const presentationOnly = { ...source, resource_id: "44444444-4444-4444-8444-444444444444", bindings: [{ ...source.bindings[0], native_materialization: false }] };
  const fetchImpl = async () => new Response(JSON.stringify({ bridge_records: [presentationOnly, source], pagination: { page: 1, pages: 1, total: 2, snapshot: "snapshot-one" } }), { status: 200, headers: { "content-type": "application/json" } });
  const options = { contentDir: dir, siteUrl: "https://hugo.example.com/", config: { ...config }, fetchImpl };
  assert.deepEqual(await syncNativePublications(options), { created: 1, updated: 0, unchanged: 0, skipped: 1, failed: 0 });
  assert.deepEqual(await syncNativePublications(options), { created: 0, updated: 0, unchanged: 1, skipped: 1, failed: 0 });
  const output = await readFile(path.join(dir, "discussionbridge", "the-bridge-publishes-everywhere.md"), "utf8");
  assert.match(output, /discussionbridge_native_publication = true/);
  assert.match(output, /discussionbridge_resource_id = "33333333-3333-4333-8333-333333333333"/);
  assert.match(output, /discussionbridge_source_revision = "post:149:version:1"/);
  assert.match(output, /discussionbridge mode="from_discourse"/);
  assert.match(output, /summary = "Published from The Bridge by DiscussionBridge\."/);
  assert.match(output, /discussionbridge_source_author = "DiscussionBridge"/);
  assert.match(output, /discussionbridge_adapter_version = "0\.1\.0-alpha\.15"/);
  assert.doesNotMatch(output, /Published from \[The Bridge\]/);
  assert.doesNotMatch(output, /connectionSecret|X-DiscussionBridge-Secret/);
});

test("native publication rejects snapshot drift and duplicate feed identities", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-feed-"));
  const source = {
    resource_id: "33333333-3333-4333-8333-333333333333", direction: "from_discourse", state: "healthy", title: "Publisher", topic_id: 53, topic_url: "https://bridge.example.com/t/publisher/53",
    source: { platform: "discourse", origin: "https://bridge.example.com", topic_id: 53, post_id: 149, post_number: 1, post_version: 1, revision: "post:149:version:1", updated_at: "2026-09-01T06:57:52.495021Z", author: { name: "DiscussionBridge", profile_url: "https://bridge.example.com/u/discussionbridge" } },
    bindings: [{ role: "presentation", state: "active", canonical_url: "https://hugo.example.com/discussionbridge/publisher/", native_materialization: true }],
  };
  let page = 0;
  const drifting = async () => {
    page++;
    return new Response(JSON.stringify({ bridge_records: [source], pagination: { page, pages: 2, total: 2, snapshot: page === 1 ? "one" : "two" } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(() => syncNativePublications({ contentDir: dir, siteUrl: "https://hugo.example.com/", config: { ...config }, fetchImpl: drifting }), /changed during synchronization/);
  page = 0;
  const repeated = async () => {
    page++;
    return new Response(JSON.stringify({ bridge_records: [source], pagination: { page, pages: 2, total: 2, snapshot: "one" } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(() => syncNativePublications({ contentDir: dir, siteUrl: "https://hugo.example.com/", config: { ...config }, fetchImpl: repeated }), /duplicate resource identity/);
});

test("browser Simple loader is credential-free, bounded, sanitized, and preserves a snapshot fallback", async () => {
  const source = await readFile(new URL("../src/browser-simple.mjs", import.meta.url), "utf8");
  assert.match(source, /credentials: "omit"/);
  assert.match(source, /redirect: "error"/);
  assert.match(source, /DOMPurify\.sanitize/);
  assert.match(source, /MAX_REPLIES = 50/);
  assert.match(source, /INITIAL_REPLIES = 5/);
  assert.match(source, /discussionbridgeSimpleState = "snapshot"/);
  assert.doesNotMatch(source, /X-DiscussionBridge|Connection-Secret|connectionSecret/);
});
