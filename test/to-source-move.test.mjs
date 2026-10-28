import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { cmsConfig, connection, json, nativeOrigin } from "../test-support/cms-fixture.mjs";

const component = process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT ? path.resolve(process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT) : fileURLToPath(new URL("..", import.meta.url));
const { prepare, moveSourceUrl } = await import(pathToFileURL(path.join(component, "src/adapter.mjs")));
const { readOperationalState } = await import(pathToFileURL(path.join(component, "src/operational-state.mjs")));
const { patchNativeSourceUrl, keepSourceMoveBlob } = await import(pathToFileURL(path.join(component, "src/to-source-move-state.mjs")));
const { HUGO_TO_SOURCE_PROFILE, ownedToSourceArticle, hashToSourceReceipt, verifyToSourcePublic } = await import(pathToFileURL(path.join(component, "src/to-source-proof.mjs")));
const { validateCms, semanticIdentity } = await import(pathToFileURL(path.join(component, "src/protocol-v4/cms-runtime.mjs")));
const { projectSourceMoveRecord } = await import(pathToFileURL(path.join(component, "src/source-move-intent.mjs")));
const { preserveSourceCapture } = await import(pathToFileURL(path.join(component, "src/source-preparation.mjs")));
const { nativeSemanticJson } = await import(pathToFileURL(path.join(component, "src/native-state.mjs")));
const execute = promisify(execFile), hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (actual, expected) => assert.equal(semanticIdentity(actual), semanticIdentity(expected));
const escape = (value) => String(value).replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
async function temporary(t, prefix) {
  const base = path.join(component, ".tmp/source-move-tests"); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, prefix));
  t.after(async () => { assert.equal(path.dirname(root), base); await rm(root, { recursive: true, force: true }); }); return root;
}
test("private source URL patch changes only supported scalar bytes and retains body/comments", () => {
  const original = Buffer.from('+++\r\ntitle = "Actual title"\r\n  url  = \'/old/\' # retained authored comment\r\n[params]\r\nurl="unrelated"\r\n+++\r\n\r\nUnformatted article 😀 [child](child/)\r\n');
  const updated = patchNativeSourceUrl(original, `${nativeOrigin}/new/`);
  assert.equal(updated.toString(), original.toString().replace("'/old/'", '"/new/"'));
  for (const unsupported of ['---\ntitle: example\n---\nbody', '+++\ntitle="""multi\nline"""\n+++\nbody', '+++\n"url"="/old/"\n+++\nbody']) {
    assert.throws(() => patchNativeSourceUrl(Buffer.from(unsupported), `${nativeOrigin}/new/`), { code: "native_source_public_profile_unresolved" });
  }
});
function framed(receipt, complete) {
  const attributes = { profile: HUGO_TO_SOURCE_PROFILE, "resource-id": receipt.resource_id, "topic-id": receipt.topic_id, "external-id": receipt.external_id,
    "native-id": receipt.native_id, "canonical-url": receipt.canonical_url, "source-revision": receipt.source_revision, "source-file-sha256": receipt.source_file_sha256,
    "source-content-sha256": receipt.source_content_sha256, "source-authors-sha256": hash(nativeSemanticJson(receipt.source_authors)), title: receipt.title,
    "move-id": receipt.move_id, "proof-nonce": receipt.proof_nonce };
  return Buffer.from(`<html><body><!--discussionbridge-to-source-start:${receipt.resource_id}--><article ${Object.entries(attributes).map(([key, value]) => `data-discussionbridge-to-${key}="${escape(value)}"`).join(" ")}><h1>${escape(receipt.title)}</h1><!--discussionbridge-to-source-article-start-->${complete}<!--discussionbridge-to-source-article-end--></article><!--discussionbridge-to-source-end:${receipt.resource_id}--></body></html>`);
}
test("complete source proof rejects marker-only/body/nonce mismatches and streams beyond metadata size", async (t) => {
  const root = await temporary(t, "proof-"), complete = Buffer.from(`<p>${"Native entire article 😀 ".repeat(20000)}</p>`), original = Buffer.from("native authored snapshot");
  const capture = await preserveSourceCapture(root, { source_id: "native-source", source_revision: hash(original), content_bytes: complete.length, content_sha256: hash(complete) }, complete, `${nativeOrigin}/old/`);
  const transaction = randomUUID(), before = await keepSourceMoveBlob(root, transaction, "native-before.html", complete), after = await keepSourceMoveBlob(root, transaction, "native-after.html", complete), prepared = await keepSourceMoveBlob(root, transaction, "complete-prepared.html", complete);
  const receipt = { schema_version: "db-hugo-to-source-receipt-1", verification_profile: HUGO_TO_SOURCE_PROFILE,
    binding: { connection_id: cmsConfig.connectionId, forum_origin: cmsConfig.serverUrl, site_root: root, content_root: path.join(root, "content"), scope_revision: "scope-1", lane: "default" },
    resource_id: randomUUID(), topic_id: "9007199254740993", external_id: "native-source", native_id: "actual.md", canonical_url: `${nativeOrigin}/new/`, source_revision: "actual-move-edition",
    source_file_sha256: hash(original), source_content_sha256: hash(complete), source_content_bytes: complete.length, title: "Actual native title", source_authors: [],
    source_created_at: null, source_updated_at: null, capture: { birth: capture, native_before: before, native_after: after, prepared }, native_inputs_sha256: hash("actual selected inputs"), public_data_sha256: hash("actual public data"), move_id: randomUUID(), proof_nonce: randomBytes(32).toString("base64url") };
  const html = framed(receipt, complete.toString()), expected = ownedToSourceArticle(html, receipt, complete);
  assert.ok(html.length > 262144); assert.notEqual(expected.sha256, receipt.source_content_sha256);
  const publicFetch = async (url, options) => { assert.equal(url.href, receipt.canonical_url); assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
    assert.ok(!JSON.stringify(options.headers).includes(cmsConfig.connectionSecret)); let at = 0;
    return new Response(new ReadableStream({ pull(controller) { if (at === html.length) controller.close(); else { const end = Math.min(at + 32767, html.length); controller.enqueue(html.subarray(at, end)); at = end; } } }), { headers: { "content-type": "text/html" } }); };
  const verified = await verifyToSourcePublic({ receipt, completeArticle: complete, expectedHtml: html, publicFetch });
  assert.equal(verified.native_ownership_receipt_sha256, hashToSourceReceipt(receipt)); assert.equal(verified.native_publication_sha256, expected.sha256);
  for (const changed of [Buffer.from(html.toString().replace("Native entire", "WRONG entire")), Buffer.from(html.toString().replace(receipt.proof_nonce, "wrong-current-nonce")), Buffer.concat([html, html])]) {
    await assert.rejects(verifyToSourcePublic({ receipt, completeArticle: complete, expectedHtml: html, publicFetch: async () => new Response(changed, { headers: { "content-type": "text/html" } }) }), { code: "public_verification_failed" });
  }
});

