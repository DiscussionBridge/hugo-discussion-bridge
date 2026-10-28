import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { cmsConfig, connection, json, leaseToken, nativeOrigin, work } from "../test-support/cms-fixture.mjs";

const component = process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT ? path.resolve(process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT) : fileURLToPath(new URL("..", import.meta.url));
const { runHugoNativeCms } = await import(pathToFileURL(path.join(component, "src/cms-native.mjs")));
const { validateCms } = await import(pathToFileURL(path.join(component, "src/protocol-v4/cms-runtime.mjs")));
const { readSourceCapture } = await import(pathToFileURL(path.join(component, "src/source-preparation.mjs")));
const base = path.join(component, ".tmp", "cms-loss-tests"), execute = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const player = '<p>Source explanation</p><video controls><source src="https://media.example/movie.mp4" type="video/mp4"></video>';
async function fixture(t) {
  await execute("hugo", ["version"]);
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "native-"));
  t.after(async () => { assert.equal(path.dirname(root), base); await rm(root, { recursive: true, force: true }); });
  const siteRoot = path.join(root, "site"), privateRoot = path.join(root, "private"), deployed = path.join(root, "deployed");
  for (const dir of ["content", "data", "layouts", "static"]) await mkdir(path.join(siteRoot, dir), { recursive: true });
  await writeFile(path.join(siteRoot, "hugo.toml"), `baseURL = '${nativeOrigin}/'\ndisableKinds = ['taxonomy','term','rss','sitemap']\n[[module.mounts]]\nsource = 'layouts'\ntarget = 'layouts'\n[[module.mounts]]\nsource = ${JSON.stringify(path.join(component, "layouts").replaceAll("\\", "/"))}\ntarget = 'layouts'\n`);
  await writeFile(path.join(siteRoot, "layouts", "page.html"), "<!doctype html><html><body>{{ .Content }}</body></html>");
  await writeFile(path.join(siteRoot, "layouts", "home.html"), "<html><body>Home</body></html>");
  const deploy = path.join(root, "deploy.mjs");
  await writeFile(deploy, `import {cp,rm,writeFile} from 'node:fs/promises'; import path from 'node:path'; const [src,dest,receipt,id]=process.argv.slice(2); if(path.dirname(path.resolve(dest))!==${JSON.stringify(root)}) throw Error('Fixture path escapes root'); await rm(dest,{recursive:true,force:true}); await cp(src,dest,{recursive:true}); await writeFile(receipt,JSON.stringify({deployment_id:id,deployed_at:new Date().toISOString()}));`);
  const native = { siteRoot, privateRoot, siteUrl: nativeOrigin, nativeShortcode: "discussionbridge", maximumClaims: 1,
    build: { executable: "hugo", args: ["--source", "{site_root}", "--destination", "{public_root}", "--cleanDestinationDir", "--cacheDir", path.join(root, "cache")], timeoutMs: 30000 },
    deploy: { executable: process.execPath, args: [deploy, "{public_root}", deployed, "{receipt_path}", "{transaction_id}"], timeoutMs: 30000 } };
  const sources = new Map(), revisions = new Map(), mappings = new Map(), works = new Map(), currentWorks = new Map();
  const events = [], mutations = new Map(), requests = [], claims = new Map(); let renderer;
  function update(id, html, action = "publish_revision", replaceWork = true) {
    const number = (sources.get(id)?.number ?? 0) + 1, bytes = Buffer.from(html);
    const source = { source_id: id, source_revision: `${id}-revision-${number}`, topic_id: id === "source-a" ? "53" : "54", topic_url: `${cmsConfig.serverUrl}/t/${id}/${id === "source-a" ? "53" : "54"}`,
      title: `${id} ${number}`, content_sha256: hash(bytes), content_bytes: bytes.length, source_created_at: null, source_updated_at: null, source_authors: [{ id: "alice", name: "Alice" }, { id: "bob", name: "Bob" }] };
    validateCms("Source", source); sources.set(id, { source, bytes, number }); revisions.set(`${id}\0${source.source_revision}`, { source, bytes });
    const entry = action === "withdraw" ? { event_type: "revocation", event_id: randomUUID(), event_sequence: String(events.length + 1), source_id: id, last_source_revision: currentWorks.get(id)?.source_revision ?? source.source_revision, reason: "policy_excluded" }
      : { event_type: "publication", event_id: randomUUID(), event_sequence: String(events.length + 1), source };
    events.push(entry);
    if (replaceWork && mappings.has(id)) offer(id, action);
    return source;
  }
  function offer(id, action = "publish_revision") {
    const old = currentWorks.get(id); if (old && !["verified", "attention"].includes(old.state)) old.state = "superseded";
    const mapping = mappings.get(id), source = sources.get(id).source;
    const value = { ...work(), work_id: randomUUID(), mapping_id: mapping.mapping_id, source_id: id, source_revision: action === "withdraw" ? null : source.source_revision,
      state: "pending", action, attempt: 0, lease_generation: old?.lease_generation ?? 0, attempt_cycle: randomUUID() };
    works.set(value.work_id, value); currentWorks.set(id, value); mapping.desired_source_revision = value.source_revision;
  }
  const expiry = new Map(), status = (value) => ({ work: value, mapping: mappings.get(value.source_id), lease_expires_at: expiry.get(value.work_id) ?? null });
  const cmsFetch = async (address, options) => {
    const url = new URL(address), route = url.pathname.replace("/discussion-bridge/v4/", ""), body = options.body ? JSON.parse(options.body) : null;
    assert.equal(url.origin, cmsConfig.serverUrl); requests.push({ route, body });
    if (body && mutations.has(body.mutation_id)) return json(mutations.get(body.mutation_id));
    if (route === "connection.json") return json(connection());
    if (route === "policy.json") return json(connection().policy);
    if (route === "sources.json") {
      const stream = url.searchParams.get("stream"), from = stream === "initial" ? 0 : Number(url.searchParams.get("cursor").replace("checkpoint_", ""));
      const items = stream === "initial" ? [...sources.values()].map(({ source }) => events.findLast((entry) => entry.event_type === "publication" && entry.source.source_revision === source.source_revision)).filter(Boolean).sort((a, b) => a.source.source_id.localeCompare(b.source.source_id)) : events.slice(from);
      return json({ stream, items, next_cursor: null, checkpoint_cursor: `checkpoint_${events.length}` });
    }
    if (route === "mappings/prepare.json") {
      const mapping = { mapping_id: randomUUID(), resource_id: randomUUID(), connection_id: cmsConfig.connectionId, source_id: body.source_id, external_id: body.external_id,
        canonical_url: body.canonical_url, mapping_revision: "mapping-1", destination_native_id: null, retired_url_count: 0, mapping_state: "pending", presentation_mode: "interactive",
        desired_source_revision: body.source_revision, synchronized_source_revision: null, publicly_verified_source_revision: null, destination_native_revision: null,
        source_created_at: null, source_updated_at: null, synchronized_at: null, publicly_verified_at: null };
      mappings.set(body.source_id, mapping); offer(body.source_id); mutations.set(body.mutation_id, structuredClone(mapping)); return json(mapping);
    }
    if (route === "mappings.json") return json({ items: [...mappings.values()], next_cursor: null });
    const detail = /^mappings\/([^/]+)\.json$/u.exec(route);
    if (detail) return json([...mappings.values()].find((value) => value.mapping_id === detail[1]));
    if (route === "work/claim.json") {
      const value = [...currentWorks.values()].find((value) => value.state === "pending" && (body.mapping_id === undefined || value.mapping_id === body.mapping_id));
      if (!value) return new Response(null, { status: 204 });
      value.state = "leased"; value.attempt++; value.lease_generation++; expiry.set(value.work_id, new Date(Date.now() + 300000).toISOString()); claims.set(value.work_id, (claims.get(value.work_id) ?? 0) + 1);
      const receipt = { work: value, lease_token: leaseToken, lease_generation: value.lease_generation, expires_at: expiry.get(value.work_id), server_time: new Date().toISOString() };
      mutations.set(body.mutation_id, structuredClone(receipt)); return json(receipt);
    }
    const content = /^sources\/([^/]+)\/revisions\/([^/]+)\/content\.json$/u.exec(route);
    if (content) {
      const value = revisions.get(`${decodeURIComponent(content[1])}\0${decodeURIComponent(content[2])}`), offset = Number(url.searchParams.get("offset")), end = Math.min(value.bytes.length, offset + 32767);
      return json({ source_id: value.source.source_id, source_revision: value.source.source_revision, content_sha256: value.source.content_sha256, content_bytes: value.bytes.length, offset,
        next_offset: end === value.bytes.length ? null : end, content_base64: value.bytes.subarray(offset, end).toString("base64") });
    }
    const workPath = /^work\/([^/]+)(?:\/(renew|prepare|finalize|abort|fail))?\.json$/u.exec(route);
    assert.ok(workPath, `Unexpected fixture route ${route}`); const value = works.get(workPath[1]); assert.ok(value);
    if (!workPath[2]) return json(status(value));
    if (workPath[2] === "renew") { expiry.set(value.work_id, new Date(Date.now() + 300000).toISOString()); return json({ work: value, lease_token: leaseToken, lease_generation: value.lease_generation, expires_at: expiry.get(value.work_id), server_time: new Date().toISOString() }); }
    const mapping = mappings.get(value.source_id);
    if (workPath[2] === "prepare") { value.state = "synchronized"; mapping.destination_native_id = body.native_result.native_id; mapping.destination_native_revision = value.source_revision; mapping.synchronized_source_revision = value.source_revision; mapping.synchronized_at = body.prepared_at; }
    else if (workPath[2] === "finalize") { value.state = "verified"; mapping.mapping_state = value.action === "withdraw" ? "withdrawn" : "active"; mapping.publicly_verified_source_revision = value.source_revision; mapping.publicly_verified_at = body.verification.checked_at; }
    else { value.state = "attention"; }
    const receipt = structuredClone(status(value)); mutations.set(body.mutation_id, receipt); return json(receipt);
  };
  const publicFetch = async (address, options) => {
    const url = new URL(address); assert.equal(url.origin, nativeOrigin); assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
    try { return new Response(await readFile(path.join(deployed, url.pathname, "index.html")), { headers: { "content-type": "text/html" } }); }
    catch (error) { if (error.code === "ENOENT") return new Response(null, { status: 404 }); throw error; }
  };
  return { root, native, sources, mappings, currentWorks, requests, claims, update, renderer: (value) => { renderer = value; },
    run: async () => {
      try { return await runHugoNativeCms({ native, connectionConfig: cmsConfig, cmsFetch, publicFetch, ...(renderer ? { sourceRenderer: renderer } : {}) }); }
      catch (error) { t.diagnostic(JSON.stringify({ message: error.message, native_helper: error.native_helper, native_process_probe: error.native_process_probe })); throw error; }
    } };
}

