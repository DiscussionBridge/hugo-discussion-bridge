import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { cmsConfig, connection, nativeOrigin } from "../test-support/cms-fixture.mjs";

const component = process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT
  ? path.resolve(process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT)
  : fileURLToPath(new URL("..", import.meta.url));
const { stageOperatorRetry, rejectedToCode, validateOperationalState, decodeOperationalState, summarizeOperationalState,
  SOURCE_CANDIDATE, SOURCE_STATE_IDENTITY } = await import(pathToFileURL(path.join(component, "src/operational-state.mjs")));
const { toRecord, payloadIdentity } = await import(pathToFileURL(path.join(component, "src/to-source.mjs")));
const { validateLocalRetryRecord, assertLocalRetryAction } = await import(pathToFileURL(path.join(component, "src/to-retry-action.mjs")));
const { nativeSemanticJson } = await import(pathToFileURL(path.join(component, "src/native-state.mjs")));
const hash = (value) => createHash("sha256").update(value).digest("hex");
// These assertions compare private OS audit records as well as wire payloads.
// The private canonicalizer preserves signed local IDs; wire validation occurs
// in the actual decoder and validateOperationalState, before this comparison.
const equal = (actual, expected) => assert.equal(nativeSemanticJson(actual), nativeSemanticJson(expected));
const created = "2026-09-01T10:00:00.000Z", edited = "2026-10-14T11:00:00.000Z", invoked = "2026-10-15T03:00:00.000Z";

function decodedError(code = "invalid_field", correlationId = null) {
  return { outcome: "rejected", code, retryable: false, retry_after_seconds: null, correlation_id: correlationId, core_fallback: false };
}

function page(content, updatedAt) {
  return { full_content_html: content, external_id: "source-a", canonical_url: `${nativeOrigin}/article/`, title: "Native article",
    to_created_at: created, to_updated_at: updatedAt, source_authors: [{ id: "alice", name: "Alice" }] };
}

function fixture(errorEvidence = "unknown") {
  const correlationId = randomUUID(), resourceId = randomUUID(), topicId = "9007199254740993";
  const acceptedRecord = toRecord(page("<p>Native original article</p>", created), connection(), { correlationId });
  const refusedRecord = toRecord(page("<p>Native current article</p>", edited), connection(),
    { correlationId, acceptedSourceRevision: acceptedRecord.source_revision });
  const acceptedRequest = { mutation_id: randomUUID(), bridge_record: acceptedRecord };
  const pending = { identity: payloadIdentity(refusedRecord), request: { mutation_id: randomUUID(), bridge_record: refusedRecord },
    native_evidence: { source_file: "article.md", source_sha256: hash("synthetic current authored bytes") } };
  const receiver = { route_id: "V4-02", http_status: 422, code: "invalid_field" };
  if (errorEvidence !== "unknown") receiver.error = decodedError("invalid_field", errorEvidence === "null" ? null : randomUUID());
  const operation = {
    externalId: refusedRecord.external_id, canonicalUrl: refusedRecord.canonical_url, pageKey: "article", correlationId,
    attempts: 2, outcome: "rejected", retryable: false, reconciliationRequired: true, lastAttemptAt: edited,
    resourceId, topicId, topicUrl: `${cmsConfig.serverUrl}/t/native/${topicId}`, acceptedSourceRevision: acceptedRecord.source_revision,
    lastToRequest: acceptedRequest, lastToIdentity: payloadIdentity(acceptedRecord),
    lastToResponse: { outcome: "created", reason: "record_created", resource_id: resourceId, topic_id: topicId,
      topic_url: `${cmsConfig.serverUrl}/t/native/${topicId}`, direction: "to_discourse", source_revision: acceptedRecord.source_revision,
      synchronized_at: created, core_fallback: false },
    toBinding: { connection_id: cmsConfig.connectionId, forum_origin: cmsConfig.serverUrl, native_origin: nativeOrigin },
    toNativeBinding: { site_root: path.resolve(component, ".tmp/pure-retry/site"), content_root: path.resolve(component, ".tmp/pure-retry/site/content"),
      source_file: "article.md", source_sha256: hash("synthetic accepted authored bytes"), source_revision: acceptedRecord.source_revision,
      scope_revision: "scope-1", policy_revision: "policy-1", lane: "default" },
    pendingToMutation: structuredClone(pending), requestedSourceRevision: refusedRecord.source_revision,
    requestedPreviousRevision: acceptedRecord.source_revision,
    rejectedToIntent: { schema_version: "db-hugo-to-rejection-2", outcome: "rejected", pending: structuredClone(pending), receiver },
  };
  const state = { schemaVersion: 1, adapterId: "hugo-discussion-bridge", wireIdentity: structuredClone(SOURCE_STATE_IDENTITY),
    candidate: structuredClone(SOURCE_CANDIDATE), operations: { [operation.externalId]: operation } };
  // Synthetic persisted lineage for pure state tests only. It is not a captured
  // local operator action, a native identity observation, or authority to Retry.
  const action = { schema_version: "db-hugo-local-source-retry-action-1", action_id: randomUUID(), command: "retry-source", page_key: operation.pageKey,
    state_path: path.resolve(component, ".tmp/pure-retry/private/state.json"), config_path: path.resolve(component, ".tmp/pure-retry/private/config.json"),
    refused_mutation_id: pending.request.mutation_id, invoked_at: invoked,
    operator: { username: "synthetic-test-principal", uid: -1, gid: -1, platform: "win32", pid: 4242,
      executable: path.resolve(component, ".tmp/pure-retry/synthetic-node.exe"), process_identity: { platform: "win32", pid: 4242, start: "638960000000000000" } } };
  validateOperationalState(state); validateLocalRetryRecord(action);
  return { state, operation, action };
}

