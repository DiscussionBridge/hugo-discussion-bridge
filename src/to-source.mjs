import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { createCmsClient, CmsReceiverRejection } from "./cms-client.mjs";
import { assertCmsSafePath, createCmsPrivateDirectory } from "./native-lock.mjs";
import { runCmsNativeCommand } from "./native-command.mjs";
import { excerptArticle } from "./native-content.mjs";
import { captureToLifecycle } from "./to-lifecycle-capture.mjs";
import { parseCmsJson, semanticIdentity, validateCms, generatedReadMore, measureToFullEnvelope, createGeneratedExcerpt, validateGeneratedEnvelope } from "./protocol-v4/cms-runtime.mjs";
import { PRODUCT_VERSION } from "./version.mjs";
import { currentToSourceRecord, currentToSourceObservation, retireToSourceCache } from "./to-source-move-state.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const attention = (code) => Object.assign(new Error(`Hugo To V4 ${code}; source reconciliation requires attention.`), { code });
const contains = (root, file) => { const relative = path.relative(root, file); return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
export async function captureToNative({ manifestPath, statePath, config, state, save, assertFence }) {
  const native = config.toNative;
  if (!native || typeof native !== "object" || Array.isArray(native) || Object.keys(native).some((key) => !["siteRoot", "contentRoot", "command", "lifecycleCommand", "sourceMoves"].includes(key))) throw attention("invalid_field");
  if (!native || !path.isAbsolute(native.siteRoot) || native.contentRoot !== undefined && !path.isAbsolute(native.contentRoot)
      || contains(path.resolve(native.siteRoot), path.resolve(statePath)) || /(?:^|[\\/])(?:public|static|assets|data)(?:[\\/]|$)/iu.test(path.resolve(statePath))) throw attention("native_ownership_conflict");
  if (!["win32", "linux"].includes(process.platform)) throw attention("native_restore_required");
  const roots = { site_root: path.resolve(native.siteRoot), content_root: path.resolve(native.contentRoot ?? path.join(native.siteRoot, "content")) };
  if (state.nativeRoots && semanticIdentity(state.nativeRoots) !== semanticIdentity(roots)) throw attention("native_ownership_conflict");
  if (!state.nativeRoots) { state.nativeRoots = roots; await save(); }
  for (const capture of [state.toCapture, state.toLifecycleCapture]) if (capture && capture.value.phase !== "completed") throw attention("native_restore_required");
  const transactionId = randomUUID(), siteRoot = path.resolve(native.siteRoot);
  const capturedRoot = path.join(path.dirname(path.resolve(statePath)), ".to-captures", transactionId);
  await createCmsPrivateDirectory(capturedRoot);
  for (const target of [siteRoot, statePath, manifestPath]) await assertCmsSafePath(target);
  await runCmsNativeCommand({ kind: "build", transactionId, command: native.command,
    values: { transaction_id: transactionId, site_root: siteRoot, public_root: capturedRoot, receipt_path: `${statePath}.capture-receipt.json` },
    continuation: { async nativeRecord(name, value) {
      if (value === undefined) return state.toCapture?.name === name ? state.toCapture.value : null;
      state.toCapture = { name, value }; await save();
    } }, assertFence });
  await assertFence();
  const manifest = parseCmsJson(await readFile(path.join(capturedRoot, path.basename(manifestPath))), { maximumBytes: Number.MAX_SAFE_INTEGER });
  manifest.private_lifecycle = await captureToLifecycle({ statePath, config, state, save, assertFence });
  return manifest;
}
export async function assertCurrentNativeTo(page, config) {
  const native = config.toNative, relative = page.native_source_file;
  if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split(/[\\/]/u).some((part) => !part || [".", ".."].includes(part))) throw attention("native_ownership_conflict");
  validateCms("Sha256", page.native_source_sha256);
  const file = path.join(native.contentRoot ?? path.join(native.siteRoot, "content"), relative);
  await assertCmsSafePath(file); const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || digest(await readFile(file)) !== page.native_source_sha256) throw attention("native_local_edit_conflict");
}
export async function authorizeTo(config, origin, fetchImpl) {
  const client = createCmsClient(config, { fetchImpl });
  const { value: connection } = await client.request("V4-01");
  if (connection.profile !== "hugo" || connection.connection_id !== config.connectionId || new URL(connection.destination_origin).origin !== origin
      || !connection.directions.includes("to_discourse") || config.lane !== undefined && config.lane !== connection.publication_lane) throw attention("scope_denied");
  return { client, connection };
}
export async function toInventory(client) {
  const records = [], seen = new Set(); let cursor;
  for (let page = 0; page < 100; page++) {
    const { value } = await client.request("V4-03", { query: cursor === undefined ? {} : { cursor } });
    records.push(...value.items.filter((record) => record.direction === "to_discourse"));
    if (value.next_cursor === null) return records;
    if (seen.has(value.next_cursor)) throw attention("cursor_invalid"); seen.add(value.next_cursor); cursor = value.next_cursor;
  }
  throw attention("metadata_unavailable");
}
function nativeSourceMetadata(page, connection) {
  const bytes = Buffer.from(page.full_content_html);
  return { direction: "to_discourse", external_id: page.external_id, canonical_url: page.canonical_url, title: page.title, published: true,
    source_created_at: page.to_created_at, source_updated_at: page.to_updated_at, source_content_sha256: digest(bytes), source_content_bytes: bytes.length,
    source_authors: page.source_authors, ...(page.primary_source_author_id === undefined ? {} : { primary_source_author_id: page.primary_source_author_id }),
    ...(page.existing_topic_id === undefined ? {} : { existing_topic_id: page.existing_topic_id }), lane: connection.publication_lane, visibility: "unlisted" };
}
export function toRecord(page, connection, operation) {
  const complete = page.full_content_html, record = { ...nativeSourceMetadata(page, connection), content_html: complete,
    source_revision: randomUUID(), expected_source_revision: operation.acceptedSourceRevision ?? null, representation: { kind: "full" },
    adapter_id: "hugo-discussion-bridge", adapter_version: PRODUCT_VERSION, correlation_id: operation.correlationId };
  const fullBytes = measureToFullEnvelope(record, complete);
  if (Buffer.byteLength(complete) > 49152 || fullBytes > 65536) {
    let budget = 49152 - Buffer.byteLength(generatedReadMore(record.canonical_url));
    for (;;) {
      const article = excerptArticle(complete, budget); if (article === "<p></p>") throw attention("body_too_large");
      try {
        const projected = createGeneratedExcerpt(record, complete, article);
        if (Buffer.byteLength(JSON.stringify({ mutation_id: "11111111-1111-4111-8111-111111111111", bridge_record: projected })) > 65536) throw attention("body_too_large");
        return projected;
      } catch (error) { if (error.code !== "body_too_large" || budget <= 16) throw error; budget = Math.floor(budget * .85); }
    }
  }
  if (Buffer.byteLength(JSON.stringify({ mutation_id: "11111111-1111-4111-8111-111111111111", bridge_record: record })) > 65536) {
    for (const field of ["adapter_id", "adapter_version", "correlation_id"]) delete record[field];
  }
  validateGeneratedEnvelope(record); return record;
}
export function payloadIdentity(record) {
  const value = structuredClone(record);
  for (const key of ["source_revision", "expected_source_revision", "adapter_id", "adapter_version", "correlation_id"]) delete value[key];
  return digest(semanticIdentity(value));
}
function sourceMeaning(record) {
  const value = structuredClone(record);
  for (const key of ["source_revision", "expected_source_revision", "content_html", "representation", "adapter_id", "adapter_version", "correlation_id"]) delete value[key];
  value.visibility ??= "unlisted"; value.source_authors ??= []; return digest(semanticIdentity(value));
}
function checkRecord(record, page, operation) {
  if (record.direction !== "to_discourse" || record.state !== "active" || record.external_id !== page.external_id || record.canonical_url !== page.canonical_url
      || operation.resourceId && record.resource_id !== operation.resourceId || operation.topicId && record.topic_id !== operation.topicId) throw attention("native_ownership_conflict");
}
export async function assertFreshToRetryBinding({ page, config, operation, client, inventory, assertFence }) {
  await assertFence(); await assertCurrentNativeTo(page, config);
  const binding = { connection_id: config.connectionId, forum_origin: client.origin, native_origin: new URL(page.canonical_url).origin };
  if (semanticIdentity(operation.toBinding) !== semanticIdentity(binding)
      || operation.rejectedToIntent.pending.native_evidence.source_file !== page.native_source_file) throw attention("scope_denied");
  const candidates = inventory.filter((record) => record.external_id === page.external_id || record.canonical_url === page.canonical_url);
  if (candidates.length > 1) throw attention("identity_conflict");
  if (operation.acceptedSourceRevision !== undefined) {
    if (!operation.resourceId || !operation.lastToRequest || !operation.lastToResponse) throw attention("native_ownership_conflict");
    const existing = (await client.request("V4-04", { path: { resource_id: operation.resourceId } })).value;
    checkRecord(existing, page, operation);
    if (existing.source_revision !== operation.acceptedSourceRevision) throw attention("revision_conflict");
  } else if (operation.resourceId || candidates.length) throw attention("native_ownership_conflict");
}

