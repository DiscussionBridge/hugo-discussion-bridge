import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { cmsConfig, connection, nativeOrigin } from "../test-support/cms-fixture.mjs";
const component = process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT ? path.resolve(process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT) : fileURLToPath(new URL("..", import.meta.url));
const { moveToSourceUrl } = await import(pathToFileURL(path.join(component, "src/to-source-move.mjs")));
const { sourceMoveFileCas, keepSourceMoveBlob, readSourceMoveBlob, validateToSourceMoves } = await import(pathToFileURL(path.join(component, "src/to-source-move-state.mjs")));
const { toRecord } = await import(pathToFileURL(path.join(component, "src/to-source.mjs")));
const { preserveSourceCapture, prepareNativeToSource } = await import(pathToFileURL(path.join(component, "src/source-preparation.mjs")));
const { nativeSemanticJson } = await import(pathToFileURL(path.join(component, "src/native-state.mjs")));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function ownedRoot(t) {
  const base = path.join(component, ".tmp/source-move-state-tests"); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "owned-"));
  t.after(async () => { assert.equal(path.dirname(root), base); await rm(root, { recursive: true, force: true }); }); return root;
}

test("source move authored CAS retains foreign bytes and immutable snapshots across fence interruption", async (t) => {
  const root = await ownedRoot(t), source = path.join(root, "article.md"), original = Buffer.from("original authored body"), next = Buffer.from("same article new native URL");
  await writeFile(source, original); const transaction = randomUUID();
  const saved = await keepSourceMoveBlob(root, transaction, "authored-before.bin", original);
  await assert.rejects(keepSourceMoveBlob(root, transaction, "authored-before.bin", next));
  let fences = 0;
  await assert.rejects(sourceMoveFileCas(source, hash(original), next, async () => { if (++fences === 2) throw new Error("Owned fixture lost fence before replacement"); }));
  assert.deepEqual(await readFile(source), original); assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp")), false);
  const foreign = Buffer.from("actual out-of-band edit"); await writeFile(source, foreign);
  await assert.rejects(sourceMoveFileCas(source, hash(original), next, async () => {}), { code: "native_local_edit_conflict" });
  assert.deepEqual(await readFile(source), foreign); assert.deepEqual(await readSourceMoveBlob(root, saved), original);
  await writeFile(path.join(root, ...saved.path.split("/")), next);
  await assert.rejects(readSourceMoveBlob(root, saved));
});

