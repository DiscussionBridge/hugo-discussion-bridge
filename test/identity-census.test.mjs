import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepare, preflight } from "../src/adapter.mjs";

const config = { serverUrl: "https://bridge.example.com", connectionId: "dbc_0123456789abcdef01234567", connectionSecret: "s".repeat(48), nativeShortcode: "discussionbridge", lane: "hugo-test" };
const page = (key, externalId) => ({ key, mode: "to_discourse", canonical_url: `https://hugo.example.com/${key}/`, title: key, content_html: "<p>Native source.</p>", ...(externalId ? { external_id: externalId } : {}) });
const operation = (key, externalId, fields = {}) => ({ pageKey: key, externalId, canonicalUrl: `https://hugo.example.com/${key}/`, correlationId: "11111111-1111-4111-8111-111111111111", attempts: 1, outcome: "resolved", retryable: false, reconciliationRequired: false, lastAttemptAt: "2026-10-12T00:00:00Z", ...fields });
const state = (operations) => ({ schemaVersion: 1, adapterId: "hugo-discussion-bridge", operations });

async function fixture(pages, stored = state({})) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "third-hugo-census-"));
  const manifestPath = path.join(dir, "manifest.json"), outputPath = path.join(dir, "output.json"), statePath = path.join(dir, "state.json");
  await writeFile(manifestPath, JSON.stringify({ site_origin: "https://hugo.example.com", pages }));
  await writeFile(statePath, JSON.stringify(stored));
  return { manifestPath, outputPath, statePath, config };
}

test("duplicate explicit identities reject before any earlier Simple or To request", async () => {
  const pages = [{ key: "a-simple", mode: "simple", canonical_url: "https://hugo.example.com/a-simple/", title: "Simple", topic_id: 21 }, page("b", "same"), page("z", "same")];
  assert.throws(() => preflight({ site_origin: "https://hugo.example.com", pages }, config), /duplicate external identity/);
  const inputs = await fixture(pages); let calls = 0;
  await assert.rejects(() => prepare({ ...inputs, fetchImpl: async () => { calls++; throw new Error("unexpected request"); } }), /duplicate external identity/);
  assert.equal(calls, 0);
  await assert.rejects(readFile(inputs.outputPath), { code: "ENOENT" });
});

test("later durable ambiguity rejects the entire manifest without changing state", async () => {
  const stored = state({ first: operation("z", "first"), second: operation("z", "second") });
  const inputs = await fixture([page("a"), page("z")], stored); let calls = 0;
  const before = await readFile(inputs.statePath);
  await assert.rejects(() => prepare({ ...inputs, fetchImpl: async () => { calls++; throw new Error("unexpected request"); } }), /ambiguous immutable identity/);
  assert.equal(calls, 0); assert.deepEqual(await readFile(inputs.statePath), before);
});

test("later canonical drift and duplicated native ownership reject before dispatch", async () => {
  for (const stored of [
    state({ bound: operation("z", "bound", { canonicalUrl: "https://hugo.example.com/old-z/" }) }),
    state({ first: operation("a", "first", { resourceId: "22222222-2222-4222-8222-222222222222", topicId: 21 }), second: operation("z", "second", { resourceId: "33333333-3333-4333-8333-333333333333", topicId: 21 }) }),
  ]) {
    const inputs = await fixture([page("a"), page("z")], stored); let calls = 0;
    await assert.rejects(() => prepare({ ...inputs, fetchImpl: async () => { calls++; throw new Error("unexpected request"); } }), /identity collision|ambiguous native resource\/topic identity/);
    assert.equal(calls, 0);
  }
});

test("resolved durable IDs remain authoritative and exact retries retain their correlation", async () => {
  const stored = state({ custom: operation("a", "custom", { resourceId: "22222222-2222-4222-8222-222222222222", topicId: 21 }) });
  const derived = `hugo-page:${createHash("sha256").update("https://hugo.example.com/a/").digest("hex")}`;
  const inputs = await fixture([page("a"), page("z", derived)], stored);
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body).bridge_record; requests.push(body);
    const existing = body.external_id === "custom";
    return new Response(JSON.stringify({ outcome: existing ? "resolved" : "created", core_fallback: false, direction: "to_discourse", resource_id: existing ? "22222222-2222-4222-8222-222222222222" : "33333333-3333-4333-8333-333333333333", topic_id: existing ? 21 : 22, topic_url: `https://bridge.example.com/t/native/${existing ? 21 : 22}` }), { status: existing ? 200 : 201, headers: { "content-type": "application/json" } });
  };
  await prepare({ ...inputs, fetchImpl });
  await prepare({ ...inputs, fetchImpl });
  assert.deepEqual(requests.map((entry) => entry.external_id), ["custom", derived, "custom", derived]);
  assert.equal(requests[0].correlation_id, requests[2].correlation_id);
  assert.equal(requests[1].correlation_id, requests[3].correlation_id);
});
