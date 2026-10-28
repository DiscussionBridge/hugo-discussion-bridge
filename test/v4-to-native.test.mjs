import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { cmsConfig, connection, json, nativeOrigin } from "../test-support/cms-fixture.mjs";

const component = process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT ? path.resolve(process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT) : fileURLToPath(new URL("..", import.meta.url));
const { prepare } = await import(pathToFileURL(path.join(component, "src", "adapter.mjs")));
const { readOperationalState } = await import(pathToFileURL(path.join(component, "src", "operational-state.mjs")));
const { validateCms, semanticIdentity } = await import(pathToFileURL(path.join(component, "src", "protocol-v4", "cms-runtime.mjs")));
const { prepareNativeToSource, readSourceCapture } = await import(pathToFileURL(path.join(component, "src", "source-preparation.mjs")));
const { createHash } = await import("node:crypto");
const base = path.join(component, ".tmp", "to-v4-tests"), execute = promisify(execFile);
async function fixture(t) {
  await execute("hugo", ["version"]); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "native-"));
  t.after(async () => { assert.equal(path.dirname(root), base); await rm(root, { recursive: true, force: true }); });
  const site = path.join(root, "site"), statePath = path.join(root, "private", "source-state.json"), manifestPath = path.join(root, "discussionbridge-manifest.json"), outputPath = path.join(site, "data", "discussionbridge.json");
  for (const dir of ["content", "data", "layouts", "static"]) await mkdir(path.join(site, dir), { recursive: true });
  await writeFile(path.join(site, "hugo.toml"), `baseURL='${nativeOrigin}/'\ndisableKinds=['taxonomy','term','rss','sitemap']\n[markup.goldmark.renderer]\nunsafe=true\n[[module.mounts]]\nsource='layouts'\ntarget='layouts'\n[[module.mounts]]\nsource=${JSON.stringify(path.join(component, "layouts").replaceAll("\\", "/"))}\ntarget='layouts'\n[outputFormats.DiscussionBridge]\nmediaType='application/json'\nbaseName='discussionbridge-manifest'\nisPlainText=true\n[outputs]\nhome=['HTML','DiscussionBridge']\n[segments.discussionbridge-manifest]\n[[segments.discussionbridge-manifest.includes]]\noutput='DiscussionBridge'\n`);
  await writeFile(path.join(site, "layouts", "home.html"), "<html><body>Home</body></html>");
  await writeFile(path.join(site, "layouts", "page.html"), "<html><body>{{ .Content }}</body></html>");
  const config = { ...cmsConfig, toNative: { siteRoot: site,
    command: { executable: "hugo", args: ["--source", "{site_root}", "--destination", "{public_root}", "--renderSegments", "discussionbridge-manifest", "--cacheDir", path.join(root, "cache")], timeoutMs: 30000 },
    lifecycleCommand: { executable: "hugo", args: ["--source", "{site_root}", "--config", "hugo.toml,{capture_config}", "--destination", "{public_root}", "--renderSegments", "discussionbridge-source-lifecycle", "--buildDrafts", "--buildFuture", "--buildExpired", "--cacheDir", path.join(root, "cache")], timeoutMs: 30000 } } };
  const records = new Map(), mutations = new Map(), requests = []; let loseResolve = false, loseResolveBeforeCommit = false, loseWithdrawal = false, count = 0, afterConnection, fromEnabled = true;
  const fetchImpl = async (address, options) => {
    const route = new URL(address).pathname.replace("/discussion-bridge/v4/", ""), body = options.body ? JSON.parse(options.body) : null;
    requests.push({ route, body });
    if (body && mutations.has(body.mutation_id)) { const receipt = mutations.get(body.mutation_id); assert.equal(semanticIdentity(receipt.request), semanticIdentity(body)); return json(receipt.value, receipt.status); }
    if (route === "connection.json") { if (afterConnection) { const action = afterConnection; afterConnection = undefined; await action(); } const value = connection(); value.policy.enabled = fromEnabled; value.directions = ["to_discourse", "from_discourse"]; return json(value); }
    if (route === "bridge-records.json") return json({ items: [...records.values()], next_cursor: null });
    const detail = /^bridge-records\/([^/]+)\.json$/u.exec(route); if (detail && body === null) return json(records.get(detail[1]));
    if (route === "bridge-records/resolve.json") {
      validateCms("ToResolve", body); const input = body.bridge_record, previous = [...records.values()].find((record) => record.external_id === input.external_id);
      assert.equal(input.expected_source_revision, previous?.source_revision ?? null); assert.equal(previous?.state ?? "active", "active");
      if (loseResolveBeforeCommit) { loseResolveBeforeCommit = false; throw new Error("Isolated resolve unavailable before commit"); }
      const record = { resource_id: previous?.resource_id ?? randomUUID(), direction: "to_discourse", state: "active", topic_id: previous?.topic_id ?? String(9007199254740993n + BigInt(count++)),
        topic_url: previous?.topic_url ?? `${cmsConfig.serverUrl}/t/native/${String(9007199254740992n + BigInt(count))}`,
        external_id: input.external_id, canonical_url: input.canonical_url, source_revision: input.source_revision, source_created_at: input.source_created_at,
        source_updated_at: input.source_updated_at, synchronized_at: new Date().toISOString(), mapping_id: null };
      validateCms("Record", record); records.set(record.resource_id, record);
      const value = { outcome: previous ? "updated" : "created", reason: previous ? "source_revision_updated" : "record_created", resource_id: record.resource_id, topic_id: record.topic_id,
        topic_url: record.topic_url, direction: "to_discourse", source_revision: input.source_revision, synchronized_at: record.synchronized_at, core_fallback: false };
      validateCms("ResolveResult", value); mutations.set(body.mutation_id, { request: body, value, status: previous ? 200 : 201 });
      if (loseResolve) { loseResolve = false; throw new Error("Isolated successful resolve response lost"); }
      return json(value, previous ? 200 : 201);
    }
    const withdrawal = /^bridge-records\/([^/]+)\/withdraw\.json$/u.exec(route);
    if (withdrawal) {
      validateCms("WithdrawInput", body); const record = records.get(withdrawal[1]); assert.equal(record.source_revision, body.expected_source_revision); record.state = "withdrawn";
      const value = structuredClone(record); mutations.set(body.mutation_id, { request: body, value, status: 200 });
      if (loseWithdrawal) { loseWithdrawal = false; throw new Error("Isolated successful withdrawal response lost"); }
      return json(value);
    }
    throw new Error(`Unexpected isolated route ${route}`);
  };
  async function source(name, body, fields = "") {
    const bytes = `+++\ntitle="${name}"\ndiscussionbridge_mode="to_discourse"\nauthors=[{id="alice",name="Alice"},{id="bob",name="Bob"}]\n${fields}\n+++\n\n${body}\n`;
    await writeFile(path.join(site, "content", `${name}.md`), bytes); return bytes;
  }
  return { site, statePath, outputPath, records, requests, source, config, manifestPath,
    state: () => readOperationalState(statePath), loseResolve: () => { loseResolve = true; }, loseResolveBeforeCommit: () => { loseResolveBeforeCommit = true; }, loseWithdrawal: () => { loseWithdrawal = true; }, afterConnection: (action) => { afterConnection = action; }, fromEnabled: (value) => { fromEnabled = value; },
    run: async () => { try { return await prepare({ manifestPath, outputPath, statePath, config, fetchImpl }); }
      catch (error) { if (error.native_helper || error.native_process_probe) t.diagnostic(JSON.stringify({ message: error.message, native_helper: error.native_helper, native_process_probe: error.native_process_probe })); throw error; } } };
}