export function assertUnchangedToRetrySnapshot(page, connection, pending) {
  if (page.mode !== "to_discourse" || page.published !== true || page.native_publication === true
      || page.preparation_losses?.length || pending.native_evidence.source_file !== page.native_source_file
      || sourceMeaning(pending.request.bridge_record) !== sourceMeaning(nativeSourceMetadata(page, connection))) throw attention("native_local_edit_conflict");
  // The complete prepared hash/count and all ordinary source metadata above
  // match. Retain its exact historical delivered representation and source
  // revision; new converter/configuration bytes do not replace the request body.
}
export async function reconcileRejectedToIntent({ page, config, operation, client, connection, inventory, save, assertFence }) {
  const rejected = operation.rejectedToIntent;
  if (rejected === undefined) return true;
  const previous = rejected.pending.request.bridge_record, current = nativeSourceMetadata(page, connection);
  // Rebuilding or changing a receiver/package version does not demonstrate a
  // repair of this identical rejected snapshot. Ordinary native title, author
  // and actual-date edits also form a new snapshot, without asserting that the
  // receiver was repaired. Diagnostic/representation-only changes do not.
  if (sourceMeaning(previous) === sourceMeaning(current)) return false;
  await assertFreshToRetryBinding({ page, config, operation, client, inventory, assertFence });
  operation.rejectedToHistory ??= [];
  operation.rejectedToHistory.push(structuredClone(rejected));
  delete operation.rejectedToIntent; delete operation.pendingToMutation;
  operation.outcome = "reconciliation_required"; operation.retryable = false; operation.reconciliationRequired = true;
  await save(); return true;
}
export async function resolveTo({ page, config, operation, client, connection, inventory, save, assertFence }) {
  if (operation.rejectedToIntent !== undefined) throw attention(operation.rejectedToIntent.receiver.error?.code ?? operation.rejectedToIntent.receiver.code);
  await assertFence(); await assertCurrentNativeTo(page, config);
  const binding = { connection_id: config.connectionId, forum_origin: client.origin, native_origin: new URL(page.canonical_url).origin };
  if (operation.pendingToMutation && !operation.toBinding || operation.toBinding && semanticIdentity(operation.toBinding) !== semanticIdentity(binding)) throw attention("scope_denied");
  if (operation.pendingToMutation?.native_evidence && operation.pendingToMutation.native_evidence.source_file !== page.native_source_file) throw attention("native_ownership_conflict");
  const candidates = inventory.filter((record) => record.external_id === page.external_id || record.canonical_url === page.canonical_url);
  if (candidates.length > 1) throw attention("identity_conflict");
  let existing = candidates[0];
  if (operation.resourceId) existing = (await client.request("V4-04", { path: { resource_id: operation.resourceId } })).value;
  else if (existing) existing = (await client.request("V4-04", { path: { resource_id: existing.resource_id } })).value;
  if (existing) checkRecord(existing, page, operation);
  // Existing records need this engine's actual receipt or exact uncertain tree.
  if (existing && !operation.lastToRequest && existing.source_revision !== operation.pendingToMutation?.request.bridge_record.source_revision) throw attention("native_ownership_conflict");
  if (operation.acceptedSourceRevision && (!existing || existing.source_revision !== operation.acceptedSourceRevision
      && existing.source_revision !== operation.pendingToMutation?.request.bridge_record.source_revision)) throw attention("revision_conflict");
  const meaning = sourceMeaning(nativeSourceMetadata(page, connection));
  const baseline = currentToSourceRecord(operation);
  if (!operation.pendingToMutation && operation.currentSourceMove && sourceMeaning(baseline) === meaning) {
    return { current_source_record: structuredClone(currentToSourceObservation(operation)), forum_origin: client.origin };
  }
  const dispatch = async (pending) => {
    await assertFence(); await assertCurrentNativeTo(page, config);
    const repeatsAcceptedRequest = operation.lastToRequest?.mutation_id === pending.request.mutation_id;
    let result;
    try { ({ value: result } = await client.request("V4-02", { body: pending.request })); }
    catch (error) {
      if (error instanceof CmsReceiverRejection && error.rejection.route_id === "V4-02") {
        const invalidField = error.rejection.error.code === "invalid_field";
        operation.rejectedToIntent = { schema_version: invalidField ? "db-hugo-to-rejection-2" : "db-hugo-to-rejection-1",
          outcome: "rejected", pending: structuredClone(pending), receiver: {
            ...structuredClone(error.rejection), ...(invalidField ? { code: "invalid_field" } : {}) } };
        operation.outcome = "rejected"; operation.retryable = false; operation.reconciliationRequired = true;
        await save(); // Durable before another build can consider this pending tree.
      }
      throw error;
    }
    if (!["created", "resolved", "updated"].includes(result.outcome) || result.source_revision !== pending.request.bridge_record.source_revision
        || operation.resourceId && result.resource_id !== operation.resourceId || operation.topicId && result.topic_id !== operation.topicId
        || existing && (result.resource_id !== existing.resource_id || result.topic_id !== existing.topic_id)
        || new URL(result.topic_url).origin !== client.origin || !new RegExp(`^/t/(?:[^/]+/)?${result.topic_id}/?$`).test(new URL(result.topic_url).pathname)) throw attention("native_ownership_conflict");
    if (operation.lastToRequest && operation.lastToRequest.mutation_id !== pending.request.mutation_id) {
      operation.toHistory ??= [];
      if (!operation.toHistory.some((saved) => saved.request.mutation_id === operation.lastToRequest.mutation_id)) operation.toHistory.push({
        request: operation.lastToRequest, identity: operation.lastToIdentity, response: operation.lastToResponse,
        ...(operation.toSourceCapture === undefined ? {} : { source_capture: operation.toSourceCapture }) });
    }
    if (operation.currentSourceMove) {
      const moved = operation.sourceMoves.history.find((entry) => entry.move.move_id === operation.currentSourceMove.move_id);
      operation.sourceCacheRetirement = { file: moved.public_data.file, sha256: moved.public_data.blob.sha256, mutation_id: pending.request.mutation_id };
      delete operation.currentSourceMove;
    }
    operation.toBinding = binding; operation.resourceId = result.resource_id; operation.topicId = result.topic_id; operation.topicUrl = result.topic_url;
    operation.acceptedSourceRevision = result.source_revision; operation.lastToRequest = pending.request; operation.lastToIdentity = pending.identity; operation.lastToResponse = result;
    if (sourceMeaning(pending.request.bridge_record) === meaning) {
      operation.toNativeBinding = {
        site_root: path.resolve(config.toNative.siteRoot), content_root: path.resolve(config.toNative.contentRoot ?? path.join(config.toNative.siteRoot, "content")),
        source_file: page.native_source_file, source_sha256: page.native_source_sha256, source_revision: result.source_revision,
        scope_revision: connection.scope_revision, policy_revision: connection.policy.policy_revision, lane: connection.publication_lane };
      if (pending.native_evidence.source_capture !== undefined && (!repeatsAcceptedRequest || operation.toSourceCapture === undefined)) operation.toSourceCapture = pending.native_evidence.source_capture;
    }
    delete operation.pendingToMutation; await save(); await retireToSourceCache(operation, save, assertFence);
    return { ...result, forum_origin: client.origin };
  };
  let request;
  if (operation.pendingToMutation) {
    const previous = sourceMeaning(operation.pendingToMutation.request.bridge_record), result = await dispatch(operation.pendingToMutation);
    if (previous === meaning) return result;
  } else if (operation.lastToRequest && sourceMeaning(operation.lastToRequest.bridge_record) === meaning) request = operation.lastToRequest;
  if (request === undefined) {
    // The full ordinary native snapshot supplies edition meaning. Unchanged
    // meaning above reuses its exact request; artifact/representation-only
    // changes cannot manufacture freshness. Genuine metadata/prepared-content
    // changes retain actual dates and the accepted predecessor.
    request = { mutation_id: randomUUID(), bridge_record: toRecord(page, connection, operation) };
  }
  operation.pendingToMutation = { identity: payloadIdentity(request.bridge_record), request,
    native_evidence: { source_file: page.native_source_file, source_sha256: page.native_source_sha256,
      ...(page.source_capture === undefined ? {} : { source_capture: page.source_capture }) } }; operation.toBinding = binding;
  operation.requestedSourceRevision = request.bridge_record.source_revision; operation.requestedPreviousRevision = request.bridge_record.expected_source_revision;
  if (JSON.stringify(operation.pendingToMutation).includes(config.connectionSecret)) throw attention("metadata_unavailable");
  await save(); return dispatch(operation.pendingToMutation);
}
