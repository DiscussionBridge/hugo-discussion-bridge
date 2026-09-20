import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { migrateNativePublication, prepare, preflight, syncNativePublications } from "../src/adapter.mjs";
import { readOperationalState, summarizeOperationalState } from "../src/operational-state.mjs";
import { PRODUCT_VERSION } from "../src/version.mjs";

const config = { serverUrl: "https://bridge.example.com", connectionId: "dbc_0123456789abcdef01234567", connectionSecret: "s".repeat(48), lane: "hugo-demo" };
const manifest = { site_origin: "https://hugo.example.com", pages: [
  { key: "to-bridge", mode: "to_discourse", canonical_url: "https://hugo.example.com/to/", external_id: `hugo-page:${"a".repeat(64)}`, title: "To Bridge", content_html: "<h2>Article</h2>\n<p>Useful content.</p>\n<section class=\"discussionbridge-presentation\"><p>Preparing</p></section>" },
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

test("CLI recovers one exact legacy URL-derived identity without inventing one", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-recover-id-"));
  const statePath = path.join(dir, "state.json");
  const externalId = `hugo-page:${"c".repeat(64)}`;
  await writeFile(statePath, JSON.stringify({
    schemaVersion: 1,
    adapterId: "hugo-discussion-bridge",
    operations: {
      [externalId]: {
        externalId,
        canonicalUrl: "https://hugo.example.com/existing/",
        correlationId: "11111111-1111-4111-8111-111111111111",
        attempts: 1,
        outcome: "resolved",
        retryable: false,
        reconciliationRequired: false,
        resourceId: "22222222-2222-4222-8222-222222222222",
        topicId: 21,
        topicUrl: "https://bridge.example.com/t/existing/21",
        lastAttemptAt: "2026-09-18T00:00:00.000Z",
        lastSuccessAt: "2026-09-18T00:00:00.000Z",
      },
    },
  }));
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const run = (url) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "recover-existing-id", "--state", statePath, "--canonical-url", url]);
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.deepEqual(await run("https://hugo.example.com/existing/"), { code: 0, stdout: `${externalId}\n`, stderr: "" });
  const missing = await run("https://hugo.example.com/unknown/");
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /does not contain one exact existing identity/);
  await rm(dir, { recursive: true, force: true });
});

test("whole-corpus preflight is deterministic and rejects collisions", () => {
  assert.deepEqual(preflight(manifest, { ...config }).map((p) => p.key), ["from-bridge", "simple", "to-bridge"]);
  const moved = structuredClone(manifest); moved.pages[0].canonical_url = "https://hugo.example.com/moved/";
  assert.equal(preflight(moved, { ...config }).find((page) => page.key === "to-bridge").external_id, manifest.pages[0].external_id);
  const missingId = structuredClone(manifest); delete missingId.pages[0].external_id;
  assert.throws(() => preflight(missingId, { ...config }), /requires a persisted Hugo external ID/);
  const duplicateId = structuredClone(manifest);
  duplicateId.pages.push({ ...duplicateId.pages[0], key: "other-page", canonical_url: "https://hugo.example.com/other/" });
  assert.throws(() => preflight(duplicateId, { ...config }), /Duplicate Hugo external ID/);
  const collision = structuredClone(manifest); collision.pages[1].canonical_url = collision.pages[0].canonical_url;
  assert.throws(() => preflight(collision, { ...config }), /Duplicate canonical URL/);
  assert.throws(() => preflight(manifest, { ...config, connectionSecret: "s".repeat(31) }), /connection secret/);
  assert.throws(() => preflight(manifest, { ...config, connectionSecret: "é".repeat(129) }), /connection secret/);
  assert.throws(() => preflight(manifest, { ...config, connectionSecret: `${"s".repeat(32)}\n` }), /connection secret/);
  assert.throws(() => preflight(manifest, { ...config, lane: "Bad Lane" }), /lane/);
});