test("native V4 To preserves metadata/CAS and exact uncertain mutations, then withdraws from private lifecycle evidence", async (t) => {
  const f = await fixture(t); await f.source("ordinary", "Original native article 😀", "date=2026-09-01T10:00:00Z\nlastmod=2026-09-02T11:00:00Z");
  await f.source("wiki", "Wiki native article"); await f.run();
  let state = await f.state(), ordinary = Object.values(state.operations).find((value) => value.pageKey === "ordinary"), wiki = Object.values(state.operations).find((value) => value.pageKey === "wiki");
  const ids = [ordinary.externalId, ordinary.resourceId, ordinary.topicId], firstRevision = ordinary.acceptedSourceRevision;
  assert.equal(ordinary.lastToRequest.bridge_record.source_created_at, "2026-09-01T10:00:00.000Z");
  assert.equal(ordinary.lastToRequest.bridge_record.source_updated_at, "2026-09-02T11:00:00.000Z");
  assert.deepEqual(ordinary.lastToRequest.bridge_record.source_authors.map(({ id, name }) => [id, name]), [["alice", "Alice"], ["bob", "Bob"]]);
  assert.equal(wiki.lastToRequest.bridge_record.source_created_at, null); assert.equal(wiki.lastToRequest.bridge_record.source_updated_at, null);
  assert.equal(ordinary.topicId, "9007199254740993");
  const original = ordinary.lastToRequest; await f.run(); state = await f.state(); ordinary = state.operations[ids[0]]; assert.deepEqual(ordinary.lastToRequest, original);
  const edited = await f.source("ordinary", "Genuine edited native article 😀", "date=2026-09-01T10:00:00Z\nlastmod=2026-09-03T11:00:00Z");
  f.loseResolve(); await assert.rejects(f.run(), { code: "transport_timeout" });
  ordinary = (await f.state()).operations[ids[0]]; const pending = ordinary.pendingToMutation.request; assert.equal(pending.bridge_record.expected_source_revision, firstRevision);
  await f.run(); ordinary = (await f.state()).operations[ids[0]];
  assert.deepEqual([ordinary.externalId, ordinary.resourceId, ordinary.topicId], ids); assert.deepEqual(ordinary.lastToRequest, pending); assert.equal(ordinary.toHistory.length, 1);
  const replay = f.requests.filter(({ route, body }) => route === "bridge-records/resolve.json" && body.mutation_id === pending.mutation_id); assert.equal(replay.length, 2); assert.deepEqual(replay[0].body, replay[1].body);
  await f.source("ordinary", "Private draft text", "draft=true"); f.loseWithdrawal(); await assert.rejects(f.run(), { code: "transport_timeout" });
  ordinary = (await f.state()).operations[ids[0]]; const withdrawal = ordinary.pendingToWithdrawal.request; assert.equal(withdrawal.reason, "source_unpublished");
  await writeFile(path.join(f.site, "content", "ordinary.md"), edited); await f.run();
  ordinary = (await f.state()).operations[ids[0]]; assert.deepEqual(ordinary.toWithdrawn.request, withdrawal);
  assert.deepEqual([ordinary.externalId, ordinary.resourceId, ordinary.topicId], ids); assert.equal(ordinary.toWithdrawn.record.state, "withdrawn");
  const resolves = f.requests.filter(({ route }) => route === "bridge-records/resolve.json").length; await f.run(); assert.equal(f.requests.filter(({ route }) => route === "bridge-records/resolve.json").length, resolves + 1); // Only the still-active wiki repeats its exact receipt.
  await rm(path.join(f.site, "content", "wiki.md")); await f.run(); wiki = (await f.state()).operations[wiki.externalId]; assert.equal(wiki.toWithdrawn.request.reason, "source_deleted");
  const output = JSON.parse(await readFile(f.outputPath, "utf8")); assert.equal(output.ordinary.topic_id, ids[2]);
});

