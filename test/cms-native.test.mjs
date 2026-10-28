import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { runHugoNativeCms } from "../src/cms-native.mjs";
import { cmsOpaque, cmsUrl } from "../src/cms-ownership.mjs";
import { cmsConfig, connection, json, leaseToken, mappingId, nativeOrigin, work } from "../test-support/cms-fixture.mjs";

const execute = promisify(execFile), component = fileURLToPath(new URL("..", import.meta.url));
const base = path.join(component, ".tmp", "cms-native-tests"), hash = (v) => createHash("sha256").update(v).digest("hex");
async function fixture(t) {
  await execute("hugo", ["version"]); // This suite requires the existing native executable.
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "native-"));
  t.after(async () => { assert.equal(path.dirname(root), base); await rm(root, { recursive: true, force: true }); });
  const siteRoot = path.join(root, "site"), privateRoot = path.join(root, "private"), deployed = path.join(root, "deployed");
  for (const dir of ["content", "data", "layouts", "static"]) await mkdir(path.join(siteRoot, dir), { recursive: true });
  const tomlPath = (v) => JSON.stringify(v.split(path.sep).join("/"));
  await writeFile(path.join(siteRoot, "hugo.toml"), `baseURL = '${nativeOrigin}/'\ndisableKinds = ['taxonomy','term','rss','sitemap']\n[params]\ndiscussionbridge_forum_origin = '${cmsConfig.serverUrl}'\n[[module.mounts]]\nsource = 'layouts'\ntarget = 'layouts'\n[[module.mounts]]\nsource = ${tomlPath(path.join(component, "layouts"))}\ntarget = 'layouts'\n[mediaTypes.'application/vnd.discussionbridge+json']\nsuffixes = ['json']\n[outputFormats.discussionbridge]\nmediaType = 'application/vnd.discussionbridge+json'\nbaseName = 'discussionbridge-manifest'\nisPlainText = true\n[outputs]\nhome = ['html','discussionbridge']\n`);
  await writeFile(path.join(siteRoot, "layouts", "page.html"), "<!doctype html><html><body>{{ .Content }}</body></html>");
  await writeFile(path.join(siteRoot, "layouts", "home.html"), "<!doctype html><html><body>Native home</body></html>");
  await writeFile(path.join(siteRoot, "content", "ordinary.md"), '+++\ntitle = "Existing To page"\ndiscussionbridge_mode = "to_discourse"\n+++\n\nOriginal native article.\n');
  // Existing controlled To data coexists with the per-source CMS cache.
  await writeFile(path.join(siteRoot, "data", "discussionbridge.json"), JSON.stringify({ existing: { topic_id: 42, forum_origin: cmsConfig.serverUrl } }));
  const deployScript = path.join(root, "deploy.mjs");
  await writeFile(deployScript, `import {cp,rm,writeFile} from 'node:fs/promises'; import path from 'node:path'; const [publicRoot,deployed,receipt]=process.argv.slice(2); const boundRoot=${JSON.stringify(root)}; if(path.dirname(path.resolve(deployed))!==boundRoot) throw new Error("Fixture deployed path escapes root"); await rm(deployed,{recursive:true,force:true}); await cp(publicRoot,deployed,{recursive:true}); await writeFile(receipt,JSON.stringify({deployment_id:'fixture-'+process.argv[5],deployed_at:new Date().toISOString()}));`);
  const native = { siteRoot, privateRoot, siteUrl: nativeOrigin, nativeShortcode: "discussionbridge",
    build: { executable: "hugo", args: ["--source", "{site_root}", "--destination", "{public_root}", "--cleanDestinationDir", "--cacheDir", path.join(root, "cache")], timeoutMs: 30000 },
    deploy: { executable: process.execPath, args: [deployScript, "{public_root}", deployed, "{receipt_path}", "{transaction_id}"], timeoutMs: 30000 } };
  let revision = 1, action = "publish_revision", offered = true, deliveredFeed = 0, currentWork = work(), expiry;
  let source, bytes, mapping = null; const mutations = new Map(), finalizations = [], aborts = [], requests = [];
  let loseFinalize = false, wrongPublic = false, badContent = false, selectedAuthor = false, splitInitial = false, advanceOnClaim = false, presentation = "interactive";
  const update = (n, nextAction = "publish_revision") => {
    revision = n; action = nextAction; offered = true;
    bytes = Buffer.from(`<h2>Revision ${n}</h2><p>${"Complete 😀 source ".repeat(n === 1 ? 20000 : 20)}</p>`);
    source = { source_id: "source-a", source_revision: `revision-${n}`, topic_id: "53", topic_url: `${cmsConfig.serverUrl}/t/source/53`, title: `Source revision ${n}`,
      content_sha256: hash(bytes), content_bytes: bytes.length, source_created_at: "2026-10-10T00:00:00.000Z", source_updated_at: `2026-10-${10+n}T00:00:00.000Z`,
      source_authors: [{ id: "alice", name: "Alice" }, { id: "bob", name: "Bob" }] };
    currentWork = { ...work(), work_id: randomUUID(), lease_generation: n, source_revision: nextAction === "withdraw" ? null : source.source_revision, action: nextAction };
    expiry = new Date(Date.now() + 300000).toISOString();
    if (mapping) mapping.desired_source_revision = currentWork.source_revision;
  };
  update(1);
  const status = () => ({ work: currentWork, mapping, lease_expires_at: expiry });
  const cmsFetch = async (address, options) => {
    const url = new URL(address); assert.equal(url.origin, cmsConfig.serverUrl);
    assert.equal(options.headers["X-DiscussionBridge-Connection"], cmsConfig.connectionId);
    const route = url.pathname.replace("/discussion-bridge/v4/", ""), body = options.body ? JSON.parse(options.body) : null;
    requests.push({ route, body });
    if (body && mutations.has(body.mutation_id)) return json(mutations.get(body.mutation_id));
    if (route === "connection.json") { const value = connection(); value.policy.presentation_mode = presentation; if (selectedAuthor) value.policy.author_ids = ["native-alice"]; return json(value); }
    if (route === "sources.json") {
      const items = deliveredFeed === revision ? [] : [action === "publish_revision" ? { event_type: "publication", event_id: randomUUID(), event_sequence: String(revision), source }
        : { event_type: "revocation", event_id: randomUUID(), event_sequence: String(revision), source_id: source.source_id, last_source_revision: `revision-${revision-1}`, reason: "policy_excluded" }];
      deliveredFeed = revision;
      const continued = splitInitial && url.searchParams.get("stream") === "initial" && !url.searchParams.has("cursor");
      return json({ stream: url.searchParams.get("stream"), items, next_cursor: continued ? "initial_2" : null, checkpoint_cursor: continued ? null : `checkpoint_${revision}` });
    }
    if (route === "mappings/prepare.json") {
      mapping = { mapping_id: mappingId, resource_id: "22222222-2222-4222-8222-222222222222", connection_id: cmsConfig.connectionId, source_id: source.source_id,
        external_id: body.external_id, canonical_url: body.canonical_url, mapping_revision: "mapping-1", destination_native_id: null, retired_url_count: 0,
        mapping_state: "pending", presentation_mode: presentation, desired_source_revision: source.source_revision, synchronized_source_revision: null,
        publicly_verified_source_revision: null, destination_native_revision: null, source_created_at: null, source_updated_at: null, synchronized_at: null, publicly_verified_at: null };
      mutations.set(body.mutation_id, structuredClone(mapping)); return json(mapping);
    }
    if (route === "work/claim.json") { if (!offered) return new Response(null, { status: 204 }); if (advanceOnClaim) { advanceOnClaim = false; update(2); } offered = false; return json({ work: currentWork, lease_token: leaseToken, lease_generation: revision, expires_at: expiry, server_time: new Date().toISOString() }); }
    if (route.endsWith("/content.json")) {
      const offset = Number(url.searchParams.get("offset")), end = Math.min(bytes.length, offset + 32767); // Deliberately split UTF8 code points.
      return json({ source_id: source.source_id, source_revision: source.source_revision, content_sha256: source.content_sha256, content_bytes: bytes.length, offset,
        next_offset: end === bytes.length ? null : end, content_base64: (badContent ? Buffer.alloc(end-offset, 65) : bytes.subarray(offset, end)).toString("base64") });
    }
    if (route === `work/${currentWork.work_id}.json`) return json(status());
    if (route.endsWith("/renew.json")) { expiry = new Date(Date.now()+300000).toISOString(); return json({ work: currentWork, lease_token: leaseToken, lease_generation: revision, expires_at: expiry, server_time: new Date().toISOString() }); }
    if (route.endsWith("/prepare.json")) {
      currentWork.state = "synchronized"; mapping.destination_native_id = body.native_result.native_id; mapping.synchronized_source_revision = currentWork.source_revision;
      mapping.destination_native_revision = currentWork.source_revision; mapping.synchronized_at = body.prepared_at;
    } else if (route.endsWith("/finalize.json")) {
      finalizations.push(body); currentWork.state = "verified"; mapping.mapping_state = action === "withdraw" ? "withdrawn" : "active";
      mapping.publicly_verified_source_revision = currentWork.source_revision; mapping.publicly_verified_at = body.verification.checked_at;
    } else if (route.endsWith("/abort.json")) { aborts.push(body); currentWork.state = "attention"; }
    else if (route.endsWith("/fail.json")) { currentWork.state = "attention"; currentWork.last_failure_code = body.code; }
    else throw new Error(`Unexpected fixture route ${route}`);
    const response = structuredClone(status()); mutations.set(body.mutation_id, response);
    if (loseFinalize && route.endsWith("/finalize.json")) { loseFinalize = false; throw new Error("Fixture loses successful finalize response"); }
    return json(response);
  };
  const publicFetch = async (address, options) => {
    const url = new URL(address); assert.equal(options.redirect, "error");
    assert.equal(Object.keys(options.headers).some((key) => /connection|secret|authorization/iu.test(key)), false);
    if (url.origin === cmsConfig.serverUrl) {
      if (url.pathname === "/") return new Response('<script id="data-preloaded">{"siteSettings":"{\\"enable_powered_by_discourse\\":false}"}</script>', { headers: { "content-type": "text/html" } });
      assert.equal(url.pathname, "/t/53.json"); return json({ slug: "source", post_stream: { stream: [530, 531], posts: [{ id: 530, cooked: bytes.toString("utf8") },
        { id: 531, topic_id: 53, post_number: 2, username: "reader", created_at: "2026-10-11T00:00:00.000Z", cooked: "<p>Native Simple reply</p>" }] } });
    }
    assert.equal(url.origin, nativeOrigin); assert.equal(options.credentials, "omit");
    if (wrongPublic) return new Response("wrong deployed page", { headers: { "content-type": "text/html" } });
    try { return new Response(await readFile(path.join(deployed, url.pathname, "index.html")), { headers: { "content-type": "text/html" } }); }
    catch (error) { if (error.code === "ENOENT") return new Response(null, { status: 404 }); throw error; }
  };
  return { run: () => runHugoNativeCms({ native, connectionConfig: cmsConfig, cmsFetch, publicFetch }), native, update, finalizations, aborts, requests,
    mapping: () => mapping, source: () => source, lose: () => { loseFinalize = true; }, wrong: () => { wrongPublic = true; }, corrupt: () => { badContent = true; }, mode: (value) => { presentation = value; },
    split: () => { splitInitial = true; native.maximumPages = 1; }, race: () => { advanceOnClaim = true; }, selected: () => { selectedAuthor = true; }, root };
}

