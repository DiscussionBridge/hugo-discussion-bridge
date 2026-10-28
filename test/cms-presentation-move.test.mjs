import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { cmsConfig, connection, json, leaseToken, mappingId, nativeOrigin, work } from "../test-support/cms-fixture.mjs";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const component = process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT ? path.resolve(process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT) : checkout;
const { runHugoNativeCms } = await import(pathToFileURL(path.join(component, "src", "cms-native.mjs")));
const { ownedNativeFragment } = await import(pathToFileURL(path.join(component, "src", "cms-proof.mjs")));
const { validateCms, semanticIdentity } = await import(pathToFileURL(path.join(component, "src", "protocol-v4", "cms-runtime.mjs")));
const execute = promisify(execFile), base = path.join(checkout, ".tmp", "presentation-move-tests"), sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  await execute("hugo", ["version"]); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "native-"));
  t.after(async () => { assert.equal(path.dirname(root), base); await rm(root, { recursive: true, force: true }); });
  const siteRoot = path.join(root, "site"), privateRoot = path.join(root, "private"), deployed = path.join(root, "deployed"), deployments = path.join(root, "deployments.json");
  for (const dir of ["content", "data", "layouts", "static"]) await mkdir(path.join(siteRoot, dir), { recursive: true });
  await writeFile(path.join(siteRoot, "hugo.toml"), `baseURL='${nativeOrigin}/'\ndisableKinds=['taxonomy','term','rss','sitemap']\n[[module.mounts]]\nsource='layouts'\ntarget='layouts'\n[[module.mounts]]\nsource=${JSON.stringify(path.join(component, "layouts").replaceAll("\\", "/"))}\ntarget='layouts'\n`);
  await writeFile(path.join(siteRoot, "layouts", "home.html"), "<html><body>Home</body></html>");
  await writeFile(path.join(siteRoot, "layouts", "page.html"), "<html><body>{{ .Content }}</body></html>");
  const deploy = path.join(root, "deploy.mjs");
  await writeFile(deploy, `import {cp,rm,writeFile,readFile} from 'node:fs/promises'; import path from 'node:path'; const [src,dest,receipt,id,ledger]=process.argv.slice(2); if(path.dirname(path.resolve(dest))!==${JSON.stringify(root)}) throw Error('Fixture path escaped'); let list=[]; try{list=JSON.parse(await readFile(ledger))}catch(e){if(e.code!=='ENOENT')throw e}; await rm(dest,{recursive:true,force:true}); await cp(src,dest,{recursive:true}); const result={deployment_id:id,deployed_at:new Date().toISOString()}; list.push(result); await writeFile(ledger,JSON.stringify(list)); await writeFile(receipt,JSON.stringify(result));`);
  const native = { siteRoot, privateRoot, siteUrl: nativeOrigin, nativeShortcode: "discussionbridge", maximumClaims: 1,
    build: { executable: "hugo", args: ["--source", "{site_root}", "--destination", "{public_root}", "--cleanDestinationDir", "--cacheDir", path.join(root, "cache")], timeoutMs: 30000 },
    deploy: { executable: process.execPath, args: [deploy, "{public_root}", deployed, "{receipt_path}", "{transaction_id}", deployments], timeoutMs: 30000 } };
  let mapping, current, generation = 0, expiry, sequence = 0, delivered = 0, source, bytes, wrong = false, staticWrong = false, race = false;
  const history = new Map(), archive = new Map(), requests = [], moves = [], events = [], mutations = new Map(), losses = new Set();
  const offer = () => { if (current && !["verified", "attention"].includes(current.state)) current.state = "superseded";
    current = { ...work(), work_id: randomUUID(), state: "pending", attempt: 0, lease_generation: generation, attempt_cycle: randomUUID(), source_revision: source.source_revision };
    history.set(current.work_id, current); if (mapping) mapping.desired_source_revision = source.source_revision; };
  const revision = (number) => { bytes = Buffer.from(`<h2>Native article</h2><p>Complete edition ${number} 😀 source</p>`);
    source = { source_id: "source-a", source_revision: `revision-${number}`, topic_id: "53", topic_url: `${cmsConfig.serverUrl}/t/source/53`, title: "Native source",
      content_sha256: sha(bytes), content_bytes: bytes.length, source_created_at: null, source_updated_at: null, source_authors: [{ id: "alice", name: "Alice" }, { id: "bob", name: "Bob" }] };
    archive.set(source.source_revision, { source, bytes }); events.push({ event_type: "publication", event_id: randomUUID(), event_sequence: String(++sequence), source }); offer(); };
  revision(1);
  const status = (value = current) => ({ work: value, mapping, lease_expires_at: value.state === "pending" ? null : expiry });
  const remember = (body, value, statusCode = 200) => { mutations.set(body.mutation_id, { request: structuredClone(body), value: structuredClone(value), status: statusCode }); return json(value, statusCode); };
  const authority = (value) => { assert.equal(value.work_id, current.work_id); assert.equal(value.lease_token, leaseToken); assert.equal(value.lease_generation, current.lease_generation);
    assert.equal(value.source_revision, current.source_revision); assert.equal(value.policy_revision, current.policy_revision); assert.ok(["leased", "synchronized"].includes(current.state)); };
  const cmsFetch = async (address, options) => {
    const url = new URL(address), route = url.pathname.replace("/discussion-bridge/v4/", ""), body = options.body ? JSON.parse(options.body) : null;
    assert.equal(url.origin, cmsConfig.serverUrl); assert.equal(options.headers["X-DiscussionBridge-Connection"], cmsConfig.connectionId); requests.push({ route, body });
    if (body && mutations.has(body.mutation_id)) { const receipt = mutations.get(body.mutation_id); assert.equal(semanticIdentity(receipt.request), semanticIdentity(body)); return json(receipt.value, receipt.status); }
    if (route === "connection.json") return json(connection());
    if (route === "sources.json") { const items = delivered === sequence ? [] : url.searchParams.get("stream") === "initial" ? [events.at(-1)] : events.filter((entry) => Number(entry.event_sequence) > delivered); delivered = sequence;
      return json({ stream: url.searchParams.get("stream"), items, next_cursor: null, checkpoint_cursor: `checkpoint_${sequence}` }); }
    if (route === "mappings/prepare.json") { mapping = { mapping_id: mappingId, resource_id: randomUUID(), connection_id: cmsConfig.connectionId, source_id: source.source_id,
      external_id: body.external_id, canonical_url: body.canonical_url, mapping_revision: "mapping-1", destination_native_id: null, retired_url_count: 0, mapping_state: "pending", presentation_mode: "interactive",
      desired_source_revision: source.source_revision, synchronized_source_revision: null, publicly_verified_source_revision: null, destination_native_revision: null, source_created_at: null,
      source_updated_at: null, synchronized_at: null, publicly_verified_at: null }; return remember(body, mapping); }
    if (route === "work/claim.json") { if (current.state !== "pending" || body.mapping_id !== undefined && body.mapping_id !== mappingId) return new Response(null, { status: 204 });
      current.state = "leased"; current.attempt++; current.lease_generation = ++generation; expiry = new Date(Date.now() + 300000).toISOString();
      return remember(body, { work: current, lease_token: leaseToken, lease_generation: generation, expires_at: expiry, server_time: new Date().toISOString() }); }
    if (route.includes("/content.json")) { const requested = decodeURIComponent(route.split("/")[3]), value = archive.get(requested), offset = Number(url.searchParams.get("offset")), end = Math.min(value.bytes.length, offset + 32767);
      return json({ source_id: source.source_id, source_revision: requested, content_sha256: value.source.content_sha256, content_bytes: value.bytes.length, offset, next_offset: end === value.bytes.length ? null : end, content_base64: value.bytes.subarray(offset, end).toString("base64") }); }
    const moveRoute = new RegExp(`^mappings/${mappingId}/url-moves(?:/([^/]+)/(finalize|abort))?\\.json$`, "u").exec(route);
    if (moveRoute) {
      authority(body.authority); const operation = moveRoute[2] ?? "prepare";
      if (operation === "prepare") {
        validateCms("UrlMovePrepare", body); assert.equal(current.state, "leased"); assert.equal(body.expected_mapping_revision, mapping.mapping_revision); assert.equal(body.old_url, mapping.canonical_url);
        assert.equal(body.ownership.native_id, mapping.destination_native_id); assert.equal(body.ownership.source_revision, source.source_revision);
        const move = { move_id: randomUUID(), mapping_id: mappingId, expected_mapping_revision: mapping.mapping_revision, old_url: body.old_url, new_url: body.new_url,
          proof_nonce: Buffer.alloc(32, moves.length + 11).toString("base64url"), state: "prepared", prepared_at: new Date().toISOString() };
        moves.push(move); const response = remember(body, move, 201); if (losses.delete("move-prepare")) throw Error("Lost accepted move prepare"); return response;
      }
      const move = moves.find((value) => value.move_id === moveRoute[1]); assert.ok(move); assert.equal(body.move_id, move.move_id);
      if (operation === "finalize") {
        validateCms("UrlMoveFinalize", body); assert.equal(body.proof_nonce, move.proof_nonce); assert.equal(mapping.canonical_url, move.old_url); assert.equal(mapping.mapping_revision, move.expected_mapping_revision);
        const html = await readFile(path.join(deployed, new URL(move.new_url).pathname, "index.html"));
        const actual = ownedNativeFragment(html, { mappingId, resourceId: mapping.resource_id, nativeId: mapping.destination_native_id, sourceRevision: source.source_revision,
          presentationMode: "interactive", moveId: move.move_id, proofNonce: move.proof_nonce, canonicalUrl: move.new_url });
        assert.equal(body.verification.native_publication_sha256, actual.sha256); assert.equal(body.verification.source_content_sha256, source.content_sha256);
        mapping.canonical_url = move.new_url; mapping.mapping_revision = `mapping-${moves.length + 1}`; mapping.retired_url_count++; move.state = "committed";
        const response = remember(body, mapping); if (losses.delete("move-finalize")) throw Error("Lost accepted move finalize"); return response;
      }
      validateCms("UrlMoveAbort", body); move.state = body.native_change_applied ? "attention" : "aborted"; if (body.native_change_applied) mapping.mapping_state = "attention";
      const response = remember(body, move); if (losses.delete("move-abort")) throw Error("Lost accepted move abort"); return response;
    }
    const workRoute = /^work\/([^/]+)(?:\/(renew|prepare|finalize|abort|fail))?\.json$/u.exec(route); assert.ok(workRoute, route);
    const value = history.get(workRoute[1]); assert.ok(value); if (!workRoute[2]) return json(status(value)); authority(body.authority);
    if (workRoute[2] === "renew") { expiry = new Date(Date.now() + 300000).toISOString(); return remember(body, { work: current, lease_token: leaseToken, lease_generation: generation, expires_at: expiry, server_time: new Date().toISOString() }); }
    if (workRoute[2] === "prepare") { validateCms("StaticPreparation", body); assert.equal(body.native_result.canonical_url, mapping.canonical_url); current.state = "synchronized";
      mapping.destination_native_id = body.native_result.native_id; mapping.destination_native_revision = body.native_result.native_revision; mapping.synchronized_source_revision = current.source_revision; mapping.synchronized_at = body.prepared_at; }
    else if (workRoute[2] === "finalize") { validateCms("StaticFinalize", body); assert.equal(body.verification.url, mapping.canonical_url); assert.ok(body.deployed_at >= mapping.synchronized_at); assert.ok(body.verification.checked_at >= body.deployed_at);
      current.state = "verified"; mapping.mapping_state = "active"; mapping.publicly_verified_source_revision = current.source_revision; mapping.publicly_verified_at = body.verification.checked_at; }
    else { if (workRoute[2] === "fail") validateCms("Failure", body); current.state = "attention"; mapping.mapping_state = "attention"; }
    const response = remember(body, status()); if (workRoute[2] === "fail" && losses.delete("work-fail")) throw Error("Lost accepted work failure"); return response;
  };
  const publicFetch = async (address, options) => {
    const url = new URL(address); assert.equal(url.origin, nativeOrigin); assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
    assert.equal(Object.keys(options.headers).some((key) => /secret|connection|authorization/iu.test(key)), false);
    if (moves.at(-1)?.new_url === url.href && moves.at(-1).state === "prepared") {
      if (race) { race = false; revision(2); }
      if (wrong) return new Response("Unrelated new URL page", { headers: { "content-type": "text/html" } });
    }
    if (staticWrong && moves.at(-1)?.new_url === url.href && moves.at(-1).state === "committed") return new Response("Mismatching static settlement", { headers: { "content-type": "text/html" } });
    try { return new Response(await readFile(path.join(deployed, url.pathname, "index.html")), { headers: { "content-type": "text/html" } }); }
    catch (error) { if (error.code === "ENOENT") return new Response(null, { status: 404 }); throw error; }
  };
  const run = async (presentationMove) => { try { return await runHugoNativeCms({ native, connectionConfig: cmsConfig, cmsFetch, publicFetch, ...(presentationMove ? { presentationMove } : {}) }); }
    catch (error) { t.diagnostic(JSON.stringify({ message: error.message, code: error.code, native_helper: error.native_helper, native_process_probe: error.native_process_probe })); throw error; } };
  return { root, native, requests, moves, run, revision, adminUrlCycle: offer, mapping: () => mapping, source: () => source, work: () => current, lose: (name) => losses.add(name),
    wrong: () => { wrong = true; }, staticWrong: () => { staticWrong = true; }, race: () => { race = true; }, moveRequest: () => ({ mappingId, expectedMappingRevision: mapping.mapping_revision, newUrl: `${nativeOrigin}/moved/native-article/` }),
    journal: async () => JSON.parse(await readFile(path.join(privateRoot, "journals", `${mappingId}.json`))), deployments: async () => JSON.parse(await readFile(deployments)),
    cache: async () => { const name = `source-${sha(`${cmsConfig.connectionId}\0${source.source_id}`)}.json`; return JSON.parse(await readFile(path.join(native.siteRoot, "data", "discussionbridge", name))); } };
}