test("native generated excerpt and actual known source loss retain truthful independent evidence", async (t) => {
  const f = await fixture(t), body = "Native complete source 😀 ".repeat(6000);
  await f.source("large", body); await f.source("media", '<p>Context retained</p><video controls><source src="https://media.example/video.mp4" type="video/mp4"></video>');
  const result = await f.run(); assert.equal(result.status.local_source_limitations, 1);
  let state = await f.state(); const large = Object.values(state.operations).find((value) => value.pageKey === "large");
  assert.equal(large.lastToRequest.bridge_record.representation.kind, "generated_excerpt"); assert.ok(large.lastToRequest.bridge_record.source_content_bytes > 49152);
  assert.ok(Buffer.byteLength(JSON.stringify(large.lastToRequest)) <= 65536); assert.match(large.lastToRequest.bridge_record.content_html, /data-discussionbridge-generated="read-more"/u);
  const limitation = Object.values(state.sourceLimitations)[0], pinned = await readFile(path.join(path.dirname(f.statePath), ...limitation.source_snapshot.split("/")), "utf8");
  assert.match(pinned, /<video controls>/u); assert.equal(f.records.size, 1); assert.equal(Object.values(state.operations).some((value) => value.pageKey === "media"), false);
  assert.equal(f.requests.some(({ route }) => route.includes("source-url-moves")), false);
});