test("manifest mode uses Interactive publicly while accepting the historical token", () => {
  const modes = preflight({ site_origin: "https://hugo.example.com", pages: [
    { key: "interactive", mode: "interactive", canonical_url: "https://hugo.example.com/interactive/", title: "Interactive" },
    { key: "legacy", mode: "fullInteractive", canonical_url: "https://hugo.example.com/legacy/", title: "Legacy" },
  ] }, { ...config });
  assert.deepEqual(modes.map((page) => page.mode), ["interactive", "interactive"]);
  assert.throws(() => preflight({ site_origin: "https://hugo.example.com", pages: [
    { key: "unknown", mode: "bridge", canonical_url: "https://hugo.example.com/unknown/", title: "Unknown" },
  ] }, { ...config }), /unsupported mode/);
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

test("a source URL move requires exact receiver attestation and preserves the existing topic", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-source-move-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifestPath = path.join(dir, "manifest.json");
  const outputPath = path.join(dir, "records.json");
  const statePath = path.join(dir, "publication-state.json");
  const first = { site_origin: "https://hugo.example.com", pages: [manifest.pages[0]] };
  const moved = structuredClone(first);
  moved.pages[0].canonical_url = "https://hugo.example.com/moved/";
  await writeFile(manifestPath, JSON.stringify(first));
  const resourceId = "22222222-2222-4222-8222-222222222222";
  let remoteBinding = null;
  let postCount = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === "GET") return new Response(JSON.stringify({ bridge_record: {
      resource_id: resourceId, direction: "to_discourse", state: "healthy", topic_id: 21,
      topic_url: "https://bridge.example.com/t/to-bridge/21", bindings: [remoteBinding],
    } }), { status: 200, headers: { "content-type": "application/json" } });
    postCount++;
    return new Response(JSON.stringify({ outcome: postCount === 1 ? "created" : "resolved", core_fallback: false, direction: "to_discourse", resource_id: resourceId, topic_id: 21, topic_url: "https://bridge.example.com/t/to-bridge/21" }), { status: postCount === 1 ? 201 : 200, headers: { "content-type": "application/json" } });
  };
  await prepare({ manifestPath, outputPath, statePath, config: { ...config }, fetchImpl });
  await writeFile(manifestPath, JSON.stringify(moved));
  await assert.rejects(() => prepare({ manifestPath, outputPath, statePath, config: { ...config }, fetchImpl }), /lacks an exact verified receiver transition/);
  assert.equal(postCount, 1);
  const blocked = (await readOperationalState(statePath)).operations[manifest.pages[0].external_id];
  assert.equal(blocked.canonicalUrl, first.pages[0].canonical_url);
  assert.equal(blocked.outcome, "reconciliation_required");

  remoteBinding = { role: "source", state: "active", external_id: manifest.pages[0].external_id,
    canonical_url: moved.pages[0].canonical_url, url_migration: { old_url: first.pages[0].canonical_url,
      new_url: moved.pages[0].canonical_url, redirect_status: 301 } };
  await prepare({ manifestPath, outputPath, statePath, config: { ...config }, fetchImpl });
  assert.equal(postCount, 2);
  const operation = (await readOperationalState(statePath)).operations[manifest.pages[0].external_id];
  assert.equal(operation.canonicalUrl, moved.pages[0].canonical_url);
  assert.equal(operation.resourceId, resourceId);
  assert.equal(operation.topicId, 21);
  await prepare({ manifestPath, outputPath, statePath, config: { ...config }, fetchImpl });
  assert.equal(postCount, 3);
});