test("native presentation move retains object/source/discussion IDs and separately settles current static work", async (t) => {
  const f = await fixture(t); assert.equal((await f.run()).verified, 1); const before = structuredClone(f.mapping()), article = (await f.cache()).content_html;
  f.adminUrlCycle(); const currentWork = f.work().work_id, request = f.moveRequest(); assert.equal((await f.run(request)).verified, 1);
  assert.equal(f.mapping().canonical_url, request.newUrl); assert.equal(f.mapping().retired_url_count, 1);
  for (const field of ["mapping_id", "resource_id", "source_id", "external_id", "destination_native_id", "desired_source_revision"]) assert.equal(f.mapping()[field], before[field]);
  assert.equal((await f.cache()).content_html, article); assert.equal(f.source().source_revision, "revision-1"); assert.equal(f.work().work_id, currentWork);
  const sequence = f.requests.filter(({ body }) => body?.authority?.work_id === currentWork).map(({ route }) => route);
  const moveFinalize = sequence.findIndex((route) => /url-moves.*finalize/u.test(route)), prepare = sequence.findIndex((route) => /^work\/.*\/prepare/u.test(route)); assert.ok(moveFinalize >= 0 && prepare > moveFinalize);
  const journal = await f.journal(); assert.equal(journal.transaction.presentation_move.phase, "committed"); assert.equal(journal.transaction.presentation_move.baseline_pending, false);
  assert.equal(journal.transaction.presentation_move.prior_verified.receipt.canonical_url, before.canonical_url); assert.equal(journal.last_verified.receipt.canonical_url, request.newUrl);
  assert.equal((await f.deployments()).length, 3); // Initial publication, real move, fresh static settlement.
  f.revision(2); assert.equal((await f.run()).verified, 1); assert.equal(f.mapping().canonical_url, request.newUrl); assert.equal(f.mapping().destination_native_id, before.destination_native_id);
});

