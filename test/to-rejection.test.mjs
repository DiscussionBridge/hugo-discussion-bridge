import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { cmsConfig, connection, json, nativeOrigin } from "../test-support/cms-fixture.mjs";
import { rejectionBuild } from "../test-support/rejection-build.mjs";

const component = process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT ? path.resolve(process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT) : fileURLToPath(new URL("..", import.meta.url));
const { createCmsClient, CmsReceiverRejection } = await import(pathToFileURL(path.join(component, "src/cms-client.mjs")));
const { beginAttempt, readOperationalState, validateOperationalState } = await import(pathToFileURL(path.join(component, "src/operational-state.mjs")));
const { toRecord } = await import(pathToFileURL(path.join(component, "src/to-source.mjs")));
const { semanticIdentity, validateCms } = await import(pathToFileURL(path.join(component, "src/protocol-v4/cms-runtime.mjs")));
const execute = promisify(execFile), hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const rejection = { outcome: "rejected", code: "content_preservation_unavailable", retryable: false, retry_after_seconds: null, correlation_id: null, core_fallback: false };
const equal = (actual, expected) => assert.equal(semanticIdentity(actual), semanticIdentity(expected));

test("r4 client trusts only exact route/status/envelope rejection; malformed and uncertain responses stay distinct", async () => {
  const body = { mutation_id: randomUUID(), bridge_record: toRecord({ full_content_html: "<p>Native article</p>", external_id: "source-a",
    canonical_url: `${nativeOrigin}/a/`, title: "Native", to_created_at: null, to_updated_at: null, source_authors: [] }, connection(), { correlationId: randomUUID() }) };
  const request = (value, status = 422, route = "V4-02") => createCmsClient(cmsConfig, { fetchImpl: async () => json(value, status) }).request(route, route === "V4-02" ? { body } : {});
  await assert.rejects(request(rejection), (error) => {
    assert.ok(error instanceof CmsReceiverRejection); equal(error.rejection, { route_id: "V4-02", http_status: 422, error: rejection }); return true;
  });
  for (const [value, status, route] of [[rejection, 409, "V4-02"], [{ ...rejection, retryable: true }, 422, "V4-02"],
    [{ ...rejection, retry_after_seconds: 30 }, 422, "V4-02"], [{ ...rejection, detail: "not permitted" }, 422, "V4-02"], [rejection, 422, "V4-01"]]) {
    await assert.rejects(request(value, status, route), (error) => !(error instanceof CmsReceiverRejection));
  }
  const malformed = createCmsClient(cmsConfig, { fetchImpl: async () => new Response('{"outcome":"rejected","outcome":"rejected"}', { status: 422, headers: { "content-type": "application/json" } }) });
  await assert.rejects(malformed.request("V4-02", { body }), (error) => !(error instanceof CmsReceiverRejection));
  const uncertain = createCmsClient(cmsConfig, { fetchImpl: async () => { throw new Error("Lost response"); } });
  await assert.rejects(uncertain.request("V4-02", { body }), (error) => error.code === "transport_timeout" && !(error instanceof CmsReceiverRejection));
  assert.throws(() => validateCms("Failure", { mutation_id: randomUUID(), authority: { work_id: randomUUID(), lease_token: Buffer.alloc(32, 7).toString("base64url"),
    lease_generation: 1, source_revision: "revision-1", policy_revision: "policy-1" }, code: rejection.code,
    native_change_applied: false, safe_detail: null, retry_after_seconds: null }));
});

