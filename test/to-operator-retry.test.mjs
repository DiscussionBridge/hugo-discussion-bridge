// Authored r5 tests. Captured-input seam + mock receiver, not a native Hugo or
// forum proof. Existing real OS writer locks/process lineage and restart child
// run only after Root separately releases these tests.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { cmsConfig, nativeOrigin } from "../test-support/cms-fixture.mjs";
import { rejectionBuild } from "../test-support/rejection-build.mjs";

const component = process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT ? path.resolve(process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT)
  : fileURLToPath(new URL("..", import.meta.url));
const { readOperationalState } = await import(pathToFileURL(path.join(component, "src/operational-state.mjs")));
const { semanticIdentity } = await import(pathToFileURL(path.join(component, "src/protocol-v4/cms-runtime.mjs")));
const { nativeSemanticJson } = await import(pathToFileURL(path.join(component, "src/native-state.mjs")));
const execute = promisify(execFile), hash = (value) => createHash("sha256").update(value).digest("hex");
const fixtureCorrelation = "77777777-7777-4777-8777-777777777777";
const equal = (a, b) => assert.equal(nativeSemanticJson(a), nativeSemanticJson(b));
const resolves = (value) => value.requests.filter((entry) => entry.route === "bridge-records/resolve.json");

async function fixture(t) {
  const base = path.join(component, ".tmp/operator-retry-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "owned-"));
  t.after(async () => { assert.equal(path.dirname(root), base); await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, "site/content"), { recursive: true }); await mkdir(path.join(root, "site/data"), { recursive: true });
  await writeFile(path.join(root, "configuration.json"), JSON.stringify({ fixture: true, secret: "NO_REAL_CREDENTIALS" }));
  const serverPath = path.join(root, "server.json"), statePath = path.join(root, "private/source.json");
  await writeFile(serverPath, JSON.stringify({ records: {}, receipts: {}, requests: [], reject: [], uncertain: null,
    rejectionCode: "invalid_field", rejectionCorrelation: fixtureCorrelation, captureDispatchState: false }));
  const server = async (change) => { const value = JSON.parse(await readFile(serverPath, "utf8"));
    if (change) { change(value); await writeFile(serverPath, JSON.stringify(value)); } return value; };
  async function source(body, title = "Actual captured title") {
    const raw = `fixture authored title=${title}: ${body}`;
    await writeFile(path.join(root, "site/content/article.md"), raw);
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({ site_origin: nativeOrigin, pages: [{ key: "article", external_id: "article",
      mode: "to_discourse", published: true, canonical_url: `${nativeOrigin}/article/`, title, content_html: body,
      native_source_file: "article.md", native_source_sha256: hash(raw), native_source_created_at: null, native_source_updated_at: null, source_authors: [] }] }));
  }
  const run = (retry = null) => rejectionBuild(root, component, retry);
  const retry = (refusedMutationId) => run({ pageKey: "article", refusedMutationId });
  const state = () => readOperationalState(statePath);
  return { root, source, server, run, retry, state, async restart(refusedMutationId) {
    const result = await execute(process.execPath, ["--max-old-space-size=512", "--import", new URL("./register-runtime.mjs", import.meta.url).href,
      fileURLToPath(new URL("../test-support/rejection-build.mjs", import.meta.url)), root, component,
      JSON.stringify({ pageKey: "article", refusedMutationId })], { windowsHide: true });
    return JSON.parse(result.stdout);
  } };
}

test("explicit Retry commits refusal/action/replacement before dispatch; unchanged first creation keeps edition and duplicates mint nothing", async (t) => {
  const f = await fixture(t); await f.source("<p>Complete unchanged source</p>");
  await f.server((server) => { server.reject = ["article"]; }); await f.run();
  const rejected = structuredClone((await f.state()).operations.article.rejectedToIntent);
  assert.equal(rejected.receiver.error.correlation_id, fixtureCorrelation);
  const sourcePath = path.join(path.dirname(path.join(f.root, "private/source.json")), rejected.pending.native_evidence.source_capture.source_snapshot);
  const retainedSource = await readFile(sourcePath);
  await f.server((server) => { server.reject = []; }); const oldCount = resolves(await f.server()).length;
  await f.run(); assert.equal(resolves(await f.server()).length, oldCount); // No automatic repaired-receiver probe/retry.
  await f.server((server) => { server.captureDispatchState = true; });
  await f.retry(rejected.pending.request.mutation_id);
  const current = (await f.state()).operations.article, link = current.toOperatorRetries[0];
  const sent = resolves(await f.server()).at(-1).body;
  assert.notEqual(sent.mutation_id, rejected.pending.request.mutation_id);
  equal(sent.bridge_record, rejected.pending.request.bridge_record);
  assert.equal(sent.bridge_record.expected_source_revision, null);
  assert.equal(sent.bridge_record.source_created_at, null); assert.equal(sent.bridge_record.source_updated_at, null);
  equal(current.rejectedToHistory, [rejected]); equal(link.replacement_pending.request, sent);
  assert.equal(link.action.operator.username, userInfo().username); assert.equal(link.action.operator.pid, process.pid);
  assert.equal(link.action.operator.process_identity.pid, process.pid);
  assert.equal(link.action.refused_mutation_id, rejected.pending.request.mutation_id);
  const atDispatch = (await f.server()).dispatchStates.at(-1);
  equal(atDispatch.pendingToMutation.request, sent); equal(atDispatch.rejectedToHistory, [rejected]);
  assert.equal(atDispatch.toOperatorRetries.length, 1); assert.equal(atDispatch.rejectedToIntent, undefined);
  assert.deepEqual(await readFile(sourcePath), retainedSource);
  const count = resolves(await f.server()).length;
  assert.equal((await f.retry(rejected.pending.request.mutation_id)).retry_action, "already_recorded");
  assert.equal(resolves(await f.server()).length, count); assert.equal(Object.keys((await f.server()).records).length, 1);
  equal((await f.state()).operations.article.toOperatorRetries, current.toOperatorRetries);
  assert.ok(!JSON.stringify(link).includes(cmsConfig.connectionSecret));
});