test("known source loss retains exact evidence without repeated claims; unrelated mapping and new source/withdrawal continue", async (t) => {
  const f = await fixture(t); const first = f.update("source-a", player);
  let result = await f.run(); assert.equal(result.local_limitations, 1); assert.equal(result.attention, 0);
  const heldWork = f.currentWorks.get("source-a"), count = f.requests.length;
  result = await f.run(); assert.equal(result.local_limitations, 1); assert.equal(result.claimed, 0); assert.equal(f.claims.get(heldWork.work_id), 1);
  assert.equal(f.requests.slice(count).some(({ route }) => /\/(renew|fail|prepare|finalize)\.json$/u.test(route)), false);
  const stored = JSON.parse(await readFile(path.join(f.native.privateRoot, "continuation.json"), "utf8"));
  assert.equal(stored.held_leases[0].lease.value.work.work_id, heldWork.work_id);
  const issue = JSON.parse(await readFile(path.join(f.native.privateRoot, ...stored.held_leases[0].issue_name.split("/")), "utf8"));
  assert.equal(issue.source.content_sha256, first.content_sha256); assert.equal(issue.prior_verified, null);
  const pinned = await readFile(path.join(f.native.privateRoot, ...issue.source_snapshot.split("/")));
  assert.equal(hash(pinned), first.content_sha256); assert.equal(pinned.toString(), player);
  f.update("source-b", "<p>Unrelated full source</p>"); result = await f.run(); assert.equal(result.verified, 1);
  assert.ok(f.requests.some(({ route, body }) => route === "work/claim.json" && body.mapping_id === f.mappings.get("source-b").mapping_id));
  f.update("source-a", "<p>Genuinely new source edition</p>"); assert.equal((await f.run()).verified, 1);
  const nativeId = f.mappings.get("source-a").destination_native_id;
  f.update("source-a", player); assert.equal((await f.run()).local_limitations, 1);
  const newestHeld = f.currentWorks.get("source-a");
  f.update("source-a", "<p>Revoked source</p>", "withdraw"); assert.equal((await f.run()).verified, 1);
  await assert.rejects(readFile(path.join(f.native.siteRoot, nativeId)), { code: "ENOENT" });
  assert.equal(newestHeld.state, "superseded"); assert.equal(f.claims.get(newestHeld.work_id), 1);
  assert.equal(f.requests.some(({ route }) => route.endsWith("/fail.json")), false);
});