async function nativeFixture(t) {
  await execute("hugo", ["version"]); const root = await temporary(t, "native-");
  const site = path.join(root, "site"), statePath = path.join(root, "private/source.json"), manifestPath = path.join(root, "discussionbridge-manifest.json"), outputPath = path.join(site, "data/discussionbridge.json");
  const publicRoot = path.join(site, "public"), deployed = path.join(root, "deployed"), counter = path.join(root, "deploy-count.json");
  for (const folder of ["content", "data", "layouts", "static"]) await mkdir(path.join(site, folder), { recursive: true });
  await writeFile(path.join(site, "hugo.toml"), `baseURL='${nativeOrigin}/'\ndisableKinds=['taxonomy','term','rss','sitemap']\n[markup.goldmark.renderer]\nunsafe=true\n[[module.mounts]]\nsource='layouts'\ntarget='layouts'\n[[module.mounts]]\nsource=${JSON.stringify(path.join(component, "layouts").replaceAll("\\", "/"))}\ntarget='layouts'\n[outputFormats.DiscussionBridge]\nmediaType='application/json'\nbaseName='discussionbridge-manifest'\nisPlainText=true\n[outputs]\nhome=['HTML','DiscussionBridge']\n[segments.discussionbridge-manifest]\n[[segments.discussionbridge-manifest.includes]]\noutput='DiscussionBridge'\n`);
  await writeFile(path.join(site, "layouts/home.html"), "<html><body>Home</body></html>");
  await writeFile(path.join(site, "layouts/page.html"), '<html><body>{{ partial "discussionbridge/source-article.html" . }}</body></html>');
  const deployScript = path.join(root, "deploy.mjs");
  await writeFile(deployScript, `import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';const [source,target,receipt,counter]=process.argv.slice(2);assert.equal(path.resolve(target),${JSON.stringify(deployed)});assert.equal(path.dirname(path.resolve(target)),${JSON.stringify(root)});await fs.rm(target,{recursive:true,force:true});await fs.cp(source,target,{recursive:true});let n=0;try{n=JSON.parse(await fs.readFile(counter,'utf8'))}catch{}await fs.writeFile(counter,JSON.stringify(n+1));await fs.mkdir(path.dirname(receipt),{recursive:true});await fs.writeFile(receipt,JSON.stringify({deployment_id:'owned-fixture-'+(n+1),deployed_at:new Date().toISOString()}));`);
  const config = { ...cmsConfig, toNative: { siteRoot: site, command: { executable: "hugo", args: ["--source", "{site_root}", "--destination", "{public_root}", "--renderSegments", "discussionbridge-manifest", "--cacheDir", path.join(root, "cache")], timeoutMs: 30000 },
    sourceMoves: { profile: HUGO_TO_SOURCE_PROFILE, dataRoot: path.join(site, "data"), publicRoot, artifactPattern: "{url_path}/index.html",
      inputs: ["hugo.toml", "layouts/page.html", "layouts/home.html"], build: { executable: "hugo", args: ["--source", "{site_root}", "--destination", "{public_root}", "--cacheDir", path.join(root, "cache")], timeoutMs: 30000 },
      deploy: { executable: process.execPath, args: [deployScript, "{public_root}", deployed, "{receipt_path}", counter], timeoutMs: 30000 } } } };
  const records = new Map(), payloads = new Map(), receipts = new Map(), moves = new Map(), history = [], requests = []; let lost, rejectFinalize = false, mismatch = false, afterPrepare, revision = "policy-1", scope = "scope-1";
  const fetchImpl = async (address, options) => {
    const route = new URL(address).pathname.replace("/discussion-bridge/v4/", ""), body = options.body ? JSON.parse(options.body) : null; requests.push({ route, body });
    if (body && receipts.has(body.mutation_id)) { const value = receipts.get(body.mutation_id); same(value.body, body); return json(value.response, value.status); }
    const accept = (response, status = 200) => { receipts.set(body.mutation_id, { body: structuredClone(body), response: structuredClone(response), status }); if (lost === route || lost === "finalize" && route.endsWith("/finalize.json") || lost === "abort" && route.endsWith("/abort.json")) { lost = null; throw new Error("Owned fixture lost committed response"); } return json(response, status); };
    if (route === "connection.json") { const value = connection(); value.directions = ["to_discourse"]; value.policy.enabled = false; value.policy.policy_revision = revision; value.scope_revision = scope; return json(value); }
    if (route === "bridge-records.json") return json({ items: [...records.values()], next_cursor: null });
    const detail = /^bridge-records\/([^/]+)\.json$/u.exec(route); if (detail && body === null) return json(records.get(detail[1]));
    if (route === "bridge-records/resolve.json") {
      validateCms("ToResolve", body); const input = body.bridge_record, previous = [...records.values()].find((record) => record.external_id === input.external_id);
      assert.equal(input.expected_source_revision, previous?.source_revision ?? null); const topicId = previous?.topic_id ?? "9007199254740993";
      const record = { resource_id: previous?.resource_id ?? randomUUID(), direction: "to_discourse", state: "active", topic_id: topicId, topic_url: `${cmsConfig.serverUrl}/t/source/${topicId}`,
        external_id: input.external_id, canonical_url: input.canonical_url, source_revision: input.source_revision, source_created_at: input.source_created_at, source_updated_at: input.source_updated_at, synchronized_at: new Date().toISOString(), mapping_id: null };
      records.set(record.resource_id, record); payloads.set(record.resource_id, structuredClone(input));
      return accept({ outcome: previous ? "updated" : "created", reason: previous ? "source_revision_updated" : "record_created", ...Object.fromEntries(["resource_id", "topic_id", "topic_url", "direction", "source_revision", "synchronized_at"].map((key) => [key, record[key]])), core_fallback: false }, previous ? 200 : 201);
    }
    const match = /^bridge-records\/([^/]+)\/(source-url-moves|url-history)(?:\/([^/]+)\/(finalize|abort))?\.json$/u.exec(route);
    if (match) {
      const record = records.get(match[1]);
      if (match[2] === "url-history") return json({ items: history, next_cursor: null });
      if (!match[3]) {
        validateCms("SourceUrlMovePrepare", body); assert.equal(body.expected_source_revision, record.source_revision); assert.equal(body.old_url, record.canonical_url);
        const move = { move_id: randomUUID(), resource_id: record.resource_id, expected_source_revision: record.source_revision, old_url: body.old_url, new_url: body.new_url,
          proof_nonce: randomBytes(32).toString("base64url"), state: "prepared", prepared_at: new Date().toISOString() }; moves.set(move.move_id, move);
        if (afterPrepare) { const action = afterPrepare; afterPrepare = null; await action(); } return accept(move);
      }
      const move = moves.get(match[3]);
      if (match[4] === "finalize") {
        validateCms("SourceUrlMoveFinalize", body); assert.equal(body.expected_source_revision, record.source_revision); assert.equal(body.proof_nonce, move.proof_nonce);
        if (rejectFinalize) return json({ outcome: "rejected", code: "content_preservation_unavailable", retryable: false, retry_after_seconds: null, correlation_id: null, core_fallback: false }, 422);
        const previous = payloads.get(record.resource_id); assert.equal(body.verification.source_content_sha256, previous.source_content_sha256);
        payloads.set(record.resource_id, projectSourceMoveRecord(previous, move.new_url, body.new_source_revision, body.source_updated_at));
        record.canonical_url = move.new_url; record.source_revision = body.new_source_revision; record.source_updated_at = body.source_updated_at; move.state = "committed";
        history.push({ url: move.old_url, retired_at: new Date().toISOString(), move_id: move.move_id }); return accept(record);
      }
      validateCms("SourceUrlMoveAbort", body); move.state = body.native_change_applied ? "attention" : "aborted";
      if (body.native_change_applied) record.state = "attention";
      return accept(move);
    }
    const withdraw = /^bridge-records\/([^/]+)\/withdraw\.json$/u.exec(route); if (withdraw) { const record = records.get(withdraw[1]); assert.equal(body.expected_source_revision, record.source_revision); record.state = "withdrawn"; return accept(record); }
    throw new Error(`Unexpected owned fixture route ${route}`);
  };
  const server = createServer(async (request, response) => {
    try { const file = path.join(deployed, request.url.replace(/^\//u, ""), "index.html"); let html = await readFile(file);
      if (mismatch && request.url === "/moved/") html = Buffer.from(html.toString().replace("Native article", "WRONG article")); response.setHeader("content-type", "text/html"); response.end(html); }
    catch { response.statusCode = 404; response.end(); }
  }); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise((resolve) => server.close(resolve)));
  const forum = createServer(async (request, response) => {
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 65536) throw new Error("Fixture request bound"); chunks.push(chunk); }
      const result = await fetchImpl(new URL(request.url, cmsConfig.serverUrl), { method: request.method, body: request.method === "GET" ? undefined : Buffer.concat(chunks).toString("utf8") });
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
    } catch { response.destroy(); }
  }); await new Promise((resolve) => forum.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise((resolve) => forum.close(resolve)));
  const publicFetch = async (url, options) => {
    assert.equal(new URL(url).origin, nativeOrigin); assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error"); assert.ok(!JSON.stringify(options.headers).includes(cmsConfig.connectionSecret));
    const response = await fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, options);
    // Explicit loopback transport seam for the configured fake HTTPS origin;
    // this does not qualify production TLS/DNS/public deployment.
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
  async function source(body, fields = "") { const bytes = `+++\ntitle="Native source"\ndiscussionbridge_mode="to_discourse"\nauthors=[{id="alice",name="Alice"},{id="bob",name="Bob"}]\n${fields}\n+++\n\n${body}\n`; await writeFile(path.join(site, "content/article.md"), bytes); return bytes; }
  const invoke = async (action) => { try { return await action(); } catch (error) { if (error.native_helper || error.native_process_probe) t.diagnostic(JSON.stringify(error)); throw error; } };
  return { root, site, config, records, payloads, requests, history, source, state: () => readOperationalState(statePath),
    run: () => invoke(() => prepare({ manifestPath, outputPath, statePath, config, fetchImpl })),
    move: (newUrl = `${nativeOrigin}/moved/`, abortMove = false) => invoke(() => moveSourceUrl({ manifestPath, statePath, config, pageKey: "article", newUrl, fetchImpl, publicFetch, abortMove })),
    restart: async () => {
      const childInput = path.join(root, "private/move-child.json");
      await writeFile(childInput, JSON.stringify({ component, request: { manifestPath, statePath, config, pageKey: "article", newUrl: `${nativeOrigin}/moved/` },
        forum: `http://127.0.0.1:${forum.address().port}`, public: `http://127.0.0.1:${server.address().port}` }));
      const result = await execute(process.execPath, ["--import", new URL("./register-runtime.mjs", import.meta.url).href,
        fileURLToPath(new URL("../test-support/source-move-child.mjs", import.meta.url)), childInput], { windowsHide: true }); return JSON.parse(result.stdout);
    },
    count: async () => JSON.parse(await readFile(counter, "utf8")), lose: (route) => { lost = route; }, mismatch: () => { mismatch = true; }, rejectFinalize: () => { rejectFinalize = true; },
    afterPrepare: (action) => { afterPrepare = action; }, advanceFromPolicy: () => { revision = "policy-2"; scope = "scope-2"; } };
}