test("native opt-out withdraws its accepted binding; a changed file after capture cannot dispatch a stale source", async (t) => {
  const f = await fixture(t), bytes = await f.source("optout", "Published native original"); await f.run();
  const initial = Object.values((await f.state()).operations)[0], count = f.requests.filter(({ route }) => route === "bridge-records/resolve.json").length;
  f.fromEnabled(false); // From selection is not an extra authority gate on owned To05.
  await writeFile(path.join(f.site, "content", "optout.md"), bytes.replace('discussionbridge_mode="to_discourse"', 'discussionbridge_mode="full"'));
  await f.run(); const operation = (await f.state()).operations[initial.externalId];
  assert.equal(operation.toWithdrawn.request.reason, "source_ineligible"); assert.equal(operation.toWithdrawn.request.expected_source_revision, initial.acceptedSourceRevision);
  assert.equal(f.requests.filter(({ route }) => route === "bridge-records/resolve.json").length, count);
  const second = await fixture(t); await second.source("raced", "Captured native original");
  second.afterConnection(() => second.source("raced", "Actual native file changed after capture"));
  await assert.rejects(second.run(), { code: "native_local_edit_conflict" });
  assert.equal(second.requests.some(({ route }) => route === "bridge-records/resolve.json"), false);
});

test("native closure with unresolved To02 retains accepted predecessor and exact pending mutation without replay or invented withdrawal", async (t) => {
  for (const committed of [true, false]) {
    const f = await fixture(t); await f.source("closing", "Accepted source A"); await f.run();
    const accepted = Object.values((await f.state()).operations)[0];
    const sourceB = await f.source("closing", "Genuine source B with uncertain response");
    if (committed) f.loseResolve(); else f.loseResolveBeforeCommit();
    await assert.rejects(f.run(), { code: "transport_timeout" });
    const uncertainState = await f.state();
    const capturedB = path.join(path.dirname(f.statePath), ".to-captures", uncertainState.toCapture.value.transaction_id, "discussionbridge-manifest.json");
    const capturedBytes = await readFile(capturedB);
    let current = uncertainState.operations[accepted.externalId]; const pending = semanticIdentity(current.pendingToMutation);
    assert.equal(current.acceptedSourceRevision, accepted.acceptedSourceRevision); assert.notEqual(current.pendingToMutation.request.bridge_record.source_revision, accepted.acceptedSourceRevision);
    const count = f.requests.filter(({ route }) => route === "bridge-records/resolve.json").length;
    await f.source("closing", "Private closed source", "draft=true");
    if (committed) await assert.rejects(f.run(), { code: "revision_conflict" });
    else await f.run();
    current = (await f.state()).operations[accepted.externalId]; assert.equal(current.acceptedSourceRevision, accepted.acceptedSourceRevision);
    assert.equal(semanticIdentity(current.pendingToMutation), pending); assert.equal(current.pendingToWithdrawal, undefined);
    assert.equal(f.requests.filter(({ route }) => route === "bridge-records/resolve.json").length, count);
    assert.deepEqual(await readFile(capturedB), capturedBytes);
    if (committed) { assert.equal(current.toWithdrawn, undefined); assert.equal(f.requests.some(({ route }) => route.endsWith("/withdraw.json")), false); }
    else {
      assert.equal(current.toWithdrawn.request.expected_source_revision, accepted.acceptedSourceRevision); assert.equal(current.toWithdrawn.record.source_revision, accepted.acceptedSourceRevision);
      await writeFile(path.join(f.site, "content", "closing.md"), sourceB); await f.run();
      current = (await f.state()).operations[accepted.externalId]; assert.equal(semanticIdentity(current.pendingToMutation), pending);
      assert.equal(f.requests.filter(({ route }) => route === "bridge-records/resolve.json").length, count);
    }
  }
});