test("faithful preparation resumes the retained live lease; an ambiguous within-mapping event stays explicit", async (t) => {
  const f = await fixture(t); f.update("source-a", player); assert.equal((await f.run()).local_limitations, 1);
  const original = f.currentWorks.get("source-a");
  // This isolated renderer seam demonstrates repair, without activating a product HTML/provider recipe.
  f.renderer((html) => html); assert.equal((await f.run()).verified, 1); assert.equal(f.claims.get(original.work_id), 1);
  const published = await readFile(path.join(f.native.siteRoot, "public", new URL(f.mappings.get("source-a").canonical_url).pathname, "index.html"), "utf8");
  assert.match(published, /<video controls><source src="https:\/\/media\.example\/movie\.mp4"/u);
  f.renderer(undefined); f.update("source-a", player); assert.equal((await f.run()).local_limitations, 1);
  const stillKnown = f.currentWorks.get("source-a"); f.update("source-a", "<p>New event whose new work is not exposed</p>", "publish_revision", false);
  const count = f.requests.filter(({ route }) => route === "work/claim.json").length, result = await f.run();
  assert.equal(result.discovery_limitations, 1); assert.equal(result.local_issues[0].status, "within_mapping_work_selection_unresolved");
  assert.equal(f.requests.filter(({ route }) => route === "work/claim.json").length, count); assert.equal(f.claims.get(stillKnown.work_id), 1);
});