test("native source move preserves complete article/IDs/old targets, recovers lost28 and keeps real29 ancestry through unchanged02/new CAS/05", async (t) => {
  const f = await nativeFixture(t); const original = await f.source('Native article 😀 [child](child/) ![Image](images/source.png)'); await f.run();
  const accepted = Object.values((await f.state()).operations)[0], born = structuredClone(accepted.lastToRequest), capture = structuredClone(accepted.toSourceCapture);
  f.advanceFromPolicy(); const preparePath = `bridge-records/${accepted.resourceId}/source-url-moves.json`; f.lose(preparePath);
  await assert.rejects(f.move(), { code: "transport_timeout" }); assert.equal(await readFile(path.join(f.site, "content/article.md"), "utf8"), original);
  const pending28 = structuredClone(Object.values((await f.state()).operations)[0].sourceMoves.pending.prepare.request);
  const moved = await f.move(); let current = Object.values((await f.state()).operations)[0];
  assert.equal(moved.record.resource_id, accepted.resourceId); assert.equal(moved.record.topic_id, accepted.topicId); assert.equal(await f.count(), 1);
  same(current.lastToRequest, born); same(current.toSourceCapture, capture); assert.equal(current.currentSourceMove.move_id, moved.move_id);
  const entry = current.sourceMoves.history[0]; assert.equal(entry.receipt.source_content_sha256, born.bridge_record.source_content_sha256);
  assert.equal(entry.verification.verification_profile, HUGO_TO_SOURCE_PROFILE); assert.notEqual(entry.verification.native_publication_sha256, entry.verification.source_content_sha256);
  const repeats28 = f.requests.filter(({ body }) => body?.mutation_id === pending28.mutation_id); assert.equal(repeats28.length, 2); same(repeats28[0].body, repeats28[1].body);
  assert.equal(await readFile(path.join(f.site, "content/article.md"), "utf8"), patchNativeSourceUrl(Buffer.from(original), `${nativeOrigin}/moved/`).toString());
  const deployed = await readFile(path.join(f.root, "deployed/moved/index.html"), "utf8"); assert.ok(deployed.includes(`${nativeOrigin}/article/child/`)); assert.ok(deployed.includes(`${nativeOrigin}/article/images/source.png`));
  const before02 = f.requests.filter(({ route }) => route === "bridge-records/resolve.json").length; await f.run(); current = Object.values((await f.state()).operations)[0];
  assert.equal(f.requests.filter(({ route }) => route === "bridge-records/resolve.json").length, before02); assert.equal(current.acceptedSourceRevision, moved.record.source_revision); same(current.lastToRequest, born);
  await f.source('Native article genuine later edit [child](child/)', 'url="/moved/"'); await f.run(); current = Object.values((await f.state()).operations)[0];
  assert.equal(current.lastToRequest.bridge_record.expected_source_revision, moved.record.source_revision); assert.equal(current.currentSourceMove, undefined); assert.equal(current.sourceMoves.history.length, 1);
  await rm(path.join(f.site, "content/article.md")); await f.run(); current = Object.values((await f.state()).operations)[0];
  assert.equal(current.toWithdrawn.request.expected_source_revision, current.acceptedSourceRevision); assert.equal(current.topicId, accepted.topicId);
});