test("configured native CMS path builds, deploys and anonymously verifies complete source, ordinary/wiki revisions and withdrawal", async (t) => {
  const f = await fixture(t); assert.equal((await f.run()).verified, 1);
  const identity = f.mapping().destination_native_id, canonical = f.mapping().canonical_url;
  const first = await readFile(path.join(f.native.siteRoot, identity), "utf8"); assert.match(first, /Alice, Bob/u);
  assert.ok(f.source().content_bytes > 262144); assert.notEqual(f.finalizations[0].verification.native_publication_sha256, f.source().content_sha256);
  const manifest = JSON.parse(await readFile(path.join(f.native.siteRoot, "public", "discussionbridge-manifest.json"), "utf8")); assert.deepEqual(manifest.pages.map(({ key }) => key), ["ordinary"]);
  f.update(2); assert.equal((await f.run()).verified, 1); assert.equal(f.mapping().destination_native_id, identity); assert.equal(f.mapping().canonical_url, canonical);
  assert.match(await readFile(path.join(f.native.siteRoot, identity), "utf8"), /revision-2/u);
  // Wiki edits use the same immutable revision fields and native transaction path.
  f.update(3); assert.equal((await f.run()).verified, 1); assert.equal(f.mapping().destination_native_id, identity); assert.equal(f.mapping().canonical_url, canonical);
  f.update(4, "withdraw"); assert.equal((await f.run()).verified, 1); assert.equal(f.finalizations[3].verification.http_status, 404);
  await assert.rejects(readFile(path.join(f.native.siteRoot, identity)), { code: "ENOENT" });
});