function reload(state) {
  return decodeOperationalState(Buffer.from(JSON.stringify(state)));
}

function withdrawal(operation) {
  return { request: { mutation_id: randomUUID(), expected_source_revision: operation.acceptedSourceRevision, reason: "source_deleted" },
    native_evidence: { source_file: operation.toNativeBinding.source_file, source_sha256: null, reason: "source_deleted" } };
}

test("private witnessed refusal reload preserves UNKNOWN versus actually retained Error/null correlation", () => {
  for (const evidence of ["unknown", "null", "correlation"]) {
    const { state, operation } = fixture(evidence), before = structuredClone(operation.rejectedToIntent);
    const loaded = reload(state), current = loaded.operations[operation.externalId];
    equal(current.rejectedToIntent, before); assert.equal(rejectedToCode(current.rejectedToIntent), "invalid_field");
    const status = summarizeOperationalState(loaded).rejected_to_intents[0];
    assert.equal(status.decoded_error, evidence === "unknown" ? "UNKNOWN" : "RETAINED");
    assert.equal(status.raw_response, "UNKNOWN");
    if (evidence === "unknown") assert.equal(Object.hasOwn(current.rejectedToIntent.receiver, "error"), false);
    else assert.equal(current.rejectedToIntent.receiver.error.correlation_id, before.receiver.error.correlation_id);
    stageOperatorRetry(current, fixtureAction(current, before.pending.request.mutation_id));
    const saved = reload(loaded).operations[operation.externalId].rejectedToHistory[0];
    equal(saved, before);
    assert.equal(Object.hasOwn(saved.receiver, "error"), evidence !== "unknown");
  }
});

function fixtureAction(operation, refusedMutationId) {
  const action = fixture().action;
  action.page_key = operation.pageKey; action.refused_mutation_id = refusedMutationId;
  return action;
}

test("staging links one fresh mutation to the immutable refusal with unchanged source/predecessor/body/dates", () => {
  const { state, operation, action } = fixture("correlation"), refusal = structuredClone(operation.rejectedToIntent);
  const accepted = { request: structuredClone(operation.lastToRequest), response: structuredClone(operation.lastToResponse), revision: operation.acceptedSourceRevision };
  const entry = stageOperatorRetry(operation, action), replacementId = operation.pendingToMutation.request.mutation_id;
  assert.notEqual(replacementId, refusal.pending.request.mutation_id);
  equal(operation.pendingToMutation.request.bridge_record, refusal.pending.request.bridge_record);
  equal(operation.pendingToMutation.native_evidence, refusal.pending.native_evidence);
  assert.equal(operation.pendingToMutation.identity, refusal.pending.identity);
  assert.equal(operation.pendingToMutation.request.bridge_record.source_revision, refusal.pending.request.bridge_record.source_revision);
  assert.equal(operation.requestedPreviousRevision, refusal.pending.request.bridge_record.expected_source_revision);
  assert.equal(operation.pendingToMutation.request.bridge_record.source_created_at, created);
  assert.equal(operation.pendingToMutation.request.bridge_record.source_updated_at, edited);
  equal(operation.rejectedToHistory, [refusal]); equal(operation.lastToRequest, accepted.request); equal(operation.lastToResponse, accepted.response);
  assert.equal(operation.acceptedSourceRevision, accepted.revision); assert.equal(Object.hasOwn(operation, "rejectedToIntent"), false);
  assert.equal(entry.schema_version, "db-hugo-to-operator-retry-1"); equal(entry.action, action);
  assert.equal(entry.refused_mutation_id, refusal.pending.request.mutation_id); equal(entry.replacement_pending, operation.pendingToMutation);
  assert.equal(operation.outcome, "pending"); assert.equal(operation.retryable, false); assert.equal(operation.attempts, 3);
  const loaded = reload(state), current = loaded.operations[operation.externalId], snapshot = nativeSemanticJson(current);
  const existing = stageOperatorRetry(current, structuredClone(action));
  equal(existing, entry); assert.equal(nativeSemanticJson(current), snapshot);
  assert.equal(current.pendingToMutation.request.mutation_id, replacementId);
  assert.equal(current.toOperatorRetries.length, 1); assert.equal(current.rejectedToHistory.length, 1);
});