async function fixture(t) {
  const base = path.join(component, ".tmp/rejected-to-tests"); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "local-"));
  t.after(async () => { assert.equal(path.dirname(root), base); await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, "site/content"), { recursive: true }); await mkdir(path.join(root, "site/data"), { recursive: true });
  const serverPath = path.join(root, "server.json"), manifestPath = path.join(root, "manifest.json"), statePath = path.join(root, "private/source.json");
  await writeFile(serverPath, JSON.stringify({ records: {}, receipts: {}, requests: [], reject: [], uncertain: null }));
  const pages = new Map();
  const server = async (change) => { const value = JSON.parse(await readFile(serverPath, "utf8")); if (change) { change(value); await writeFile(serverPath, JSON.stringify(value)); } return value; };
  async function source(key, html, title = key) {
    const bytes = `authored ${key} title=${title}: ${html}`; await writeFile(path.join(root, "site/content", `${key}.md`), bytes);
    pages.set(key, { key, mode: "to_discourse", published: true, external_id: key, canonical_url: `${nativeOrigin}/${key}/`, title,
      content_html: html, native_source_file: `${key}.md`, native_source_sha256: hash(bytes), native_source_created_at: null, native_source_updated_at: null, source_authors: [] });
    await writeFile(manifestPath, JSON.stringify({ site_origin: nativeOrigin, pages: [...pages.values()] }));
  }
  return { root, statePath, server, source, pages, state: () => readOperationalState(statePath),
    run: async () => { try { return await rejectionBuild(root, component); } catch (error) { if (error.native_helper || error.native_process_probe) t.diagnostic(JSON.stringify(error)); throw error; } },
    restart: async () => {
      const value = await execute(process.execPath, ["--import", new URL("./register-runtime.mjs", import.meta.url).href,
        fileURLToPath(new URL("../test-support/rejection-build.mjs", import.meta.url)), root, component], { windowsHide: true });
      return JSON.parse(value.stdout);
    } };
}
const resolves = (server, key) => server.requests.filter(({ route, body }) => route === "bridge-records/resolve.json" && body.bridge_record.external_id === key);

test("actual prepare retains accepted A/rejected B across restart, continues another source, then admits same-body genuine title C with accepted CAS", async (t) => {
  const f = await fixture(t); await f.source("article", "<p>Accepted article A</p>"); await f.run();
  const accepted = (await f.state()).operations.article, acceptedRequest = structuredClone(accepted.lastToRequest);
  await f.source("article", "<p>Rejected complete article B</p>"); await f.source("other", "<p>Independent current source</p>");
  await f.server((value) => { value.reject = ["article"]; }); const result = await f.run();
  let state = await f.state(), current = state.operations.article; const saved = structuredClone(current.rejectedToIntent);
  equal(current.lastToRequest, acceptedRequest); equal(current.pendingToMutation, saved.pending);
  assert.equal(current.outcome, "rejected"); assert.ok(state.operations.other.lastToResponse);
  assert.deepEqual(result.status.rejected_to_intents, [{ external_id: "article", page_key: "article", code: rejection.code, route_id: "V4-02", http_status: 422 }]);
  assert.ok(!JSON.stringify(result.status).includes("Rejected complete article B")); assert.ok(!JSON.stringify(result.status).includes(cmsConfig.connectionSecret));
  const snapshot = await readFile(path.join(path.dirname(f.statePath), saved.pending.native_evidence.source_capture.source_snapshot));
  assert.throws(() => beginAttempt(state, { externalId: "article", canonicalUrl: current.canonicalUrl, pageKey: "article" }), { code: rejection.code });
  await f.server((value) => { value.reject = []; }); // Receiver-only repair is not declared readiness.
  const before = resolves(await f.server(), "article").length; await f.restart();
  current = (await f.state()).operations.article; equal(current.rejectedToIntent, saved); equal(current.pendingToMutation, saved.pending);
  assert.equal(resolves(await f.server(), "article").length, before);
  assert.deepEqual(await readFile(path.join(path.dirname(f.statePath), saved.pending.native_evidence.source_capture.source_snapshot)), snapshot);
  const invalid = structuredClone(await f.state()); invalid.operations.article.rejectedToIntent.receiver.http_status = 409; assert.throws(() => validateOperationalState(invalid));
  await f.source("article", "<p>Rejected complete article B</p>", "Genuine current native title C"); await f.run();
  current = (await f.state()).operations.article; const delivered = resolves(await f.server(), "article").at(-1).body;
  assert.equal(delivered.bridge_record.expected_source_revision, accepted.acceptedSourceRevision);
  assert.notEqual(delivered.bridge_record.source_revision, saved.pending.request.bridge_record.source_revision);
  assert.equal(delivered.bridge_record.title, "Genuine current native title C");
  assert.equal(delivered.bridge_record.source_content_sha256, saved.pending.request.bridge_record.source_content_sha256);
  assert.equal(delivered.bridge_record.source_content_bytes, saved.pending.request.bridge_record.source_content_bytes);
  equal(current.rejectedToHistory, [saved]); assert.equal(current.rejectedToIntent, undefined);
  assert.equal(current.resourceId, accepted.resourceId); assert.equal(current.topicId, accepted.topicId);
  assert.equal(current.lastToRequest.bridge_record.source_updated_at, null); equal(current.toHistory[0].request, acceptedRequest);
  const requests = (await f.server()).requests;
  assert.ok(requests.some(({ route }) => route === `bridge-records/${accepted.resourceId}.json`));
  assert.equal(resolves(await f.server(), "article").filter(({ body }) => body.mutation_id === saved.pending.request.mutation_id).length, 1);
  // A new native disappearance still closes the established accepted binding;
  // it must not replay or hide behind a retained rejected update.
  await f.source("article", "<p>Rejected source D before native deletion</p>"); await f.server((value) => { value.reject = ["article"]; }); await f.run();
  current = (await f.state()).operations.article; const closedPending = structuredClone(current.pendingToMutation), closedRejection = structuredClone(current.rejectedToIntent);
  await rm(path.join(f.root, "site/content/article.md")); f.pages.delete("article");
  await writeFile(path.join(f.root, "manifest.json"), JSON.stringify({ site_origin: nativeOrigin, pages: [...f.pages.values()] }));
  const resolveCount = resolves(await f.server(), "article").length; await f.run(); current = (await f.state()).operations.article;
  assert.equal(current.toWithdrawn.request.reason, "source_deleted"); assert.equal(current.toWithdrawn.request.expected_source_revision, delivered.bridge_record.source_revision);
  equal(current.pendingToMutation, closedPending); equal(current.rejectedToIntent, closedRejection);
  assert.equal(resolves(await f.server(), "article").length, resolveCount);
});