test("lost successful finalize resumes its exact mutation without another native build or deploy", async (t) => {
  const f = await fixture(t); f.lose(); await assert.rejects(f.run(), /transport_timeout/u);
  assert.equal((await f.run()).verified, 1); assert.equal(f.finalizations.length, 1);
  const posts = f.requests.filter(({ route }) => route.endsWith("/finalize.json")); assert.equal(posts.length, 2); assert.deepEqual(posts[0].body, posts[1].body);
});

test("mismatching anonymous publication restores actual staged native files and aborts rather than finalizing", async (t) => {
  const f = await fixture(t); f.wrong(); assert.equal((await f.run()).attention, 1); assert.equal(f.finalizations.length, 0);
  assert.equal(f.aborts.length, 1); assert.equal(f.aborts[0].native_restored, true);
  await assert.rejects(readFile(path.join(f.native.siteRoot, f.mapping().destination_native_id)), { code: "ENOENT" });
});

test("native ownership uses preserved central identity and URL grammar", () => {
  assert.equal(cmsOpaque("source\u200didentity"), true); assert.equal(cmsOpaque("\ud800"), false); assert.equal(cmsOpaque("source\u0085identity"), false);
  assert.equal(cmsUrl("https://hugo.example/a\u200db/"), true); assert.equal(cmsUrl("https://hugo.example/a b/"), false);
});