test("native move uncertain prepare/finalize replays exact requests without repeated move deployment", async (t) => {
  const f = await fixture(t); await f.run(); f.adminUrlCycle(); const request = f.moveRequest(); f.lose("move-prepare"); await assert.rejects(f.run(request), { code: "transport_timeout" });
  assert.equal((await f.deployments()).length, 1); f.lose("move-finalize"); await assert.rejects(f.run(), { code: "transport_timeout" });
  assert.equal((await f.deployments()).length, 2); assert.equal((await f.run()).verified, 1); assert.equal((await f.deployments()).length, 3);
  for (const suffix of ["url-moves.json", "/finalize.json"]) {
    const posts = f.requests.filter(({ route }) => route.includes("url-moves") && route.endsWith(suffix)); assert.equal(posts.length, 2); assert.deepEqual(posts[0].body, posts[1].body);
  }
});

test("native move mapping/file CAS and superseding source race never commit stale URL proof", async (t) => {
  const f = await fixture(t); await f.run(); f.adminUrlCycle(); const request = f.moveRequest();
  await assert.rejects(f.run({ ...request, expectedMappingRevision: "stale-mapping" }), { code: "native_restore_required" });
  const nativeFile = path.join(f.native.siteRoot, f.mapping().destination_native_id); await writeFile(nativeFile, (await readFile(nativeFile)) + "\nNative local edit\n");
  await assert.rejects(f.run(request)); assert.equal(f.requests.some(({ route }) => route.endsWith("url-moves.json")), false);
  const race = await fixture(t); await race.run(); const before = structuredClone(race.mapping()); race.adminUrlCycle(); race.race(); await assert.rejects(race.run(race.moveRequest()), { code: "lease_conflict" });
  assert.equal(race.moves[0].state, "prepared"); assert.equal(race.mapping().canonical_url, before.canonical_url); assert.equal(race.requests.some(({ route }) => /url-moves.*finalize/u.test(route)), false);
  assert.equal((await race.journal()).transaction.presentation_move.phase, "applied"); assert.equal((await race.journal()).last_verified.receipt.canonical_url, before.canonical_url);
});