test("a source URL move rejects drifted topic identity after attestation", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-topic-drift-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifestPath = path.join(dir, "manifest.json");
  const outputPath = path.join(dir, "records.json");
  const statePath = path.join(dir, "publication-state.json");
  const first = { site_origin: "https://hugo.example.com", pages: [manifest.pages[0]] };
  const moved = structuredClone(first);
  moved.pages[0].canonical_url = "https://hugo.example.com/moved/";
  await writeFile(manifestPath, JSON.stringify(first));
  const resourceId = "22222222-2222-4222-8222-222222222222";
  let posts = 0;
  const fetchImpl = async (_url, init) => {
    if (init.method === "GET") return new Response(JSON.stringify({ bridge_record: {
      resource_id: resourceId, direction: "to_discourse", state: "healthy", topic_id: 21,
      topic_url: "https://bridge.example.com/t/to-bridge/21", bindings: [{ role: "source", state: "active",
        external_id: manifest.pages[0].external_id, canonical_url: moved.pages[0].canonical_url,
        url_migration: { old_url: first.pages[0].canonical_url, new_url: moved.pages[0].canonical_url, redirect_status: 308 } }],
    } }), { status: 200, headers: { "content-type": "application/json" } });
    posts++;
    return new Response(JSON.stringify({ outcome: posts === 1 ? "created" : "resolved", core_fallback: false, direction: "to_discourse",
      resource_id: resourceId, topic_id: posts === 1 ? 21 : 99,
      topic_url: `https://bridge.example.com/t/to-bridge/${posts === 1 ? 21 : 99}` }),
    { status: posts === 1 ? 201 : 200, headers: { "content-type": "application/json" } });
  };
  await prepare({ manifestPath, outputPath, statePath, config: { ...config }, fetchImpl });
  await writeFile(manifestPath, JSON.stringify(moved));
  await assert.rejects(() => prepare({ manifestPath, outputPath, statePath, config: { ...config }, fetchImpl }), /identity changed/);
  const operation = (await readOperationalState(statePath)).operations[manifest.pages[0].external_id];
  assert.equal(operation.outcome, "reconciliation_required");
  assert.equal(operation.topicId, 21);
});

