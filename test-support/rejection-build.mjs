import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cmsConfig, connection, json } from "./cms-fixture.mjs";

export async function rejectionBuild(root, component, retry = null) {
  const { prepare, retrySource } = await import(pathToFileURL(path.join(component, "src/adapter.mjs")));
  const { semanticIdentity, validateCms } = await import(pathToFileURL(path.join(component, "src/protocol-v4/cms-runtime.mjs")));
  const serverPath = path.join(root, "server.json");
  const load = async () => JSON.parse(await readFile(serverPath, "utf8"));
  const store = async (value) => writeFile(serverPath, JSON.stringify(value));
  const fetchImpl = async (url, options) => {
    const route = new URL(url).pathname.replace("/discussion-bridge/v4/", "");
    const body = options.body === undefined ? null : JSON.parse(options.body);
    const server = await load(); server.requests.push({ route, body });
    if (route === "connection.json") {
      const value = connection(); value.directions = ["to_discourse"]; value.policy.enabled = false;
      await store(server); return json(value);
    }
    if (route === "bridge-records.json") { await store(server); return json({ items: Object.values(server.records), next_cursor: null }); }
    const detail = /^bridge-records\/([^/]+)\.json$/u.exec(route);
    if (detail && body === null) { await store(server); return json(server.records[detail[1]]); }
    if (route === "bridge-records/resolve.json") {
      validateCms("ToResolve", body); const input = body.bridge_record;
      if (server.captureDispatchState) {
        const state = JSON.parse(await readFile(path.join(root, "private/source.json"), "utf8"));
        server.dispatchStates ??= []; server.dispatchStates.push(structuredClone(state.operations[input.external_id]));
      }
      if (server.receipts[body.mutation_id]) {
        const prior = server.receipts[body.mutation_id]; assert.equal(semanticIdentity(prior.body), semanticIdentity(body));
        await store(server); return json(prior.value, prior.status);
      }
      const previous = Object.values(server.records).find((record) => record.external_id === input.external_id);
      assert.equal(input.expected_source_revision, previous?.source_revision ?? null);
      if (server.reject.includes(input.external_id)) {
        await store(server); return json({ outcome: "rejected", code: server.rejectionCode ?? "content_preservation_unavailable", retryable: false,
          retry_after_seconds: null, correlation_id: server.rejectionCorrelation ?? null, core_fallback: false }, 422);
      }
      const topicId = previous?.topic_id ?? String(9007199254740993n + BigInt(Object.keys(server.records).length));
      const record = { resource_id: previous?.resource_id ?? randomUUID(), direction: "to_discourse", state: "active", topic_id: topicId,
        topic_url: `${cmsConfig.serverUrl}/t/source/${topicId}`, external_id: input.external_id, canonical_url: input.canonical_url,
        source_revision: input.source_revision, source_created_at: input.source_created_at, source_updated_at: input.source_updated_at,
        synchronized_at: new Date().toISOString(), mapping_id: null };
      const value = { outcome: previous ? "updated" : "created", reason: previous ? "source_revision_updated" : "record_created",
        resource_id: record.resource_id, topic_id: record.topic_id, topic_url: record.topic_url, direction: "to_discourse",
        source_revision: input.source_revision, synchronized_at: record.synchronized_at, core_fallback: false };
      validateCms("Record", record); validateCms("ResolveResult", value);
      server.records[record.resource_id] = record; server.receipts[body.mutation_id] = { body, value, status: previous ? 200 : 201 };
      const uncertain = server.uncertain === input.external_id; server.uncertain = null;
      await store(server); if (uncertain) throw new Error("Fixture lost committed response");
      return json(value, previous ? 200 : 201);
    }
    const withdrawal = /^bridge-records\/([^/]+)\/withdraw\.json$/u.exec(route);
    if (withdrawal) {
      validateCms("WithdrawInput", body); const record = server.records[withdrawal[1]];
      assert.equal(record.source_revision, body.expected_source_revision); record.state = "withdrawn";
      await store(server); return json(record);
    }
    throw new Error(`Unexpected isolated route ${route}`);
  };
  const request = { manifestPath: path.join(root, "manifest.json"), outputPath: path.join(root, "site/data/discussionbridge.json"),
    statePath: path.join(root, "private/source.json"), config: { ...cmsConfig, toNative: { siteRoot: path.join(root, "site") } }, fetchImpl,
    // A captured-native-input fixture, not a Hugo build or deployed proof. The
    // actual publisher still checks authored file hashes and its two OS locks.
    captureNative: async ({ manifestPath, state, config, save, assertFence }) => {
      await assertFence(); state.nativeRoots ??= { site_root: config.toNative.siteRoot, content_root: path.join(config.toNative.siteRoot, "content") };
      await save(); return JSON.parse(await readFile(manifestPath, "utf8"));
    } };
  if (retry !== null) {
    const { captureLocalRetryAction } = await import(pathToFileURL(path.join(component, "src/to-retry-action.mjs")));
    const localAction = await captureLocalRetryAction({ configPath: path.join(root, "configuration.json"), statePath: request.statePath,
      pageKey: retry.pageKey, refusedMutationId: retry.refusedMutationId });
    return retrySource({ ...request, ...retry, localAction });
  }
  return prepare(request);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { const result = await rejectionBuild(process.argv[2], process.argv[3], process.argv[4] === undefined ? null : JSON.parse(process.argv[4])); process.stdout.write(JSON.stringify(result)); }
  catch (error) { process.stderr.write(JSON.stringify({ code: error.code, message: error.message, native_helper: error.native_helper, native_process_probe: error.native_process_probe })); process.exitCode = 1; }
}