test("native generated source move replays accepted lost29 without another deploy and alters only owned Read More", async (t) => {
  const f = await nativeFixture(t); await f.source("Native article 😀 ".repeat(18000)); await f.run(); const original = Object.values((await f.state()).operations)[0];
  assert.equal(original.lastToRequest.bridge_record.representation.kind, "generated_excerpt");
  f.lose("finalize"); await assert.rejects(f.move(), { code: "transport_timeout" });
  const pending = structuredClone(Object.values((await f.state()).operations)[0].sourceMoves.pending.finalize.request);
  assert.equal(await f.count(), 1);
  const result = await f.restart(); const state = Object.values((await f.state()).operations)[0], entry = state.sourceMoves.history[0];
  const projected = entry.projected_record, before = original.lastToRequest.bridge_record;
  assert.equal(projected.source_content_sha256, before.source_content_sha256); assert.equal(projected.source_content_bytes, before.source_content_bytes);
  assert.equal(projected.representation.article_content_sha256, before.representation.article_content_sha256);
  assert.equal(projected.content_html, projectSourceMoveRecord(before, result.record.canonical_url, result.record.source_revision, result.record.source_updated_at).content_html);
  assert.equal(await f.count(), 1);
  const replay = f.requests.filter(({ body }) => body?.mutation_id === pending.mutation_id); assert.equal(replay.length, 2); same(replay[0].body, replay[1].body);
  assert.ok(f.requests.some(({ route }) => route.endsWith("/url-history.json")));
});

