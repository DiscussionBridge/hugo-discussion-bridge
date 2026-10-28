import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { cmsConfig, connection, json, nativeOrigin } from "../test-support/cms-fixture.mjs";

const component = process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT
  ? path.resolve(process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT)
  : fileURLToPath(new URL("..", import.meta.url));
const { createCmsClient, CmsReceiverRejection, CmsTransportError } = await import(pathToFileURL(path.join(component, "src/cms-client.mjs")));
const { toRecord } = await import(pathToFileURL(path.join(component, "src/to-source.mjs")));
const { HUGO_TO_SOURCE_PROFILE } = await import(pathToFileURL(path.join(component, "src/to-source-proof.mjs")));
const { semanticIdentity, validateCms, validateCmsRoute } = await import(pathToFileURL(path.join(component, "src/protocol-v4/cms-runtime.mjs")));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const equal = (actual, expected) => assert.equal(semanticIdentity(actual), semanticIdentity(expected));

function refusal(code = "invalid_field", correlationId = randomUUID()) {
  return { outcome: "rejected", code, retryable: false, retry_after_seconds: null, correlation_id: correlationId, core_fallback: false };
}

function resolveParameters() {
  const bridgeRecord = toRecord({ full_content_html: "<p>Native article</p>", external_id: "source-a",
    canonical_url: `${nativeOrigin}/old/`, title: "Native", to_created_at: null, to_updated_at: null, source_authors: [] },
  connection(), { correlationId: randomUUID() });
  return { body: { mutation_id: randomUUID(), bridge_record: bridgeRecord } };
}

function finalizeParameters() {
  // Same typed finalize/challenge shape as the existing source-move fixture.
  // These digest values are client test inputs, not a native ownership proof.
  const previous = resolveParameters().body.bridge_record;
  const moveId = randomUUID(), sourceRevision = "actual-move-edition";
  const verification = {
    url: `${nativeOrigin}/new/`, external_id: previous.external_id, source_revision: sourceRevision,
    source_content_sha256: previous.source_content_sha256,
    native_ownership_receipt_sha256: hash("source-move client ownership fixture"),
    native_publication_sha256: hash("source-move client publication fixture"),
    verification_profile: HUGO_TO_SOURCE_PROFILE, checked_at: new Date().toISOString(),
  };
  const body = { mutation_id: randomUUID(), move_id: moveId, proof_nonce: randomBytes(32).toString("base64url"),
    expected_source_revision: previous.source_revision, verification, new_source_revision: sourceRevision, source_updated_at: null };
  validateCms("SourceUrlMoveFinalize", body);
  return { body, path: { resource_id: randomUUID(), move_id: moveId } };
}

function clientRequest(fetchImpl, { route = "V4-02", timeoutMs } = {}) {
  const parameters = route === "V4-29" ? finalizeParameters() : resolveParameters();
  validateCmsRoute(route, { body: parameters.body, path: parameters.path ?? {}, query: {} });
  const client = createCmsClient({ ...cmsConfig, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, { fetchImpl });
  return () => client.request(route, parameters);
}

function isRetainedRefusal(route, envelope) {
  return (error) => {
    assert.ok(error instanceof CmsReceiverRejection);
    assert.equal(error.code, envelope.code);
    equal(error.rejection, { route_id: route, http_status: 422, error: envelope });
    assert.equal(error.rejection.error.correlation_id, envelope.correlation_id);
    return true;
  };
}

function isNotDefinitive(error) {
  assert.equal(error instanceof CmsReceiverRejection, false);
  return true;
}

test("To02 typed invalid_field/422 retains the actual decoded Error and correlation value", async () => {
  for (const correlationId of [randomUUID(), null]) {
    const envelope = refusal("invalid_field", correlationId);
    validateCms("Error", envelope);
    let calls = 0;
    const request = clientRequest(async () => { calls++; return json(envelope, 422); });
    await assert.rejects(request(), isRetainedRefusal("V4-02", envelope));
    assert.equal(calls, 1);
  }
});

test("To02 malformed invalid_field envelopes are not definitive receiver refusals", async (t) => {
  const envelope = refusal();
  const missingCorrelation = { ...envelope }; delete missingCorrelation.correlation_id;
  for (const [name, value] of [
    ["unknown field", { ...envelope, detail: "not a declared field" }],
    ["missing correlation", missingCorrelation],
    ["wrong retryable", { ...envelope, retryable: true }],
    ["wrong retry-after", { ...envelope, retry_after_seconds: 30 }],
  ]) {
    await t.test(name, async () => {
      const request = clientRequest(async () => json(value, 422));
      await assert.rejects(request(), isNotDefinitive);
    });
  }
  await t.test("duplicate JSON members", async () => {
    const request = clientRequest(async () => new Response('{"outcome":"rejected","outcome":"rejected"}',
      { status: 422, headers: { "content-type": "application/json" } }));
    await assert.rejects(request(), isNotDefinitive);
  });
});

test("To02 HTML, wrong-status and untrusted-origin responses are not definitive refusals", async (t) => {
  await t.test("HTML", async () => {
    const request = clientRequest(async () => new Response("<html>invalid_field</html>",
      { status: 422, headers: { "content-type": "text/html" } }));
    await assert.rejects(request(), isNotDefinitive);
  });
  for (const status of [200, 409]) {
    await t.test(`wrong HTTP ${status}`, async () => {
      const request = clientRequest(async () => json(refusal(), status));
      await assert.rejects(request(), isNotDefinitive);
    });
  }
  await t.test("different response origin", async () => {
    const request = clientRequest(async () => {
      const response = json(refusal(), 422);
      Object.defineProperty(response, "url", { value: "https://other.example/refusal.json" });
      return response;
    });
    await assert.rejects(request(), (error) => {
      isNotDefinitive(error); assert.equal(error.code, "scope_denied"); return true;
    });
  });
});

test("To02 transport failure and actual request deadline remain uncertain", async (t) => {
  const uncertain = (error) => {
    isNotDefinitive(error); assert.ok(error instanceof CmsTransportError);
    assert.equal(error.code, "transport_timeout"); return true;
  };
  await t.test("lost response", async () => {
    const request = clientRequest(async () => { throw new Error("Isolated lost response"); });
    await assert.rejects(request(), uncertain);
  });
  await t.test("deadline", async () => {
    const request = clientRequest((_address, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Isolated request aborted")), { once: true });
    }), { timeoutMs: 1 });
    await assert.rejects(request(), uncertain);
  });
});

test("To29 typed invalid_field/422 remains the existing generic error after a valid request", async () => {
  const envelope = refusal(); let calls = 0;
  const request = clientRequest(async () => { calls++; return json(envelope, 422); }, { route: "V4-29" });
  await assert.rejects(request(), (error) => {
    isNotDefinitive(error); assert.ok(error instanceof CmsTransportError);
    assert.equal(error.code, "invalid_field"); return true;
  });
  assert.equal(calls, 1);
});

test("To02 and To29 preservation refusals retain their existing definitive classification", async () => {
  for (const route of ["V4-02", "V4-29"]) {
    const envelope = refusal("content_preservation_unavailable"); let calls = 0;
    const request = clientRequest(async () => { calls++; return json(envelope, 422); }, { route });
    await assert.rejects(request(), isRetainedRefusal(route, envelope));
    assert.equal(calls, 1);
  }
});