test("native move public mismatch restores real old output then replays applied abort before permanent work failure", async (t) => {
  const f = await fixture(t); await f.run(); const before = structuredClone(f.mapping()); f.adminUrlCycle(); const workId = f.work().work_id, request = f.moveRequest(); f.wrong(); f.lose("move-abort");
  await assert.rejects(f.run(request), { code: "transport_timeout" }); const move = (await f.journal()).transaction.presentation_move;
  assert.equal(move.phase, "restored"); assert.equal(move.had_native_change, true); assert.equal(move.rollback_verification.url, before.canonical_url); assert.equal(f.moves[0].state, "attention");
  f.lose("work-fail"); await assert.rejects(f.run(request), { code: "transport_timeout" }); assert.equal((await f.run(request)).attention, 1);
  const aborts = f.requests.filter(({ route }) => /url-moves.*abort/u.test(route)); assert.equal(aborts.length, 2); assert.equal(aborts[0].body.native_change_applied, true); assert.deepEqual(aborts[0].body, aborts[1].body);
  const failures = f.requests.filter(({ route }) => route === `work/${workId}/fail.json`); assert.equal(failures.length, 2); assert.deepEqual(failures[0].body, failures[1].body); assert.equal(failures[0].body.code, "public_verification_failed");
  assert.equal(f.requests.some(({ route }) => route === `work/${workId}/prepare.json`), false); assert.equal(f.mapping().canonical_url, before.canonical_url); assert.equal(f.work().state, "attention");
});

test("static failure after accepted URL finalization restores the moved native baseline without undoing URL ancestry", async (t) => {
  const f = await fixture(t); await f.run(); const before = structuredClone(f.mapping()); f.adminUrlCycle(); const request = f.moveRequest(); f.staticWrong();
  assert.equal((await f.run(request)).attention, 1); const journal = await f.journal();
  assert.equal(f.mapping().canonical_url, request.newUrl); assert.equal(f.moves[0].state, "committed"); assert.equal(f.mapping().retired_url_count, 1);
  assert.equal(journal.transaction.phase, "restored"); assert.equal(journal.last_verified.receipt.canonical_url, before.canonical_url);
  assert.equal(journal.transaction.presentation_move.phase, "committed"); assert.equal(journal.transaction.presentation_move.baseline_pending, true);
  assert.match(await readFile(path.join(f.native.siteRoot, f.mapping().destination_native_id), "utf8"), /url = "\/moved\/native-article\/"/u);
  assert.equal(f.requests.some(({ route }) => /url-moves.*abort/u.test(route)), false);
});