test("native public body mismatch restores actual old source and aborts applied=true, retaining reservations", async (t) => {
  const f = await nativeFixture(t), original = await f.source("Native article unchanged original"); await f.run(); f.mismatch(); f.lose("abort");
  await assert.rejects(f.move(), { code: "transport_timeout" }); const uncertain = Object.values((await f.state()).operations)[0].sourceMoves.pending;
  assert.equal(uncertain.phase, "abort_intent"); const exact = structuredClone(uncertain.abort.request); await f.restart();
  const current = Object.values((await f.state()).operations)[0], pending = current.sourceMoves.pending;
  assert.equal(pending.phase, "attention"); assert.equal(pending.abort.request.native_change_applied, true); assert.equal(pending.abort.response.state, "attention");
  assert.equal(f.records.get(current.resourceId).state, "attention");
  assert.equal(pending.restoration.phase, "verified_old"); assert.equal(pending.restoration.verification.url, `${nativeOrigin}/article/`);
  assert.equal(await readFile(path.join(f.site, "content/article.md"), "utf8"), original); assert.equal(current.acceptedSourceRevision, current.lastToRequest.bridge_record.source_revision);
  assert.equal(f.requests.some(({ route }) => route.endsWith("/finalize.json")), false); assert.equal(await f.count(), 2);
  const replay = f.requests.filter(({ body }) => body?.mutation_id === exact.mutation_id); assert.equal(replay.length, 2); same(replay[0].body, replay[1].body);
});