test("uncertain linked Retry survives actual process restart with the same new UUID and accepted predecessor", async (t) => {
  const f = await fixture(t); await f.source("<p>Accepted A</p>"); await f.run();
  const accepted = structuredClone((await f.state()).operations.article);
  await f.source("<p>Refused B</p>"); await f.server((server) => { server.reject = ["article"]; }); await f.run();
  const rejected = structuredClone((await f.state()).operations.article.rejectedToIntent);
  await f.server((server) => { server.reject = []; server.uncertain = "article"; });
  await assert.rejects(f.retry(rejected.pending.request.mutation_id), { code: "transport_timeout" });
  const uncertain = (await f.state()).operations.article, pending = structuredClone(uncertain.pendingToMutation), link = structuredClone(uncertain.toOperatorRetries[0]);
  assert.equal(pending.request.bridge_record.expected_source_revision, accepted.acceptedSourceRevision);
  equal(pending.request.bridge_record, rejected.pending.request.bridge_record);
  await f.restart(rejected.pending.request.mutation_id);
  const current = (await f.state()).operations.article;
  equal(current.lastToRequest, pending.request); equal(current.toOperatorRetries[0], link);
  assert.equal(current.resourceId, accepted.resourceId); assert.equal(current.topicId, accepted.topicId);
  const repeated = resolves(await f.server()).filter((entry) => entry.body.mutation_id === pending.request.mutation_id);
  assert.equal(repeated.length, 2); equal(repeated[0].body, repeated[1].body);
  assert.equal(resolves(await f.server()).filter((entry) => entry.body.mutation_id === rejected.pending.request.mutation_id).length, 1);
});

test("repeated refusal stops, stale action cannot retry it, and genuine same-body title edition remains ordinary", async (t) => {
  const f = await fixture(t); await f.source("<p>Unchanged article body</p>");
  await f.server((server) => { server.reject = ["article"]; }); await f.run();
  const first = structuredClone((await f.state()).operations.article.rejectedToIntent);
  await assert.rejects(f.retry(first.pending.request.mutation_id), { code: "invalid_field" });
  const refusedAgain = structuredClone((await f.state()).operations.article.rejectedToIntent);
  assert.notEqual(refusedAgain.pending.request.mutation_id, first.pending.request.mutation_id);
  equal(refusedAgain.pending.request.bridge_record, first.pending.request.bridge_record);
  const count = resolves(await f.server()).length; await f.run(); await f.retry(first.pending.request.mutation_id);
  assert.equal(resolves(await f.server()).length, count);
  equal((await f.state()).operations.article.rejectedToIntent, refusedAgain);
  await f.source("<p>Unchanged article body</p>", "Genuine changed native title");
  await f.server((server) => { server.reject = []; }); await f.run();
  const current = (await f.state()).operations.article;
  assert.notEqual(current.lastToRequest.bridge_record.source_revision, refusedAgain.pending.request.bridge_record.source_revision);
  assert.equal(current.lastToRequest.bridge_record.source_content_sha256, first.pending.request.bridge_record.source_content_sha256);
  assert.equal(current.lastToRequest.bridge_record.source_created_at, null); assert.equal(current.lastToRequest.bridge_record.source_updated_at, null);
  equal(current.rejectedToHistory, [first, refusedAgain]); assert.equal(current.toOperatorRetries.length, 1);
});

test("current accepted04 CAS mismatch and unknown original intent cannot allocate an operator replacement", async (t) => {
  const f = await fixture(t); await f.source("<p>Accepted source</p>"); await f.run();
  const accepted = structuredClone((await f.state()).operations.article);
  await f.source("<p>Refused update</p>"); await f.server((server) => { server.reject = ["article"]; }); await f.run();
  const refused = structuredClone((await f.state()).operations.article.rejectedToIntent), count = resolves(await f.server()).length;
  await f.server((server) => { server.reject = []; server.records[accepted.resourceId].source_revision = "foreign-revision"; });
  await assert.rejects(f.retry(refused.pending.request.mutation_id), { code: "revision_conflict" });
  equal((await f.state()).operations.article.rejectedToIntent, refused);
  assert.equal((await f.state()).operations.article.toOperatorRetries, undefined);
  assert.equal(resolves(await f.server()).length, count);
  await assert.rejects(f.retry("11111111-1111-4111-8111-111111111111"), { code: "native_ownership_conflict" });
  assert.equal(resolves(await f.server()).length, count);
});