test("rejected first creation remains unbound, CAS mismatch blocks fresh delivery, and uncertain delivery retains exact replay", async (t) => {
  const f = await fixture(t); await f.source("new", "<p>First rejected creation</p>"); await f.server((value) => { value.reject = ["new"]; }); await f.run();
  const rejected = structuredClone((await f.state()).operations.new.rejectedToIntent);
  await f.source("new", "<p>Genuine new complete creation</p>"); await f.server((value) => { value.reject = []; }); await f.run();
  let current = (await f.state()).operations.new; assert.equal(current.lastToRequest.bridge_record.expected_source_revision, null);
  equal(current.rejectedToHistory, [rejected]); assert.equal((await f.server()).requests.some(({ route, body }) => body === null && /^bridge-records\/[^/]+\.json$/u.test(route)), false);
  await f.source("new", "<p>Rejected update</p>"); await f.server((value) => { value.reject = ["new"]; }); await f.run();
  const held = structuredClone((await f.state()).operations.new.rejectedToIntent), before = resolves(await f.server(), "new").length;
  await f.source("new", "<p>Changed current snapshot with foreign predecessor</p>");
  await f.server((value) => { value.records[current.resourceId].source_revision = "foreign-current-edition"; value.reject = []; });
  await assert.rejects(f.run(), { code: "revision_conflict" }); equal((await f.state()).operations.new.rejectedToIntent, held);
  assert.equal(resolves(await f.server(), "new").length, before);
  await f.server((value) => { value.records[current.resourceId].source_revision = current.acceptedSourceRevision; value.uncertain = "new"; });
  await assert.rejects(f.run(), { code: "transport_timeout" }); current = (await f.state()).operations.new;
  const pending = structuredClone(current.pendingToMutation); assert.equal(current.rejectedToIntent, undefined);
  await f.run(); current = (await f.state()).operations.new; equal(current.lastToRequest, pending.request);
  const repeated = resolves(await f.server(), "new").filter(({ body }) => body.mutation_id === pending.request.mutation_id);
  assert.equal(repeated.length, 2); equal(repeated[0].body, repeated[1].body);
});