test("native definitive29 preservation rejection retains exact intent and restores without normal-build replay", async (t) => {
  const f = await nativeFixture(t), original = await f.source("Native article with receiver preservation limitation"); await f.run(); f.rejectFinalize();
  await assert.rejects(f.move(), { code: "content_preservation_unavailable" }); const before = Object.values((await f.state()).operations)[0], held = structuredClone(before.sourceMoves.pending);
  assert.equal(held.phase, "attention"); assert.equal(held.rejection.route_id, "V4-29"); assert.equal(held.rejection.http_status, 422);
  assert.equal(held.abort.request.native_change_applied, true); assert.equal(await readFile(path.join(f.site, "content/article.md"), "utf8"), original);
  const count = f.requests.filter(({ route }) => route.endsWith("/finalize.json")).length; await f.run();
  same(Object.values((await f.state()).operations)[0].sourceMoves.pending, held); assert.equal(f.requests.filter(({ route }) => route.endsWith("/finalize.json")).length, count);
  assert.equal(f.requests.some(({ route }) => route.startsWith("work/")), false);
});

test("native source edit race after28 never overwrites foreign authored bytes or invents unapplied ownership", async (t) => {
  const f = await nativeFixture(t); await f.source("Native article before out-of-band edit"); await f.run(); let edited;
  f.afterPrepare(async () => { edited = await f.source("Native article genuinely edited by another writer"); });
  await assert.rejects(f.move(), { code: "native_local_edit_conflict" }); assert.equal(await readFile(path.join(f.site, "content/article.md"), "utf8"), edited);
  assert.equal(f.requests.some(({ route }) => route.endsWith("/finalize.json") || route.endsWith("/abort.json")), false);
});