test("staging copies supplied lineage/evidence and retains the original refused native evidence", () => {
  const { state, operation, action } = fixture(), refusal = structuredClone(operation.rejectedToIntent);
  const evidence = { source_file: "article.md", source_sha256: hash("synthetic recaptured authored bytes") }, expected = structuredClone(evidence);
  const entry = stageOperatorRetry(operation, action, evidence);
  const savedAction = structuredClone(entry.action);
  action.operator.username = "changed caller object"; evidence.source_sha256 = hash("changed caller object");
  equal(entry.action, savedAction); equal(entry.replacement_pending.native_evidence, expected);
  equal(operation.pendingToMutation.native_evidence, expected); equal(operation.rejectedToHistory[0], refusal);
  reload(state);
});

test("synthetic persisted action shape is not a live issued operator action", () => {
  const { action, operation } = fixture();
  equal(validateLocalRetryRecord(action), action);
  assert.throws(() => assertLocalRetryAction(action, { statePath: action.state_path, pageKey: operation.pageKey, refusedMutationId: action.refused_mutation_id }));
});

test("staging refuses stale action, wrong refusal and held operation states without changing the operation", async (t) => {
  const cases = [
    ["stale refused mutation", ({ action }) => { action.refused_mutation_id = randomUUID(); }],
    ["different page", ({ action }) => { action.page_key = "other-page"; }],
    ["preservation error is not invalid-field Retry", ({ operation }) => {
      operation.rejectedToIntent.schema_version = "db-hugo-to-rejection-1";
      operation.rejectedToIntent.receiver = { route_id: "V4-02", http_status: 422, error: decodedError("content_preservation_unavailable") };
    }],
    ["uncertain mutation", ({ operation }) => { delete operation.rejectedToIntent; operation.outcome = "reconciliation_required"; }],
    ["pending withdrawal", ({ operation }) => {
      operation.pendingToWithdrawal = { phase: "intent", ...withdrawal(operation), resource_id: operation.resourceId, binding: structuredClone(operation.toBinding) };
    }],
    ["withdrawn binding", ({ operation }) => {
      operation.toWithdrawn = { ...withdrawal(operation), record: { resource_id: operation.resourceId, direction: "to_discourse", state: "withdrawn",
        topic_id: operation.topicId, topic_url: operation.topicUrl, external_id: operation.externalId, canonical_url: operation.canonicalUrl,
        source_revision: operation.acceptedSourceRevision, source_created_at: created, source_updated_at: created, synchronized_at: created, mapping_id: null } };
    }],
    ["pending source move", ({ operation }) => {
      const mutationId = randomUUID(), record = structuredClone(operation.lastToRequest.bridge_record);
      const authored = Buffer.from("synthetic accepted authored bytes"), complete = Buffer.from(record.content_html);
      const sourceRevision = hash(authored), contentSha = hash(complete);
      const descriptor = { schema_version: "db-hugo-source-capture-1", source_id: operation.externalId, source_revision: sourceRevision,
        source_article_url: record.canonical_url, content_sha256: contentSha, content_bytes: complete.length,
        source_snapshot: `source-snapshots/${hash(operation.externalId)}/${hash(sourceRevision)}-${contentSha}.html` };
      const capture = { ...descriptor, capture_descriptor: `source-captures/${hash(nativeSemanticJson(descriptor))}.json` };
      const blob = (name, bytes) => ({ path: `source-moves/${mutationId}/${name}`, bytes: bytes.length, sha256: hash(bytes) });
      operation.sourceMoves = { pending: { schema_version: "db-hugo-to-source-move-1", phase: "prepare_intent",
        prepare: { request: { mutation_id: mutationId, expected_source_revision: record.source_revision, old_url: record.canonical_url,
          new_url: `${nativeOrigin}/moved/`, external_id: operation.externalId } },
        before: { record, current: { resource_id: operation.resourceId, direction: "to_discourse", state: "active", topic_id: operation.topicId,
          topic_url: operation.topicUrl, external_id: operation.externalId, canonical_url: record.canonical_url, source_revision: record.source_revision,
          source_created_at: record.source_created_at, source_updated_at: record.source_updated_at,
          synchronized_at: operation.lastToResponse.synchronized_at, mapping_id: null },
        capture, native_binding: structuredClone(operation.toNativeBinding), source_file: operation.toNativeBinding.source_file,
        native_rendered: blob("native-before.html", complete), file: blob("authored-before.bin", authored), public_data: null },
        after_file: blob("authored-after.bin", Buffer.from("synthetic authored bytes after URL-only move")),
        prepared_article: blob("complete-prepared.html", complete), binding: hash("synthetic pinned move configuration"),
        scope: { connection_id: cmsConfig.connectionId, scope_revision: operation.toNativeBinding.scope_revision,
          publication_lane: operation.toNativeBinding.lane, destination_origin: nativeOrigin, forum_origin: cmsConfig.serverUrl },
        inputs: [{ path: path.resolve(component, ".tmp/pure-retry/site/hugo.toml"), sha256: hash("synthetic native configuration") }],
        new_revision: "synthetic-source-move-edition", commands: [] }, history: [] };
    }],
  ];
  for (const [name, change] of cases) await t.test(name, () => {
    const data = fixture(); change(data); validateOperationalState(data.state);
    const before = nativeSemanticJson(data.operation);
    assert.throws(() => stageOperatorRetry(data.operation, data.action));
    assert.equal(nativeSemanticJson(data.operation), before);
  });
  await t.test("uncertain tree differs from retained refusal", () => {
    const { operation, action } = fixture(); operation.pendingToMutation.request.mutation_id = randomUUID();
    const before = nativeSemanticJson(operation);
    assert.throws(() => stageOperatorRetry(operation, action)); assert.equal(nativeSemanticJson(operation), before);
  });
  await t.test("recaptured native file differs", () => {
    const { operation, action } = fixture(), before = nativeSemanticJson(operation);
    assert.throws(() => stageOperatorRetry(operation, action, { source_file: "foreign.md", source_sha256: hash("foreign") }));
    assert.equal(nativeSemanticJson(operation), before);
  });
});