test("prepared-only source move abort survives lost30 and restart without native execution or rewriting exact intent", async (t) => {
  const root = await ownedRoot(t), site = path.join(root, "site"), privateRoot = path.join(root, "private"), content = path.join(site, "content");
  await mkdir(content, { recursive: true }); const source = path.join(content, "article.md"), stateFile = path.join(privateRoot, "operation.json");
  const authored = Buffer.from('+++\ntitle="Actual native title"\ndiscussionbridge_mode="to_discourse"\n+++\nActual source article\n');
  await writeFile(source, authored); await writeFile(path.join(site, "hugo.toml"), "baseURL='https://hugo.example/'\n");
  const original = "<p>Actual source article</p>", canonical = `${nativeOrigin}/article/`, sourceId = "native-file-external-id";
  const page = { external_id: sourceId, canonical_url: canonical, title: "Actual native title", mode: "to_discourse", published: true, native_publication: false,
    content_html: original, full_content_html: prepareNativeToSource(original, canonical).html, source_authors: [], native_source_created_at: null, native_source_updated_at: null,
    to_created_at: null, to_updated_at: null, native_source_file: "article.md", native_source_sha256: hash(authored) };
  const current = connection(); current.directions = ["to_discourse"]; current.policy.enabled = false;
  let operation = { externalId: sourceId, resourceId: randomUUID(), topicId: "9007199254740993", pageKey: "article", canonicalUrl: canonical, correlationId: randomUUID(),
    toBinding: { connection_id: cmsConfig.connectionId, forum_origin: cmsConfig.serverUrl, native_origin: nativeOrigin } };
  const record = toRecord(page, current, operation); operation.acceptedSourceRevision = record.source_revision;
  operation.lastToRequest = { mutation_id: randomUUID(), bridge_record: record };
  operation.lastToResponse = { outcome: "created", reason: "record_created", resource_id: operation.resourceId, topic_id: operation.topicId,
    topic_url: `${cmsConfig.serverUrl}/t/source/${operation.topicId}`, direction: "to_discourse", source_revision: record.source_revision, synchronized_at: new Date().toISOString(), core_fallback: false };
  operation.toNativeBinding = { site_root: site, content_root: content, source_file: "article.md", source_sha256: hash(authored), source_revision: record.source_revision,
    scope_revision: "historical-scope", policy_revision: "historical-from-policy", lane: "default" };
  operation.toSourceCapture = await preserveSourceCapture(privateRoot, { source_id: sourceId, source_revision: hash(original), content_sha256: hash(original), content_bytes: Buffer.byteLength(original) }, Buffer.from(original), canonical);
  const accepted = { resource_id: operation.resourceId, topic_id: operation.topicId, topic_url: operation.lastToResponse.topic_url, direction: "to_discourse", state: "active", external_id: sourceId,
    canonical_url: canonical, source_revision: record.source_revision, source_created_at: null, source_updated_at: null, synchronized_at: operation.lastToResponse.synchronized_at, mapping_id: null };
  const config = { ...cmsConfig, toNative: { siteRoot: site, contentRoot: content, sourceMoves: { profile: "hugo-to-owned-full-article-1", dataRoot: path.join(site, "data"), publicRoot: path.join(site, "public"), artifactPattern: "{url_path}/index.html", inputs: ["hugo.toml"],
    build: { executable: process.execPath, args: ["--version"], timeoutMs: 30000 }, deploy: { executable: process.execPath, args: ["--version"], timeoutMs: 30000 } } } };
  let pause = true, lost = true, move; const calls = [], receipts = new Map();
  const client = { origin: cmsConfig.serverUrl, async request(route, request = {}) {
    calls.push({ route, body: request.body && structuredClone(request.body) });
    if (route === "V4-01") return { value: current };
    if (route === "V4-04") return { value: accepted };
    if (route === "V4-28") { move = { move_id: randomUUID(), resource_id: operation.resourceId, expected_source_revision: record.source_revision, old_url: canonical, new_url: request.body.new_url,
      proof_nonce: randomBytes(32).toString("base64url"), state: "prepared", prepared_at: new Date().toISOString() }; return { value: move }; }
    if (route === "V4-30") {
      assert.equal(request.body.native_change_applied, false); const prior = receipts.get(request.body.mutation_id);
      if (prior) { assert.equal(nativeSemanticJson(prior.request), nativeSemanticJson(request.body)); return { value: prior.response }; }
      const response = { ...move, state: "aborted" }; receipts.set(request.body.mutation_id, { request: structuredClone(request.body), response });
      if (lost) { lost = false; throw Object.assign(new Error("Owned fixture lost accepted30"), { code: "transport_timeout" }); }
      return { value: response };
    }
    throw new Error(`Unexpected route ${route}`);
  } };
  const save = async () => { validateToSourceMoves(operation); await writeFile(stateFile, nativeSemanticJson(operation)); if (pause && operation.sourceMoves?.pending?.phase === "prepared") { pause = false; throw Object.assign(new Error("Owned fixture paused after saved28"), { code: "fixture_pause" }); } };
  const invoke = (abortMove = false) => moveToSourceUrl({ operation, page, newUrl: `${nativeOrigin}/new/`, config, privateRoot, connection: current, client, save,
    assertFence: async () => {}, abortMove, capturePage: async () => { throw new Error("Unapplied abort must not rebuild/capture native output"); }, publicFetch: async () => { throw new Error("Unapplied abort must not invent public proof"); } });
  await assert.rejects(invoke(), { code: "fixture_pause" }); const prepared = structuredClone(operation.sourceMoves.pending.prepare);
  assert.deepEqual(await readFile(source), authored); assert.equal(operation.sourceMoves.pending.commands.length, 0);
  operation = JSON.parse(await readFile(stateFile, "utf8")); validateToSourceMoves(operation);
  await assert.rejects(invoke(true), { code: "transport_timeout" }); const pending = structuredClone(operation.sourceMoves.pending.abort);
  assert.equal(operation.sourceMoves.pending.phase, "abort_intent"); assert.deepEqual(operation.sourceMoves.pending.prepare, prepared);
  operation = JSON.parse(await readFile(stateFile, "utf8")); validateToSourceMoves(operation);
  const foreign = Buffer.from("actual foreign source after uncertain abort"); await writeFile(source, foreign);
  await assert.rejects(invoke(true), { code: "native_restore_required" }); assert.deepEqual(await readFile(source), foreign);
  assert.equal(calls.filter(({ route }) => route === "V4-30").length, 1);
  await writeFile(source, authored); const result = await invoke(true); assert.equal(result.move.state, "aborted");
  assert.equal(operation.sourceMoves.pending, null); assert.deepEqual(operation.sourceMoves.history[0].abort.request, pending.request);
  assert.equal(calls.filter(({ route }) => route === "V4-28").length, 1); assert.equal(calls.filter(({ route }) => route === "V4-30").length, 2);
  assert.equal(operation.sourceMoves.history[0].commands.length, 0); assert.deepEqual(await readFile(source), authored);
  const corrupt = structuredClone(operation); corrupt.sourceMoves.history[0].abort.request.native_change_applied = true;
  assert.throws(() => validateToSourceMoves(corrupt));
});