test("configured Simple and Full native publication retain their selected rendering and public proof", async (t) => {
  for (const mode of ["simple", "full"]) {
    const f = await fixture(t); f.mode(mode); assert.equal((await f.run()).verified, 1);
    const html = await readFile(path.join(f.native.siteRoot, "public", new URL(f.mapping().canonical_url).pathname, "index.html"), "utf8");
    if (mode === "simple") { assert.match(html, /data-discussionbridge-simple-live/u); assert.match(html, /Native Simple reply/u); }
    else { assert.match(html, /id="discourse-comments"/u); assert.doesNotMatch(html, /fullApp: true/u); }
    assert.match(html, new RegExp(`data-discussionbridge-cms-presentation="${mode}"`, "u"));
  }
});

test("invalid complete source fails the current claimed work without native mutation or preparation", async (t) => {
  const f = await fixture(t); f.corrupt(); assert.equal((await f.run()).attention, 1);
  const failure = f.requests.find(({ route }) => route.endsWith("/fail.json")); assert.equal(failure.body.native_change_applied, false);
  assert.equal(failure.body.code, "content_hash_mismatch");
  assert.equal(f.requests.some(({ route }) => route.startsWith("work/") && route.endsWith("/prepare.json")), false);
  assert.equal(f.finalizations.length, 0); assert.equal(f.aborts.length, 0);
  await assert.rejects(readdir(path.join(f.native.siteRoot, "content", "discussionbridge")), { code: "ENOENT" });
});

test("bounded initial continuation completes before a new claim; a post-horizon revision uses current changes", async (t) => {
  const first = await fixture(t); first.split(); assert.equal((await first.run()).claimed, 0);
  assert.equal(first.requests.some(({ route }) => route === "work/claim.json"), false);
  assert.equal((await first.run()).verified, 1);
  const second = await fixture(t); second.race(); assert.equal((await second.run()).verified, 1);
  assert.equal(second.finalizations[0].verification.source_revision, "revision-2");
  assert.ok(second.requests.filter(({ route }) => route === "sources.json").length >= 2);
});

test("unavailable native selected author binding stops locally before claiming or reporting a receiver failure", async (t) => {
  const f = await fixture(t); f.selected(); await assert.rejects(f.run(), { code: "catalog_entry_unavailable" });
  assert.equal(f.requests.some(({ route }) => route === "work/claim.json" || route.endsWith("/fail.json")), false);
});