test("reload rejects corrupted or duplicate Retry linkage and fabricated missing Error fields", async (t) => {
  const changes = [
    ["duplicate link", (operation) => operation.toOperatorRetries.push(structuredClone(operation.toOperatorRetries[0]))],
    ["unknown refused UUID", (operation) => { operation.toOperatorRetries[0].refused_mutation_id = randomUUID(); }],
    ["replacement reuses refused UUID", (operation) => { const link = operation.toOperatorRetries[0]; link.replacement_pending.request.mutation_id = link.refused_mutation_id; }],
    ["changed linked title", (operation) => { operation.toOperatorRetries[0].replacement_pending.request.bridge_record.title = "Changed title"; }],
    ["changed predecessor", (operation) => { operation.toOperatorRetries[0].replacement_pending.request.bridge_record.expected_source_revision = "different-predecessor"; }],
    ["action/refusal mismatch", (operation) => { operation.toOperatorRetries[0].action.refused_mutation_id = randomUUID(); }],
    ["different replacement native file", (operation) => { operation.toOperatorRetries[0].replacement_pending.native_evidence.source_file = "foreign.md"; }],
    ["unknown Error replaced with null", (operation) => { operation.rejectedToHistory[0].receiver.error = null; }],
    ["retained Error missing correlation", (operation) => { operation.rejectedToHistory[0].receiver.error = decodedError(); delete operation.rejectedToHistory[0].receiver.error.correlation_id; }],
  ];
  for (const [name, change] of changes) await t.test(name, () => {
    const { state, operation, action } = fixture(); stageOperatorRetry(operation, action); change(operation);
    assert.throws(() => reload(state));
  });
});