test("native preparation retains plain/image originals and captured targets before complete hash, pending replay and canonical-only intent", async (t) => {
  const f = await fixture(t), privateRoot = path.dirname(f.statePath), hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const same = (actual, expected) => assert.ok(semanticIdentity(actual) === semanticIdentity(expected), "immutable typed value retained");
  await f.source("plain", "plain unformatted native source 😀");
  await f.source("image", '![Source photograph](../media/source.png)');
  await f.source("functional", '<p>Native interactive context</p><a href="child/" onclick="nativeAction()">Act</a><script>function nativeAction(){document.querySelector("a").textContent="Done"}</script>');
  await f.source("displayed", '```html\n<script>displayedOnly()</script>\n<a onclick="displayedOnly()">Shown code</a>\n```');
  const body = '<a href="child/?a=1&amp;b=2#part">Source child</a><img src="images/source.png"><p>' + "Entire native source 😀 ".repeat(6000) + "</p>";
  await f.source("relative", body); const firstResult = await f.run(); let state = await f.state();
  const operation = (key) => Object.values(state.operations).find((entry) => entry.pageKey === key);
  const limitation = Object.values(state.sourceLimitations).find((entry) => entry.source_file === "functional.md");
  assert.ok(limitation.cause.some((entry) => entry.kind === "native_event_handler"));
  assert.ok(limitation.cause.some((entry) => entry.kind === "native_script"));
  assert.ok(firstResult.status.local_source_issues.some((entry) => entry.source_file === "functional.md" && entry.cause.some((cause) => cause.kind === "native_event_handler")));
  assert.ok(!JSON.stringify(firstResult.status).includes("function nativeAction")); // Original code stays private in its capture, not status output.
  assert.match((await readSourceCapture(privateRoot, limitation.source_capture)).toString(), /function nativeAction/u);
  assert.equal(operation("functional"), undefined); assert.equal(limitation.source_capture.source_article_url, `${nativeOrigin}/functional/`);
  assert.ok(operation("displayed").lastToRequest.bridge_record.content_html.includes("displayedOnly"));
  assert.ok(!operation("displayed").lastToRequest.bridge_record.content_html.includes("<script>"));
  for (const key of ["plain", "image", "relative"]) {
    const item = operation(key), original = await readSourceCapture(privateRoot, item.toSourceCapture);
    assert.equal(item.toSourceCapture.source_article_url, `${nativeOrigin}/${key}/`);
    const prepared = prepareNativeToSource(original.toString(), item.toSourceCapture.source_article_url); assert.equal(prepared.losses.length, 0);
    assert.equal(item.lastToRequest.bridge_record.source_content_sha256, hash(prepared.html));
    assert.equal(item.lastToRequest.bridge_record.source_content_bytes, Buffer.byteLength(prepared.html));
  }
  assert.match(operation("plain").lastToRequest.bridge_record.content_html, /plain unformatted native source 😀/u);
  assert.match(operation("image").lastToRequest.bridge_record.content_html, /src="https:\/\/hugo\.example\/media\/source\.png"/u);
  const imageA = structuredClone(operation("image"));
  await mkdir(path.join(f.site, "layouts", "_markup"), { recursive: true });
  await writeFile(path.join(f.site, "layouts", "_markup", "render-image.html"), '<img src="{{ .Destination | safeURL }}" alt="{{ .Text }}" title="Native image annotation" />');
  await f.run(); state = await f.state(); const imageB = operation("image");
  assert.equal(imageB.toNativeBinding.source_sha256, imageA.toNativeBinding.source_sha256);
  assert.notEqual(imageB.lastToRequest.bridge_record.source_content_sha256, imageA.lastToRequest.bridge_record.source_content_sha256);
  assert.notEqual(imageB.acceptedSourceRevision, imageA.acceptedSourceRevision);
  assert.equal(imageB.lastToRequest.bridge_record.expected_source_revision, imageA.acceptedSourceRevision);
  assert.equal(imageB.lastToRequest.bridge_record.source_updated_at, imageA.lastToRequest.bridge_record.source_updated_at);
  assert.deepEqual([imageB.resourceId, imageB.topicId], [imageA.resourceId, imageA.topicId]);
  const accepted = structuredClone(operation("relative")); assert.equal(accepted.lastToRequest.bridge_record.representation.kind, "generated_excerpt");
  const edited = body + "<p>Genuine native revision B</p>"; await f.source("relative", edited); f.loseResolve();
  await assert.rejects(f.run(), { code: "transport_timeout" }); state = await f.state();
  const pending = structuredClone(operation("relative").pendingToMutation), originalB = await readSourceCapture(privateRoot, pending.native_evidence.source_capture);
  same(operation("relative").lastToRequest, accepted.lastToRequest); same(operation("relative").toSourceCapture, accepted.toSourceCapture);
  await f.run(); state = await f.state(); const current = operation("relative");
  same(current.lastToRequest, pending.request); same(current.toSourceCapture, pending.native_evidence.source_capture);
  same(current.toHistory[0].request, accepted.lastToRequest); same(current.toHistory[0].source_capture, accepted.toSourceCapture);
  const saved = structuredClone(current); state = await f.state();
  same(operation("relative").lastToRequest, saved.lastToRequest); same(operation("relative").toHistory, saved.toHistory);
  same(operation("relative").toSourceCapture, saved.toSourceCapture); assert.deepEqual(await readSourceCapture(privateRoot, saved.toSourceCapture), originalB);
  assert.equal(f.requests.some(({ route }) => route.includes("source-url-moves")), false);
});