test("native From retains whole plain/image sources with captured forum article targets and separate rendered proof", async (t) => {
  const f = await fixture(t), plain = "plain unformatted source 😀", image = '<img src="../images/photo.png" alt="Source photograph">';
  f.update("source-a", plain); f.update("source-b", image);
  assert.equal((await f.run()).verified, 1); assert.equal((await f.run()).verified, 1);
  for (const [id, original] of [["source-a", plain], ["source-b", image]]) {
    const mapping = f.mappings.get(id), source = f.sources.get(id).source;
    const journal = JSON.parse(await readFile(path.join(f.native.privateRoot, "journals", `${mapping.mapping_id}.json`), "utf8"));
    assert.equal(journal.last_verified.source_capture.source_article_url, source.topic_url);
    assert.equal((await readSourceCapture(f.native.privateRoot, journal.last_verified.source_capture)).toString(), original);
    const published = await readFile(path.join(f.native.siteRoot, "public", new URL(mapping.canonical_url).pathname, "index.html"), "utf8");
    if (id === "source-a") assert.ok(published.includes(plain));
    else assert.match(published, /src="https:\/\/forum\.example\/t\/images\/photo\.png"/u);
    assert.equal(journal.last_verified.native_result.representation.source_content_sha256, source.content_sha256);
    assert.equal(typeof journal.last_verified.finalize_report.verification.native_publication_sha256, "string");
    assert.notEqual(journal.last_verified.finalize_report.verification.native_publication_sha256, source.content_sha256);
  }
});

test("new semantic losses hold before native publication and retain the accepted edition and exact original", async (t) => {
  const f = await fixture(t);
  f.update("source-a", "<p>Accepted source edition</p>");
  assert.equal((await f.run()).verified, 1);
  const mapping = f.mappings.get("source-a");
  const nativeFile = path.join(f.native.siteRoot, mapping.destination_native_id);
  const journalFile = path.join(f.native.privateRoot, "journals", `${mapping.mapping_id}.json`);
  const acceptedFile = await readFile(nativeFile);
  const accepted = JSON.parse(await readFile(journalFile, "utf8")).last_verified;
  for (const html of [
    '<p onwheel="PRIVATE_CALLBACK()">Wheel interaction</p>',
    '<p style="white-space:pre">A     B</p>',
    '<img src="https://media.example/base.png" srcset="https://media.example/large.png 2x">',
  ]) {
    const source = f.update("source-a", html), start = f.requests.length;
    const result = await f.run();
    assert.equal(result.verified, 0);
    assert.equal(result.local_limitations, 1);
    assert.ok(result.local_issues[0].cause.length > 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CALLBACK/);
    assert.equal(f.requests.slice(start).some(({ route }) => /\/(prepare|finalize|fail|abort)\.json$/u.test(route) && route.startsWith("work/")), false);
    assert.deepEqual(await readFile(nativeFile), acceptedFile);
    assert.deepEqual(JSON.parse(await readFile(journalFile, "utf8")).last_verified, accepted);
    const heldWork = f.currentWorks.get("source-a");
    const held = JSON.parse(await readFile(path.join(f.native.privateRoot, "continuation.json"), "utf8")).held_leases.find((entry) => entry.lease.value.work.work_id === heldWork.work_id);
    assert.ok(held, "the current work has its own retained limitation");
    const issue = JSON.parse(await readFile(path.join(f.native.privateRoot, held.issue_name), "utf8"));
    assert.equal(issue.source.content_sha256, source.content_sha256);
    assert.equal((await readSourceCapture(f.native.privateRoot, issue.source_capture)).toString(), html);
    const afterFirst = f.requests.length;
    assert.equal((await f.run()).claimed, 0);
    assert.equal(f.claims.get(heldWork.work_id), 1);
    assert.equal(f.requests.slice(afterFirst).some(({ route }) => /\/(prepare|finalize|fail|abort|renew)\.json$/u.test(route)), false);
  }
});