test("an offline Hugo adapter verifies a contiguous two-move receiver history", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-two-moves-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifestPath = path.join(dir, "manifest.json");
  const outputPath = path.join(dir, "records.json");
  const statePath = path.join(dir, "publication-state.json");
  const first = { site_origin: "https://hugo.example.com", pages: [manifest.pages[0]] };
  const secondUrl = "https://hugo.example.com/second/";
  const thirdUrl = "https://hugo.example.com/third/";
  await writeFile(manifestPath, JSON.stringify(first));
  const resourceId = "22222222-2222-4222-8222-222222222222";
  let posts = 0;
  let proofVerified = false;
  const fetchImpl = async (url, init) => {
    if (init.method === "GET") {
      if (String(url).includes("source-url-proof.json")) return new Response(JSON.stringify({ source_url_proof: {
        resource_id: resourceId, topic_id: 21, external_id: manifest.pages[0].external_id,
        from_url: first.pages[0].canonical_url, to_url: thirdUrl,
        verified: proofVerified, transition_count: 2,
      } }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ bridge_record: {
        resource_id: resourceId, direction: "to_discourse", state: "healthy", topic_id: 21,
        topic_url: "https://bridge.example.com/t/to-bridge/21", bindings: [{ role: "source", state: "active",
          external_id: manifest.pages[0].external_id, canonical_url: thirdUrl,
          url_migration: { old_url: secondUrl, new_url: thirdUrl, redirect_status: 301 } }],
      } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    posts++;
    return new Response(JSON.stringify({ outcome: posts === 1 ? "created" : "resolved", core_fallback: false,
      direction: "to_discourse", resource_id: resourceId, topic_id: 21,
      topic_url: "https://bridge.example.com/t/to-bridge/21" }),
    { status: posts === 1 ? 201 : 200, headers: { "content-type": "application/json" } });
  };
  await prepare({ manifestPath, outputPath, statePath, config: { ...config }, fetchImpl });
  const moved = structuredClone(first);
  moved.pages[0].canonical_url = thirdUrl;
  await writeFile(manifestPath, JSON.stringify(moved));
  await assert.rejects(() => prepare({ manifestPath, outputPath, statePath, config: { ...config }, fetchImpl }), /complete receiver history/);
  assert.equal(posts, 1);
  proofVerified = true;
  await prepare({ manifestPath, outputPath, statePath, config: { ...config }, fetchImpl });
  assert.equal(posts, 2);
  assert.equal((await readOperationalState(statePath)).operations[manifest.pages[0].external_id].canonicalUrl, thirdUrl);
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

test("overlapping prepares fail closed on the shared state file", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-concurrent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifestPath = path.join(dir, "manifest.json");
  const outputPath = path.join(dir, "records.json");
  const statePath = path.join(dir, "publication-state.json");
  await writeFile(manifestPath, JSON.stringify({ site_origin: "https://hugo.example.com", pages: [manifest.pages[0]] }));
  let releaseFirst;
  const release = new Promise((resolve) => { releaseFirst = resolve; });
  let staged;
  const stagedReached = new Promise((resolve) => { staged = resolve; });
  let requests = 0;
  const fetchImpl = async () => {
    requests++;
    return new Response(JSON.stringify({ outcome: "created", core_fallback: false, direction: "to_discourse", resource_id: "22222222-2222-4222-8222-222222222222", topic_id: 21, topic_url: "https://bridge.example.com/t/to-bridge/21" }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const first = prepare({
    manifestPath, outputPath, statePath, config: { ...config }, fetchImpl,
    dependencies: { afterResultStaged: async () => { staged(); await release; } },
  });
  await stagedReached;
  await assert.rejects(
    () => prepare({ manifestPath, outputPath, statePath, config: { ...config }, fetchImpl }),
    /publication state is already in use/,
  );
  releaseFirst();
  await first;
  assert.equal(requests, 1);
  assert.equal(Object.values((await readOperationalState(statePath)).operations)[0].outcome, "created");
  await assert.rejects(() => readFile(`${statePath}.lock`), /ENOENT/);
});

test("a hard-killed owner is reclaimed once and retries the staged identity", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-hard-kill-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifestPath = path.join(dir, "manifest.json");
  const outputPath = path.join(dir, "records.json");
  const statePath = path.join(dir, "publication-state.json");
  await writeFile(manifestPath, JSON.stringify({ site_origin: "https://hugo.example.com", pages: [manifest.pages[0]] }));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../test-support/hard-kill-prepare-child.mjs", import.meta.url)), manifestPath, outputPath, statePath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const childIdentity = await firstJsonLine(child);
  const exited = once(child, "exit");
  assert.equal(child.kill("SIGKILL"), true);
  await exited;
  assert.equal(Object.values((await readOperationalState(statePath)).operations)[0].outcome, "pending");
  await new Promise((resolve) => setTimeout(resolve, 3_500));

  const correlations = [];
  let requests = 0;
  const fetchImpl = async (_url, init) => {
    requests++;
    correlations.push(JSON.parse(init.body).bridge_record.correlation_id);
    return new Response(JSON.stringify({ outcome: "resolved", core_fallback: false, direction: "to_discourse", resource_id: "22222222-2222-4222-8222-222222222222", topic_id: 21, topic_url: "https://bridge.example.com/t/to-bridge/21" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  let releaseWinner;
  const release = new Promise((resolve) => { releaseWinner = resolve; });
  let winnerEntered;
  const entered = new Promise((resolve) => { winnerEntered = resolve; });
  const winner = prepare({
    manifestPath, outputPath, statePath, config: { ...config }, fetchImpl,
    dependencies: {
      lockOptions: { staleMs: 2_000, updateMs: 1_000 },
      afterResultStaged: async () => { winnerEntered(); await release; },
    },
  });
  await entered;
  await assert.rejects(
    () => prepare({ manifestPath, outputPath, statePath, config: { ...config }, fetchImpl }),
    /publication state is already in use/,
  );
  releaseWinner();
  await winner;
  const recovered = Object.values((await readOperationalState(statePath)).operations)[0];
  assert.equal(requests, 1);
  assert.equal(correlations[0], childIdentity.correlationId);
  assert.equal(recovered.externalId, childIdentity.externalId);
  assert.equal(recovered.outcome, "resolved");
  assert.equal(recovered.attempts, 2);
  assert.match(await readFile(outputPath, "utf8"), /22222222-2222-4222-8222-222222222222/);
});

async function firstJsonLine(child) {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        try { resolve(JSON.parse(buffer.slice(0, newline))); }
        catch (error) { reject(error); }
      }
    });
    child.once("exit", (code) => reject(new Error(`Lock child exited ${code}: ${stderr}`)));
    child.once("error", reject);
  });
}

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
  await writeFile(path.join(dir, "ordinary.md"), '+++\ntitle = "Ordinary page"\n+++\n\ndiscussionbridge_native_publication = true\ndiscussionbridge_resource_id = "33333333-3333-4333-8333-333333333333"\n');
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
    bindings: [{ role: "presentation", state: "active", canonical_url: "https://hugo.example.com/the-bridge-publishes-everywhere/", native_materialization: true }],
  };
  const presentationOnly = { ...source, resource_id: "44444444-4444-4444-8444-444444444444", bindings: [{ ...source.bindings[0], native_materialization: false }] };
  const fetchImpl = async () => new Response(JSON.stringify({ bridge_records: [presentationOnly, source], pagination: { page: 1, pages: 1, total: 2, snapshot: "snapshot-one" } }), { status: 200, headers: { "content-type": "application/json" } });
  const options = { contentDir: dir, siteUrl: "https://hugo.example.com/", config: { ...config }, fetchImpl };
  assert.deepEqual(await syncNativePublications(options), { created: 1, updated: 0, unchanged: 0, skipped: 1, failed: 0 });
  assert.deepEqual(await syncNativePublications(options), { created: 0, updated: 0, unchanged: 1, skipped: 1, failed: 0 });
  const output = await readFile(path.join(dir, "the-bridge-publishes-everywhere.md"), "utf8");
  assert.match(output, /discussionbridge_native_publication = true/);
  assert.match(output, /discussionbridge_resource_id = "33333333-3333-4333-8333-333333333333"/);
  assert.match(output, /discussionbridge_source_revision = "post:149:version:1"/);
  assert.match(output, /discussionbridge mode="from_discourse"/);
  assert.match(output, /summary = "Published from The Bridge by DiscussionBridge\."/);
  assert.match(output, /discussionbridge_source_author = "DiscussionBridge"/);
  assert.match(output, /discussionbridge_adapter_version = "0\.2\.0-alpha\.24"/);
  assert.doesNotMatch(output, /Published from \[The Bridge\]/);
  assert.doesNotMatch(output, /connectionSecret|X-DiscussionBridge-Secret/);

  const moved = { ...source, bindings: [{ ...source.bindings[0], canonical_url: "https://hugo.example.com/new-location/" }] };
  const movedFeed = async () => new Response(JSON.stringify({ bridge_records: [moved], pagination: { page: 1, pages: 1, total: 1, snapshot: "snapshot-moved" } }), { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(() => syncNativePublications({ ...options, fetchImpl: movedFeed }), /explicit migration and redirect/);
  await assert.rejects(() => readFile(path.join(dir, "new-location.md")), /ENOENT/);
  assert.equal(await readFile(path.join(dir, "the-bridge-publishes-everywhere.md"), "utf8"), output);

  await writeFile(path.join(dir, "duplicate.md"), output);
  await assert.rejects(() => syncNativePublications(options), /resource identity is duplicated across files/);
});

test("explicit Hugo migration preserves resource identity and writes one Cloudflare redirect", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-migrate-"));
  const oldFile = path.join(dir, "old-route.md");
  const newFile = path.join(dir, "new-route.md");
  const redirectsFile = path.join(dir, "_redirects");
  const source = '+++\ntitle = "Forum source"\ndiscussionbridge_native_publication = true\ndiscussionbridge_resource_id = "33333333-3333-4333-8333-333333333333"\n+++\n\n{{< discussionbridge mode="from_discourse" >}}\n';
  await writeFile(oldFile, source);
  const migration = { contentDir: dir, siteUrl: "https://hugo.example.com/", resourceId: "33333333-3333-4333-8333-333333333333", oldUrl: "https://hugo.example.com/old-route/", newUrl: "https://hugo.example.com/new-route/", redirectsFile };
  assert.equal((await migrateNativePublication(migration)).redirectRule, "/old-route/ /new-route/ 301");
  await assert.rejects(() => readFile(oldFile), /ENOENT/);
  assert.equal(await readFile(newFile, "utf8"), source);
  assert.equal(await readFile(redirectsFile, "utf8"), "/old-route/ /new-route/ 301\n");
  assert.equal((await migrateNativePublication(migration)).outcome, "already_current");
  const reverse = await migrateNativePublication({ ...migration, oldUrl: migration.newUrl, newUrl: migration.oldUrl });
  assert.equal(reverse.redirectRule, "/new-route/ /old-route/ 301");
  assert.equal(await readFile(oldFile, "utf8"), source);
  await assert.rejects(() => readFile(newFile), /ENOENT/);
  assert.equal(await readFile(redirectsFile, "utf8"), "/new-route/ /old-route/ 301\n");
});

test("Hugo publication migration recovers after hard termination at every durable boundary in both directions", async (t) => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  t.after(() => { if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv; });
  const phases = ["prepared", "redirected", "moved"];
  for (const direction of ["forward", "reverse"]) {
    for (const phase of phases) {
      const dir = await mkdtemp(path.join(os.tmpdir(), `discussionbridge-hugo-migrate-hard-kill-${direction}-${phase}-`));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const oldFile = path.join(dir, "old-route.md");
      const redirectsFile = path.join(dir, "_redirects");
      const source = '+++\ntitle = "Forum source"\ndiscussionbridge_native_publication = true\ndiscussionbridge_resource_id = "33333333-3333-4333-8333-333333333333"\n+++\n';
      await writeFile(oldFile, source);
      const forward = { contentDir: dir, siteUrl: "https://hugo.example.com/", resourceId: "33333333-3333-4333-8333-333333333333", oldUrl: "https://hugo.example.com/old-route/", newUrl: "https://hugo.example.com/new-route/", redirectsFile };
      if (direction === "reverse") await migrateNativePublication(forward);
      const migration = direction === "forward" ? forward : { ...forward, oldUrl: forward.newUrl, newUrl: forward.oldUrl };
      const inputFile = path.join(dir, "migration.json");
      await writeFile(inputFile, JSON.stringify(migration));
      const child = spawn(process.execPath, [fileURLToPath(new URL("../test-support/hard-kill-migration-child.mjs", import.meta.url)), inputFile], {
        env: { ...process.env, NODE_ENV: "test", DISCUSSIONBRIDGE_TEST_MIGRATION_PAUSE: phase },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const checkpoint = await firstJsonLine(child);
      assert.equal(checkpoint.phase, phase);
      const exited = once(child, "exit");
      assert.equal(child.kill("SIGKILL"), true);
      await exited;
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      assert.equal((await migrateNativePublication(migration)).outcome, "migrated");
      assert.equal((await migrateNativePublication(migration)).outcome, "already_current");
      const expectedFile = direction === "forward" ? path.join(dir, "new-route.md") : path.join(dir, "old-route.md");
      assert.match(await readFile(expectedFile, "utf8"), /discussionbridge_resource_id = "33333333-3333-4333-8333-333333333333"/);
      const expectedRule = direction === "forward" ? "/old-route/ /new-route/ 301\n" : "/new-route/ /old-route/ 301\n";
      assert.equal(await readFile(redirectsFile, "utf8"), expectedRule);
      await assert.rejects(() => readFile(path.join(dir, ".discussionbridge-publication-url-migration.json")), /ENOENT/);
    }
  }
});

test("Hugo migration rejects redirect and native destination collisions before a move", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-migrate-conflict-"));
  const oldFile = path.join(dir, "old-route.md");
  const redirectsFile = path.join(dir, "_redirects");
  const source = '+++\ndiscussionbridge_native_publication = true\ndiscussionbridge_resource_id = "33333333-3333-4333-8333-333333333333"\n+++\n';
  await writeFile(oldFile, source);
  const migration = { contentDir: dir, siteUrl: "https://hugo.example.com/", resourceId: "33333333-3333-4333-8333-333333333333", oldUrl: "https://hugo.example.com/old-route/", newUrl: "https://hugo.example.com/new-route/", redirectsFile };
  await writeFile(path.join(dir, "new-route.md"), "ordinary content");
  await assert.rejects(() => migrateNativePublication(migration), /destination already has content/);
  await rm(path.join(dir, "new-route.md"));
  await writeFile(redirectsFile, "/old-route/ /elsewhere/ 301\n");
  await assert.rejects(() => migrateNativePublication(migration), /redirect source conflicts/);
  await writeFile(redirectsFile, "/new-route/ /elsewhere/ 301\n");
  await assert.rejects(() => migrateNativePublication(migration), /destination has a conflicting redirect/);
  await writeFile(redirectsFile, "/old-route/ /elsewhere/ 301\n");
  assert.equal(await readFile(oldFile, "utf8"), source);
  assert.equal(await readFile(redirectsFile, "utf8"), "/old-route/ /elsewhere/ 301\n");
});

test("native publication honors an authorized source path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-native-"));
  const source = {
    resource_id: "55555555-5555-4555-8555-555555555555", direction: "from_discourse", state: "healthy", title: "Nested publisher", topic_id: 54, topic_url: "https://bridge.example.com/t/nested-publisher/54",
    source: { platform: "discourse", origin: "https://bridge.example.com", topic_id: 54, post_id: 150, post_number: 1, post_version: 1, revision: "post:150:version:1", updated_at: "2026-09-01T07:00:00.000Z", author: { name: "DiscussionBridge", profile_url: "https://bridge.example.com/u/discussionbridge" } },
    bindings: [{ role: "presentation", state: "active", canonical_url: "https://hugo.example.com/from-the-bridge/nested-publisher/", native_materialization: true }],
  };
  const fetchImpl = async () => new Response(JSON.stringify({ bridge_records: [source], pagination: { page: 1, pages: 1, total: 1, snapshot: "snapshot-nested" } }), { status: 200, headers: { "content-type": "application/json" } });

  assert.deepEqual(await syncNativePublications({ contentDir: dir, siteUrl: "https://hugo.example.com/", config: { ...config }, fetchImpl }), { created: 1, updated: 0, unchanged: 0, skipped: 0, failed: 0 });
  assert.match(await readFile(path.join(dir, "from-the-bridge", "nested-publisher.md"), "utf8"), /discussionbridge_native_publication = true/);
});

test("native publication rejects snapshot drift and duplicate feed identities", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-feed-"));
  const source = {
    resource_id: "33333333-3333-4333-8333-333333333333", direction: "from_discourse", state: "healthy", title: "Publisher", topic_id: 53, topic_url: "https://bridge.example.com/t/publisher/53",
    source: { platform: "discourse", origin: "https://bridge.example.com", topic_id: 53, post_id: 149, post_number: 1, post_version: 1, revision: "post:149:version:1", updated_at: "2026-09-01T06:57:52.495021Z", author: { name: "DiscussionBridge", profile_url: "https://bridge.example.com/u/discussionbridge" } },
    bindings: [{ role: "presentation", state: "active", canonical_url: "https://hugo.example.com/publisher/", native_materialization: true }],
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
