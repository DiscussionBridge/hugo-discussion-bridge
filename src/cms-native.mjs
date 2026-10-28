import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { retrieveSimple } from "./public-core.mjs";
import { sanitizePublicationHtml } from "./native-content.mjs";
import { createCmsClient } from "./cms-client.mjs";
import { withCmsContinuation } from "./cms-continuation.mjs";
import { runCmsNativeCommand, validateCmsNativeCommand } from "./native-command.mjs";
import { withHugoNativeWriter } from "./cms-native-authority.mjs";
import { assertCmsSafePath, createCmsPrivateDirectory, getCmsProcessIdentity, withCmsJournal, withCmsJournalObservation } from "./cms-journal.mjs";
import { createCmsPayloadSpool } from "./cms-payload-spool.mjs";
import { ownedNativeFragment, verifyNativePublic } from "./cms-proof.mjs";
import { parseCmsJson, semanticIdentity, validateCms } from "./protocol-v4/cms-runtime.mjs";
import { PRODUCT_VERSION } from "./version.mjs";
import { inspectPreservedSource, prepareNativeSource, preserveSourceCapture } from "./source-preparation.mjs";
import { hashCmsOwnershipReceipt } from "./cms-ownership.mjs";
import { pollHugoAttention, probeHugoAttention, handoffHugoAttention, restoreHugoAttentionBaseline, verifyHugoRestoredBaseline } from "./cms-attention.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code) => Object.assign(new Error(`Hugo CMS ${code}; native publication requires attention.`), { code });
const authorityOf = (lease) => ({ work_id: lease.work.work_id, lease_token: lease.lease_token, lease_generation: lease.lease_generation, source_revision: lease.work.source_revision, policy_revision: lease.work.policy_revision });
const privateAuthority = (lease) => { const value = authorityOf(lease); delete value.lease_token; return value; };

export function nativeCmsConfiguration(value) {
  const fields = ["siteRoot", "privateRoot", "siteUrl", "nativeShortcode", "contentDirectory", "dataDirectory", "publicDirectory", "maximumPages", "maximumClaims", "build", "deploy"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) throw fail("invalid_field");
  if (!value || !path.isAbsolute(value.siteRoot) || !path.isAbsolute(value.privateRoot)
      || typeof value.nativeShortcode !== "string" || !/^[a-z][a-z0-9-]*$/u.test(value.nativeShortcode) || value.nativeShortcode === "none") throw fail("presentation_unsupported");
  const siteRoot = path.resolve(value.siteRoot), site = new URL(value.siteUrl);
  validateCmsNativeCommand(value.build); validateCmsNativeCommand(value.deploy);
  if (site.protocol !== "https:" || site.username || site.password || site.pathname !== "/" || site.search || site.hash) throw fail("scope_denied");
  const directory = (name, fallback) => {
    const relative = value[name] ?? fallback;
    if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split(/[\\/]/u).some((part) => !part || [".", ".."].includes(part))) throw fail("native_ownership_conflict");
    return path.join(siteRoot, relative);
  };
  const result = { ...value, siteRoot, siteUrl: site.origin, privateRoot: path.resolve(value.privateRoot),
    contentRoot: directory("contentDirectory", "content"), dataRoot: directory("dataDirectory", "data/discussionbridge"), publicRoot: directory("publicDirectory", "public") };
  const contains = (a, b) => { const relative = path.relative(a, b); return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative); };
  const roots = [result.contentRoot, result.dataRoot, result.publicRoot];
  if (contains(result.siteRoot, result.privateRoot) || contains(result.privateRoot, result.siteRoot)
      || roots.some((a, i) => roots.some((b, j) => i !== j && contains(a, b)))) throw fail("native_ownership_conflict");
  for (const key of ["maximumClaims", "maximumPages"]) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > 100)) throw fail("invalid_field");
  return result;
}
async function regularBytes(file) {
  await assertCmsSafePath(file);
  try { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail("native_ownership_conflict"); return await readFile(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function nativeIdentity(config, connection, sourceId) {
  const digest = sha(`${connection.connection_id}\0${sourceId}`), slug = `source-${digest}`;
  const file = path.join(config.contentRoot, "discussionbridge", `${slug}.md`);
  return { slug, file, nativeId: path.relative(config.siteRoot, file).split(path.sep).join("/"), externalId: `hugo-cms:${digest}`, canonical: `${config.siteUrl}/discussionbridge/${slug}/` };
}
async function* contentChunks(client, source, beforeChunk) {
  let offset = 0;
  for (;;) {
    await beforeChunk();
    const { value: chunk } = await client.request("V4-07", { path: { source_id: source.source_id, source_revision: source.source_revision }, query: { offset } });
    if (chunk.source_id !== source.source_id || chunk.source_revision !== source.source_revision || chunk.offset !== offset
        || chunk.content_bytes !== source.content_bytes || chunk.content_sha256 !== source.content_sha256) throw fail("content_hash_mismatch");
    yield Buffer.from(chunk.content_base64, "base64");
    if (chunk.next_offset === null) break; offset = chunk.next_offset;
  }
}
function markdownPage(source, mapping, connection, identity, config) {
  const fields = { title: source.title, url: new URL(mapping.canonical_url).pathname, discussionbridge_mode: "from_discourse",
    discussionbridge_native_publication: true, discussionbridge_resource_id: mapping.resource_id,
    discussionbridge_topic_id: source.topic_id, discussionbridge_source_revision: source.source_revision, discussionbridge_adapter_version: PRODUCT_VERSION,
    discussionbridge_presentation_mode: connection.policy.presentation_mode, discussionbridge_forum_name: connection.forum_name };
  if (source.source_authors.length) fields.discussionbridge_source_author = source.source_authors.map(({ name }) => name).join(", ");
  if (source.source_created_at !== null) fields.date = source.source_created_at;
  if (source.source_updated_at !== null) fields.lastmod = source.source_updated_at;
  return Buffer.from(`+++\n${Object.entries(fields).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n")}\n+++\n\n{{< ${config.nativeShortcode} mode="from_discourse" >}}\n`);
}
async function stoppedCommands(continuation, transactionId) {
  for (const kind of ["build", "deploy"]) {
    const record = await continuation.nativeRecord(`native/${transactionId}/${kind}.json`);
    if (record !== null && record.phase !== "completed" && (record.owner_pid === null || (await getCmsProcessIdentity(record.owner_pid)).state !== "absent")) throw fail("native_restore_required");
  }
}
async function deploymentReceipt(file, preparedAt, secrets) {
  const bytes = await regularBytes(file); if (bytes === null || bytes.length > 262144) throw fail("native_service_unavailable");
  const value = parseCmsJson(bytes, { maximumBytes: 262144 });
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "deployment_id") || !Object.hasOwn(value, "deployed_at")) throw fail("native_service_unavailable");
  validateCms("OpaqueId", value.deployment_id); validateCms("Instant", value.deployed_at);
  if (value.deployed_at < preparedAt || secrets.some((secret) => JSON.stringify(value).includes(secret))) throw fail("native_service_unavailable");
  return value;
}

const ownership = (receipt) => ({ resource_id: receipt.resource_id, external_id: receipt.external_id, native_id: receipt.native_id,
  canonical_url: receipt.canonical_url, source_revision: receipt.source_revision, ownership_receipt_sha256: hashCmsOwnershipReceipt(receipt) });

// Local owner controls. A forum observation request cannot select a native
// command or invoke these restoration branches.
export async function runHugoAttention({ native, connectionConfig, cmsFetch = fetch, publicFetch = fetch, now = Date.now,
  operation = "check", mappingId, transactionId, operationId }) {
  const config = nativeCmsConfiguration(native), client = createCmsClient(connectionConfig, { fetchImpl: cmsFetch });
  const connection = await client.authorizeNative(config.siteUrl);
  if (!["check", "restore-baseline", "deploy-restored-baseline"].includes(operation)) throw fail("invalid_field");
  const publicRoots = [config.publicRoot, path.join(config.siteRoot, "static"), path.join(config.siteRoot, "assets"), path.join(config.siteRoot, "data")];
  return withHugoNativeWriter({ nativeRoot: config.contentRoot, connection, forumOrigin: client.origin, privateRoot: config.privateRoot, observeOnly: true }, (assertWriter) =>
    withCmsContinuation({ privateRoot: config.privateRoot, nativeRoot: config.siteRoot, publicRoots, client, connection }, async (continuation) => {
      if (operation === "check") return pollHugoAttention({ config, client, connection, continuation, publicFetch, now });
      validateCms("UUID", mappingId); validateCms("UUID", transactionId); validateCms("UUID", operationId);
      if (!await probeHugoAttention(client)) throw fail("presentation_unsupported");
      const options = { journalRoot: path.join(config.privateRoot, "journals"), nativeRoot: config.siteRoot, mappingId };
      const original = await withCmsJournalObservation(options, (journal) => journal.snapshot());
      if (!original?.transaction || original.transaction.transaction_id !== transactionId) throw fail("native_restore_required");
      const current = (await client.request("V4-14", { path: { work_id: original.transaction.authority.work_id } })).value;
      if (current.work.state !== "attention" || current.work.mapping_id !== mappingId || current.mapping.connection_id !== connection.connection_id
          || current.work.policy_revision !== connection.policy.policy_revision || current.mapping.source_id !== original.transaction.receipt.source_id
          || current.mapping.destination_native_id !== original.transaction.receipt.native_id || current.mapping.canonical_url !== original.transaction.receipt.canonical_url) throw fail("scope_denied");
      await assertWriter();
      if (operation === "restore-baseline") return restoreHugoAttentionBaseline({ config, mappingId, transactionId, operationId, continuation });
      if (continuation.snapshot().pending !== null) throw fail("native_restore_required");
      await verifyHugoRestoredBaseline({ config, mappingId, transactionId, operationId, continuation, localOnly: true });
      const receiptPath = path.join(config.privateRoot, "native", operationId, "deployment-receipt.json");
      await createCmsPrivateDirectory(path.dirname(receiptPath));
      const fence = async () => {
        await assertWriter();
        const updated = (await client.request("V4-14", { path: { work_id: original.transaction.authority.work_id } })).value;
        const configured = await client.authorizeNative(config.siteUrl);
        if (updated.work.state !== "attention" || updated.work.work_id !== current.work.work_id || updated.mapping.mapping_revision !== current.mapping.mapping_revision
            || configured.scope_revision !== connection.scope_revision || semanticIdentity(configured.policy) !== semanticIdentity(connection.policy)) throw fail("scope_denied");
        await verifyHugoRestoredBaseline({ config, mappingId, transactionId, operationId, continuation, localOnly: true });
      };
      for (const kind of ["build", "deploy"]) await runCmsNativeCommand({ kind, transactionId: operationId, command: config[kind],
        values: { transaction_id: operationId, site_root: config.siteRoot, public_root: config.publicRoot, receipt_path: receiptPath }, continuation, assertFence: fence });
      await deploymentReceipt(receiptPath, current.mapping.publicly_verified_at, [connectionConfig.connectionSecret]);
      return verifyHugoRestoredBaseline({ config, mappingId, transactionId, operationId, continuation, publicFetch, now });
    }));
}

async function coordinatePresentationMove({ request, journal, continuation, client, connection, config, identity, mapping, getLease, fence, command, publicFetch, now }) {
  let local = journal.snapshot().transaction?.presentation_move;
  const pending = continuation.snapshot().pending;
  const authority = () => authorityOf(getLease());
  const completeFailure = async () => {
    local = journal.snapshot().transaction.presentation_move;
    if (local.phase !== "attention" || local.failure_code !== "public_verification_failed" || !local.rollback_verification) return { stopped: true, local_issue: "presentation_move_requires_reconciliation" };
    let result;
    if (continuation.snapshot().pending?.route_id === "V4-17") result = (await continuation.resumeMutation()).response;
    else result = await continuation.post("V4-17", { authority: authority(), code: "public_verification_failed", native_change_applied: true, safe_detail: null, retry_after_seconds: null }, { work_id: getLease().work.work_id });
    await continuation.mapping(mapping.source_id, result.value.mapping); await continuation.settleMutation(); await continuation.releaseCompletedLease(result.value.work);
    return { stopped: true, attention: true };
  };
  if (local && ["V4-22", "V4-23", "V4-17"].includes(pending?.route_id)) {
    if (semanticIdentity(local.authority) !== semanticIdentity(privateAuthority(getLease()))) throw fail("native_restore_required");
    if (pending.route_id === "V4-17") return completeFailure();
    const resumed = await continuation.resumeMutation();
    if (resumed.route === "V4-22") {
      await journal.acceptPresentationCommit(resumed.response.value); await continuation.acceptPresentationMapping(local.move, resumed.response.value); await continuation.settleMutation();
      return { mapping: resumed.response.value, receipt: local.receipt };
    }
    await journal.acceptPresentationAbort(resumed.response.value); await continuation.settleMutation(); return completeFailure();
  }
  if (local?.phase === "attention") return completeFailure();
  if (local?.phase === "committed" && local.baseline_pending) {
    if (mapping.canonical_url !== local.move.new_url || mapping.mapping_revision !== local.mapping_response.mapping_revision
        || semanticIdentity(local.authority) !== semanticIdentity(privateAuthority(getLease()))) throw fail("native_restore_required");
    return { mapping, receipt: local.receipt };
  }
  const open = local && ["staged", "applied", "restored"].includes(local.phase);
  if (open && (semanticIdentity(local.authority) !== semanticIdentity(privateAuthority(getLease()))
      || request && (request.newUrl !== local.move.new_url || request.expectedMappingRevision !== local.move.expected_mapping_revision))) throw fail("native_restore_required");
  if (!open) {
    const existing = journal.snapshot().last_verified, durable = pending?.route_id === "V4-21" ? pending.body : null;
    const target = request ?? (durable ? { mappingId: mapping.mapping_id, newUrl: durable.new_url, expectedMappingRevision: durable.expected_mapping_revision } : null);
    if (!target || target.mappingId !== mapping.mapping_id || target.expectedMappingRevision !== mapping.mapping_revision || target.newUrl === mapping.canonical_url
        || new URL(target.newUrl).origin !== config.siteUrl || getLease().work.action !== "publish_revision" || !existing || mapping.mapping_state !== "active" || existing.action !== "publish_revision"
        || mapping.desired_source_revision !== existing.receipt.source_revision || mapping.publicly_verified_source_revision !== existing.receipt.source_revision
        || getLease().work.source_revision !== existing.receipt.source_revision || existing.authority.policy_revision !== getLease().work.policy_revision) throw fail("native_restore_required");
    const oldReceipt = { ...structuredClone(existing.receipt), last_lease_generation: getLease().lease_generation };
    const prior = await journal.inspectPresentationOrigin(oldReceipt); await fence();
    const response = durable ? (await continuation.resumeMutation()).response : await continuation.post("V4-21", {
      authority: authority(), expected_mapping_revision: mapping.mapping_revision, old_url: mapping.canonical_url, new_url: target.newUrl, ownership: ownership(oldReceipt) }, { mapping_id: mapping.mapping_id });
    const move = response.value;
    if (move.mapping_id !== mapping.mapping_id || move.old_url !== mapping.canonical_url || move.new_url !== target.newUrl
        || move.expected_mapping_revision !== mapping.mapping_revision || move.state !== "prepared") throw fail("native_ownership_conflict");
    const receipt = { ...oldReceipt, canonical_url: move.new_url, move_id: move.move_id, proof_nonce: move.proof_nonce };
    const cachePath = path.relative(config.siteRoot, path.join(config.dataRoot, `${identity.slug}.json`)).split(path.sep).join("/");
    const files = [];
    for (const file of prior.files) {
      let bytes = await regularBytes(path.join(config.siteRoot, file.path));
      if (sha(bytes) !== file.after_sha256) throw fail("native_ownership_conflict");
      if (file.path === identity.nativeId) {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), matches = [...text.matchAll(/^url = ("[^\n]*")$/gmu)];
        if (matches.length !== 1 || JSON.parse(matches[0][1]) !== new URL(move.old_url).pathname) throw fail("native_ownership_conflict");
        bytes = Buffer.from(text.replace(matches[0][0], `url = ${JSON.stringify(new URL(move.new_url).pathname)}`));
      } else if (file.path === cachePath) {
        const data = parseCmsJson(bytes, { maximumBytes: Number.MAX_SAFE_INTEGER });
        if (data.resource_id !== mapping.resource_id || data.source_revision !== getLease().work.source_revision || data.cms_verification?.native_id !== identity.nativeId
            || data.cms_verification.mapping_id !== mapping.mapping_id || data.presentation_mode !== connection.policy.presentation_mode) throw fail("native_ownership_conflict");
        data.cms_verification.move_id = move.move_id; data.cms_verification.proof_nonce = move.proof_nonce; bytes = Buffer.from(JSON.stringify(data));
      }
      files.push({ path: file.path, expectedSha256: file.after_sha256, bytes });
    }
    if (!files.some((file) => file.path === identity.nativeId) || !files.some((file) => file.path === cachePath)) throw fail("native_ownership_conflict");
    await journal.stagePresentationMove({ move, oldReceipt, receipt, files }); await continuation.settleMutation(); local = journal.snapshot().transaction.presentation_move;
  }
  let observedPublic = false;
  try {
    await fence(); await journal.applyPresentationMove(); local = journal.snapshot().transaction.presentation_move;
    const receiptPath = path.join(config.privateRoot, "native", local.move.move_id, "deployment-receipt.json"); await createCmsPrivateDirectory(path.dirname(receiptPath));
    await command("build", local.move.move_id, receiptPath);
    const artifact = path.join(config.publicRoot, new URL(local.move.new_url).pathname, "index.html"), expectedHtml = await regularBytes(artifact);
    ownedNativeFragment(expectedHtml, { mappingId: mapping.mapping_id, resourceId: mapping.resource_id, nativeId: identity.nativeId, sourceRevision: getLease().work.source_revision,
      presentationMode: connection.policy.presentation_mode, moveId: local.move.move_id, proofNonce: local.move.proof_nonce, canonicalUrl: local.move.new_url });
    await command("deploy", local.move.move_id, receiptPath);
    const deployment = await deploymentReceipt(receiptPath, local.move.prepared_at, [getLease().lease_token]);
    const verification = await verifyNativePublic({ action: "publish_revision", receipt: local.receipt, representation: local.prior_verified.native_result.representation,
      expectedHtml, presentationMode: connection.policy.presentation_mode, destinationOrigin: config.siteUrl, now,
      publicFetch: async (...args) => { const response = await publicFetch(...args); observedPublic = true; return response; } });
    await journal.recordPresentationProof(verification, deployment); await fence();
    const result = await continuation.post("V4-22", { authority: authority(), move_id: local.move.move_id, proof_nonce: local.move.proof_nonce,
      ownership: ownership(local.receipt), verification }, { mapping_id: mapping.mapping_id, move_id: local.move.move_id });
    await journal.acceptPresentationCommit(result.value); await continuation.acceptPresentationMapping(local.move, result.value); await continuation.settleMutation();
    return { mapping: result.value, receipt: local.receipt };
  } catch (error) {
    if (continuation.snapshot().pending !== null) throw error; // Exact uncertain move is never concealed by rollback.
    await fence(); // Expired/superseded/replacement authority cannot restore or abort this native move.
    const applied = await journal.presentationChangeApplied();
    if (observedPublic && error.code === "public_verification_failed") await journal.recordPresentationPublicFailure();
    await stoppedCommands(continuation, local.move.move_id); await journal.restorePresentationMove();
    const rollback = await journal.presentationRollbackIdentity(), receiptPath = path.join(config.privateRoot, "native", rollback, "deployment-receipt.json");
    await createCmsPrivateDirectory(path.dirname(receiptPath)); await command("build", rollback, receiptPath); await command("deploy", rollback, receiptPath);
    const restored = await verifyNativePublic({ action: "publish_revision", receipt: local.old_receipt, representation: local.prior_verified.native_result.representation,
      expectedHtml: await regularBytes(path.join(config.publicRoot, new URL(local.move.old_url).pathname, "index.html")), presentationMode: connection.policy.presentation_mode,
      destinationOrigin: config.siteUrl, publicFetch, now });
    await journal.recordPresentationRollbackProof(restored); await fence();
    const result = await continuation.post("V4-23", { authority: authority(), move_id: local.move.move_id, native_change_applied: applied,
      ownership: ownership(local.old_receipt) }, { mapping_id: mapping.mapping_id, move_id: local.move.move_id });
    await journal.acceptPresentationAbort(result.value, restored); await continuation.settleMutation(); return completeFailure();
  }
}

export async function runHugoNativeCms({ native, connectionConfig, cmsFetch = fetch, publicFetch = fetch, now = Date.now, sourceRenderer = sanitizePublicationHtml, presentationMove }) {
  const config = nativeCmsConfiguration(native);
  const client = createCmsClient(connectionConfig, { fetchImpl: cmsFetch });
  const connection = await client.authorizeNative(config.siteUrl);
  if (presentationMove !== undefined) {
    if (!presentationMove || Object.keys(presentationMove).sort().join(",") !== "expectedMappingRevision,mappingId,newUrl") throw fail("invalid_field");
    validateCms("UUID", presentationMove.mappingId); validateCms("Url", presentationMove.newUrl); validateCms("Revision", presentationMove.expectedMappingRevision);
    if (new URL(presentationMove.newUrl).origin !== config.siteUrl) throw fail("scope_denied");
  }
  if (connection.policy.author_ids.length || connection.policy.taxonomy_ids.length) throw fail("catalog_entry_unavailable"); // No native ID map exists; never substitute source provenance.
  if (!connection.native_capabilities.complete_content_supported) throw fail("native_limit_exceeded");
  for (const root of [config.siteRoot, config.contentRoot, config.dataRoot, config.publicRoot]) await assertCmsSafePath(root);
  const publicRoots = [config.publicRoot, path.join(config.siteRoot, "static"), path.join(config.siteRoot, "assets"), path.join(config.siteRoot, "data")];
  const summary = { wire_version: "v4", claimed: 0, verified: 0, attention: 0, local_limitations: 0, discovery_limitations: 0, local_issues: [], feed_complete: false };
  return withHugoNativeWriter({ nativeRoot: config.contentRoot, connection, forumOrigin: client.origin, privateRoot: config.privateRoot }, (writerFence) =>
    withCmsContinuation({ privateRoot: config.privateRoot, nativeRoot: config.siteRoot, publicRoots, client, connection }, async (continuation) => {
      if (!presentationMove) summary.attention_recovery = await pollHugoAttention({ config, client, connection, continuation, publicFetch, now });
      if (continuation.snapshot().pending?.route_id === "V4-09") {
        const resumed = await continuation.resumeMutation();
        await continuation.mapping(resumed.body.source_id, resumed.response.value); await continuation.settleMutation();
      }
      // Finish a claimed operation before discovering more work or allocating another mutation.
      summary.feed_complete = continuation.snapshot().active_lease !== null ? false : (await continuation.drainSources({ maximumPages: config.maximumPages ?? 10 })).complete;
      for await (const event of continuation.currentEvents()) {
        if (continuation.snapshot().active_lease !== null) break;
        if (presentationMove || event.event_type !== "publication" || await continuation.mapping(event.source.source_id) !== null) continue;
        const identity = nativeIdentity(config, connection, event.source.source_id);
        const { value: mapping } = await continuation.post("V4-09", { source_id: event.source.source_id, source_revision: event.source.source_revision,
          policy_revision: connection.policy.policy_revision, external_id: identity.externalId, canonical_url: identity.canonical });
        if (mapping.external_id !== identity.externalId || mapping.canonical_url !== identity.canonical) throw fail("mapping_conflict");
        await continuation.mapping(event.source.source_id, mapping); await continuation.settleMutation();
      }
      if (continuation.snapshot().active_lease === null && continuation.snapshot().stream === "initial") {
        let recoveryQueued = false; for await (const record of continuation.attentionRecoveries()) { recoveryQueued = true; break; }
        if (!recoveryQueued) return summary;
      }
      const sourceFor = async (sourceId, revision, beforePage) => {
        try { return await continuation.source(sourceId, revision); }
        catch (error) {
          if (error.code !== "revision_unavailable") throw error;
          await continuation.drainSources({ maximumPages: config.maximumPages ?? 10, beforePage });
          return continuation.source(sourceId, revision);
        }
      };
      const maximumClaims = config.maximumClaims ?? 10;
      if (!Number.isSafeInteger(maximumClaims) || maximumClaims < 1 || maximumClaims > 100) throw fail("invalid_field");
      const claimNext = async () => {
        if (presentationMove) {
          if (continuation.snapshot().active_lease?.value.work.mapping_id && continuation.snapshot().active_lease.value.work.mapping_id !== presentationMove.mappingId) throw fail("lease_conflict");
          return continuation.claim(presentationMove.mappingId);
        }
        if (continuation.snapshot().active_lease === null) {
          const recoveryRecords = []; for await (const record of continuation.attentionRecoveries()) recoveryRecords.push(record);
          recoveryRecords.sort((a, b) => a.recovery.sequence - b.recovery.sequence);
          const pendingRecovery = continuation.snapshot().pending?.route_id === "V4-36" ? continuation.snapshot().pending.path.recovery_id : null;
          if (pendingRecovery) recoveryRecords.sort((a, b) => Number(b.recovery.recovery_id === pendingRecovery) - Number(a.recovery.recovery_id === pendingRecovery));
          for (const record of recoveryRecords) {
            const { recovery } = record;
            const current = (await client.request("V4-14", { path: { work_id: recovery.work.work_id } })).value;
            if (current.work.mapping_id !== recovery.mapping.mapping_id || current.mapping.connection_id !== connection.connection_id) throw fail("scope_denied");
            if (["verified", "attention", "superseded", "cancelled", "retry_wait"].includes(current.work.state)) {
              await continuation.settleAttentionRecovery(record); continue;
            }
            await continuation.stageRecoverySource(recovery);
            const lease = await continuation.claimRecovery(recovery); if (lease !== null) return lease;
          }
        }
        const holds = continuation.heldLimitations();
        if (!holds.length || continuation.snapshot().active_lease !== null) return continuation.claim();
        const events = new Map(); for await (const event of continuation.currentEvents()) events.set(event.event_type === "publication" ? event.source.source_id : event.source_id, event);
        const candidates = new Map(); let cursor;
        for (let page = 0; page < (config.maximumPages ?? 10); page++) {
          const { value } = await client.request("V4-10", { query: cursor === undefined ? {} : { cursor } });
          for (const mapping of value.items) {
            const owned = await continuation.mapping(mapping.source_id);
            if (owned?.mapping_id === mapping.mapping_id && mapping.connection_id === connection.connection_id) candidates.set(mapping.mapping_id, mapping);
          }
          if (value.next_cursor === null) break; if (value.next_cursor === cursor) throw fail("cursor_invalid"); cursor = value.next_cursor;
        }
        for (const mapping of candidates.values()) {
          let refused = false;
          for (const held of holds.filter((entry) => entry.lease.value.work.mapping_id === mapping.mapping_id)) {
            const known = held.lease.value.work, issue = await continuation.nativeRecord(held.issue_name);
            if (!issue || issue.work.work_id !== known.work_id || issue.work.action !== known.action || issue.work.source_revision !== known.source_revision
                || issue.work.policy_revision !== known.policy_revision || issue.work.attempt_cycle !== known.attempt_cycle) throw fail("native_restore_required");
            const current = (await client.request("V4-14", { path: { work_id: known.work_id } })).value;
            if (current.mapping.mapping_id !== mapping.mapping_id || current.mapping.connection_id !== connection.connection_id) throw fail("scope_denied");
            const event = events.get(mapping.source_id), changedEvent = event && (event.event_type === "revocation" || event.source.source_revision !== known.source_revision);
            const sameWork = ["work_id", "action", "source_revision", "policy_revision", "attempt_cycle"].every((field) => current.work[field] === known[field]);
            if (!sameWork || ["cancelled", "superseded"].includes(current.work.state)) { await continuation.settleHeldLimitation(held, "superseded"); continue; }
            if (current.work.state === "attention") { refused = true; summary.local_limitations++; continue; }
            const repaired = (await inspectPreservedSource(config.privateRoot, issue, sourceRenderer)).losses.length === 0;
            if (repaired) {
              if (await continuation.resumeHeldLease(held, current)) return continuation.claim();
              await continuation.settleHeldLimitation(held, "superseded"); continue;
            }
            refused = true; summary.local_limitations++;
            if (changedEvent) {
              summary.discovery_limitations++;
              summary.local_issues.push({ mapping_id: mapping.mapping_id, known_work_id: known.work_id, status: "within_mapping_work_selection_unresolved",
                current_event_type: event.event_type, current_source_revision: event.event_type === "publication" ? event.source.source_revision : null });
            }
          }
          if (!refused) { const lease = await continuation.claim(mapping.mapping_id); if (lease !== null) return lease; }
        }
        return null;
      };
      for (let index = 0; index < (presentationMove ? 1 : maximumClaims); index++) {
        let lease = await claimNext(); if (lease === null) break; summary.claimed++;
        let lastRenewed = performance.now();
        const maintainLease = async () => {
          if (performance.now() - lastRenewed >= 30000 || Date.parse(lease.expires_at) - now() <= 60000) {
            lease = await continuation.renew(lease); lastRenewed = performance.now();
          }
        };
        const { value: status } = await client.request("V4-14", { path: { work_id: lease.work.work_id } });
        if (status.work.work_id !== lease.work.work_id || status.work.mapping_id !== lease.work.mapping_id || status.work.lease_generation !== lease.lease_generation
            || status.work.source_revision !== lease.work.source_revision || status.work.policy_revision !== connection.policy.policy_revision
            || status.mapping.connection_id !== connection.connection_id || status.mapping.source_id !== lease.work.source_id) throw fail("lease_conflict");
        let mapping = status.mapping;
        if (!["V4-22"].includes(continuation.snapshot().pending?.route_id)) await continuation.mapping(mapping.source_id, mapping);
        const identity = nativeIdentity(config, connection, mapping.source_id);
        const initialCanonical = identity.canonical;
        if (mapping.external_id !== identity.externalId || new URL(mapping.canonical_url).origin !== config.siteUrl || mapping.destination_native_id !== null && mapping.destination_native_id !== identity.nativeId) throw fail("native_ownership_conflict");
        identity.canonical = mapping.canonical_url;
        const fence = async () => {
          await writerFence(); await maintainLease();
          const { value } = await client.request("V4-14", { path: { work_id: lease.work.work_id } });
          const current = await client.authorizeNative(config.siteUrl);
          if (current.scope_revision !== connection.scope_revision || semanticIdentity(current.policy) !== semanticIdentity(connection.policy)) throw fail("policy_changed");
          if (value.work.work_id !== lease.work.work_id || value.work.mapping_id !== mapping.mapping_id || value.work.source_revision !== lease.work.source_revision
              || value.work.policy_revision !== lease.work.policy_revision || value.work.lease_generation !== lease.lease_generation
              || value.lease_expires_at === null || Date.parse(value.lease_expires_at) <= now() || !["leased", "synchronized", "deployed"].includes(value.work.state)
              || ["mapping_id", "resource_id", "source_id", "external_id", "canonical_url"].some((key) => value.mapping[key] !== mapping[key])) throw fail("lease_conflict");
        };
        const journalRoot = path.join(config.privateRoot, "journals");
        await createCmsPrivateDirectory(journalRoot);
        for await (const record of continuation.attentionRecoveries()) if (record.recovery.work.work_id === lease.work.work_id && record.state === "queued") {
          await handoffHugoAttention({ config, recovery: record.recovery, lease, continuation, connection, publicFetch, assertCurrentLease: fence, now });
          await continuation.nativeRecord(`native/recoveries/${record.recovery.recovery_id}.json`, { ...record, state: "handed_off" });
        }
        await withCmsJournal({ journalRoot, nativeRoot: config.siteRoot, mappingId: mapping.mapping_id }, privateAuthority(lease), async (journal) => {
          let old = journal.snapshot().transaction;
          const command = async (kind, transactionId, receiptPath) => {
            const controller = new AbortController(); let renewal = Promise.resolve(), renewalError = null;
            const timer = setInterval(() => { renewal = renewal.then(async () => {
              if (renewalError) return;
              try { await writerFence(); lease = await continuation.renew(lease); } catch (error) { renewalError = error; controller.abort(); }
            }); }, 30000);
            try {
              return await runCmsNativeCommand({ kind, transactionId, command: config[kind],
                values: { transaction_id: transactionId, site_root: config.siteRoot, public_root: config.publicRoot, receipt_path: receiptPath }, continuation, assertFence: fence, signal: controller.signal });
            } finally { clearInterval(timer); await renewal; if (renewalError) throw renewalError; }
          };
          const moveState = old?.presentation_move, moveRoute = continuation.snapshot().pending?.route_id;
          let moveReceipt = null;
          if (presentationMove || ["V4-21", "V4-22", "V4-23"].includes(moveRoute) || moveState && (moveState.baseline_pending || !["committed", "aborted"].includes(moveState.phase))) {
            const result = await coordinatePresentationMove({ request: presentationMove, journal, continuation, client, connection, config, identity, mapping,
              getLease: () => lease, fence, command, publicFetch, now });
            if (result.stopped) { if (result.attention) summary.attention++; else summary.local_issues.push({ mapping_id: mapping.mapping_id, status: result.local_issue }); return; }
            mapping = result.mapping; identity.canonical = mapping.canonical_url; moveReceipt = result.receipt; old = journal.snapshot().transaction;
          }
          if (mapping.canonical_url !== initialCanonical && journal.snapshot().last_verified?.receipt.canonical_url !== mapping.canonical_url
              && !(old?.presentation_move?.phase === "committed" && old.presentation_move.mapping_response?.canonical_url === mapping.canonical_url)) throw fail("native_ownership_conflict");
          if (continuation.snapshot().pending?.route_id === "V4-17") {
            const resumed = await continuation.resumeMutation();
            if (resumed.body.native_change_applied) {
              if (old?.phase !== "restored") throw fail("native_restore_required");
              await writerFence(); await journal.restore(old.transaction_id);
            }
            await continuation.settleMutation(); await continuation.releaseCompletedLease(resumed.response.value.work); summary.attention++; return;
          }
          const pending = journal.snapshot().pending_mutation;
          if (pending !== null || ["V4-18", "V4-19", "V4-20"].includes(continuation.snapshot().pending?.route_id)) {
            const request = pending !== null ? journal.pendingRequest(lease.lease_token) : null;
            const route = { prepare: "V4-18", finalize: "V4-19", abort: "V4-20" }[request?.operation];
            const resumed = request !== null
              ? { route, body: request.payload, response: await continuation.post(route, request.payload, { work_id: lease.work.work_id }) }
              : await continuation.resumeMutation();
            if (pending !== null) await journal.acceptMutation(resumed.body.mutation_id, resumed.response.value);
            else {
              const saved = resumed.route === "V4-18" ? old?.prepare_receiver_receipt : resumed.route === "V4-19" ? old?.finalize_receiver_receipt : old?.abort_receiver_receipt;
              if (semanticIdentity(saved) !== semanticIdentity(resumed.response.value)) throw fail("native_restore_required");
            }
            await continuation.settleMutation(); await continuation.mapping(mapping.source_id, resumed.response.value.mapping);
            old = journal.snapshot().transaction;
            if (resumed.route !== "V4-18") { await continuation.releaseCompletedLease(resumed.response.value.work); if (resumed.route === "V4-19") summary.verified++; else summary.attention++; return; }
          }
          if (["verified", "attention", "cancelled", "superseded", "retry_wait"].includes(status.work.state)) {
            if (old && !["verified", "restored"].includes(old.phase)) throw fail("native_restore_required");
            if (old?.phase === "restored") { await writerFence(); await journal.restore(old.transaction_id); }
            await continuation.releaseCompletedLease(status.work); return;
          }
          if (old !== null) await stoppedCommands(continuation, old.transaction_id);
          const receipt = moveReceipt ?? { schema_version: "db-native-ownership-1", forum_origin: client.origin, connection_id: connection.connection_id,
            mapping_id: mapping.mapping_id, resource_id: mapping.resource_id, source_id: mapping.source_id, external_id: mapping.external_id,
            native_id: identity.nativeId, canonical_url: mapping.canonical_url, source_revision: lease.work.source_revision,
            last_lease_generation: lease.lease_generation, move_id: null, proof_nonce: null };
          const transactionId = old && ["staged", "applied"].includes(old.phase) ? old.transaction_id : randomUUID();
           let representation, sourceCapture, prepared = old?.receiver_prepared === true, knownSourceLoss = false;
          try {
            if (old && ["staged", "applied"].includes(old.phase)) {
              if (old.action !== lease.work.action || old.authority.work_id !== lease.work.work_id || old.authority.source_revision !== lease.work.source_revision || old.authority.policy_revision !== lease.work.policy_revision) throw fail("native_restore_required");
              if (old.authority.lease_generation !== lease.lease_generation) await journal.rebind(transactionId, receipt);
              representation = old.native_result?.representation;
            } else {
              const cacheFile = path.join(config.dataRoot, `${identity.slug}.json`);
              const prior = journal.snapshot().last_verified;
              const staged = [];
              if (lease.work.action === "publish_revision") {
                const source = await sourceFor(mapping.source_id, lease.work.source_revision, maintainLease);
                if (new URL(source.topic_url).origin !== client.origin) throw fail("scope_denied");
                const spoolParent = path.join(config.privateRoot, "spool"); await createCmsPrivateDirectory(spoolParent);
                const spool = await createCmsPayloadSpool({ spoolParent, nativeRoot: config.siteRoot, journalRoot, publicRoots, mappingId: mapping.mapping_id });
                try {
                  const parts = [];
                  async function* capturedChunks() { for await (const bytes of contentChunks(client, source, maintainLease)) { parts.push(Buffer.from(bytes)); yield bytes; } }
                  await spool.ingest(capturedChunks(), { bytes: source.content_bytes, sha256: source.content_sha256 });
                  // Rendering consumes that same complete verified stream; no metadata bound limits the source.
                  const bytes = Buffer.concat(parts); if (bytes.length !== source.content_bytes || sha(bytes) !== source.content_sha256) throw fail("content_hash_mismatch");
                  const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
                  sourceCapture = await preserveSourceCapture(config.privateRoot, source, bytes, source.topic_url);
                  const rendered = prepareNativeSource(html, sourceRenderer, source.topic_url);
                  if (rendered.losses.length) {
                    knownSourceLoss = true;
                    const issueName = `native/limitations/${lease.work.work_id}.json`;
                    const issue = { schema_version: "db-hugo-source-limitation-1", work: structuredClone(lease.work), source: structuredClone(source), source_snapshot: sourceCapture.source_snapshot, source_capture: sourceCapture,
                      cause: rendered.losses, rendered_sha256: sha(rendered.html), mapping: structuredClone(mapping), prior_verified: journal.snapshot().last_verified,
                      current_scope_revision: connection.scope_revision, lease_generation: lease.lease_generation,
                      detail: "Current native preparation cannot retain encountered source content/targets or produce usable output; faithful handling remains unresolved." };
                    await continuation.nativeRecord(issueName, issue); await continuation.holdLocalLimitation(lease, issueName); summary.local_limitations++;
                    summary.local_issues.push({ mapping_id: mapping.mapping_id, known_work_id: lease.work.work_id, source_revision: source.source_revision,
                      status: "native_source_preparation_unresolved", cause: rendered.losses }); return;
                  }
                  const content = rendered.html;
                  const simple = connection.policy.presentation_mode === "simple" ? await retrieveSimple({ key: identity.slug, topic_id: source.topic_id },
                    { serverUrl: client.origin, timeoutMs: 15000, maxResponseBytes: Math.min(Number.MAX_SAFE_INTEGER, source.content_bytes * 6 + 2 * 1024 * 1024) }, publicFetch) : null;
                  const record = { resource_id: mapping.resource_id, topic_id: source.topic_id, topic_url: source.topic_url, forum_origin: client.origin, forum_name: connection.forum_name,
                    title: source.title, content_html: content, source_revision: source.source_revision, source_authors: source.source_authors,
                    source_created_at: source.source_created_at, source_updated_at: source.source_updated_at, presentation_mode: connection.policy.presentation_mode,
                    ...(simple ? { simple_html: simple.simple_html } : {}), cms_verification: { mapping_id: mapping.mapping_id, native_id: identity.nativeId,
                      ...(receipt.move_id === null ? {} : { move_id: receipt.move_id, proof_nonce: receipt.proof_nonce }) } };
                  if ([connectionConfig.connectionSecret, lease.lease_token].some((secret) => JSON.stringify(record).includes(secret))) throw fail("metadata_unavailable");
                  representation = { kind: "full", source_content_sha256: source.content_sha256 };
                  staged.push({ path: identity.nativeId, bytes: markdownPage(source, mapping, connection, identity, config) },
                    { path: path.relative(config.siteRoot, cacheFile).split(path.sep).join("/"), bytes: Buffer.from(JSON.stringify(record)) });
                } finally { await spool.dispose(); }
              } else {
                staged.push({ path: identity.nativeId, bytes: null }, { path: path.relative(config.siteRoot, cacheFile).split(path.sep).join("/"), bytes: null });
              }
              const baseline = journal.snapshot().transaction?.presentation_move?.baseline_pending ? journal.snapshot().transaction.presentation_move : prior;
              for (const file of staged) file.expectedSha256 = baseline?.files.find((item) => item.path === file.path)?.after_sha256 ?? null;
               await fence(); await journal.stage({ transactionId, action: lease.work.action, receipt, files: staged, sourceCapture });
            }
            await fence(); await journal.apply(transactionId);
            if (representation === undefined && lease.work.action === "publish_revision") {
              const source = await sourceFor(mapping.source_id, lease.work.source_revision, maintainLease); representation = { kind: "full", source_content_sha256: source.content_sha256 };
            }
            const nativeResult = { kind: lease.work.action, native_id: identity.nativeId, external_id: mapping.external_id, canonical_url: mapping.canonical_url,
              native_revision: lease.work.source_revision, ownership_receipt_sha256: journal.ownershipHash(), ...(representation ? { representation } : {}) };
            let preparedAt = journal.snapshot().transaction.prepared_at;
            if (!journal.snapshot().transaction.receiver_prepared) {
              preparedAt = new Date(now()).toISOString();
              const prepare = { mutation_id: randomUUID(), authority: privateAuthority(lease), transaction_id: transactionId, native_result: nativeResult, prepared_at: preparedAt };
              await journal.queueMutation("prepare", prepare, lease.lease_token);
              const request = journal.pendingRequest(lease.lease_token);
              const response = await continuation.post("V4-18", request.payload, { work_id: lease.work.work_id });
              await journal.acceptMutation(prepare.mutation_id, response.value); await continuation.settleMutation();
            }
            prepared = true;
            const receiptPath = path.join(config.privateRoot, "native", transactionId, "deployment-receipt.json"); await createCmsPrivateDirectory(path.dirname(receiptPath));
            await continuation.renew(lease).then((value) => { lease = value; });
            await command("build", transactionId, receiptPath);
            const artifact = path.join(config.publicRoot, identity.canonical.slice(config.siteUrl.length + 1), "index.html");
            const expectedHtml = await regularBytes(artifact);
            if (lease.work.action === "publish_revision") ownedNativeFragment(expectedHtml, { mappingId: mapping.mapping_id, resourceId: mapping.resource_id, nativeId: identity.nativeId, sourceRevision: lease.work.source_revision, presentationMode: connection.policy.presentation_mode });
            else if (expectedHtml !== null) throw fail("public_verification_failed");
            await continuation.renew(lease).then((value) => { lease = value; });
            await command("deploy", transactionId, receiptPath);
            const deployment = await deploymentReceipt(receiptPath, preparedAt, [connectionConfig.connectionSecret, lease.lease_token]);
            const verification = await verifyNativePublic({ action: lease.work.action, receipt, representation, expectedHtml, presentationMode: connection.policy.presentation_mode,
              destinationOrigin: config.siteUrl, publicFetch, now });
            const finalize = { mutation_id: randomUUID(), authority: privateAuthority(lease), transaction_id: transactionId, ...deployment, verification };
            await journal.queueMutation("finalize", finalize, lease.lease_token);
            const result = await continuation.post("V4-19", journal.pendingRequest(lease.lease_token).payload, { work_id: lease.work.work_id });
            await journal.acceptMutation(finalize.mutation_id, result.value); await continuation.settleMutation(); await continuation.mapping(mapping.source_id, result.value.mapping);
            await continuation.releaseCompletedLease(result.value.work); summary.verified++;
          } catch (error) {
            if (knownSourceLoss) throw error; // Local issue persistence failure is not a receiver Failure classification.
            summary.attention++;
            if (journal.snapshot().pending_mutation !== null || continuation.snapshot().pending !== null) throw error; // Uncertain receipt is retained for exact replay.
            if (journal.snapshot().transaction?.transaction_id !== transactionId) {
              let code = error.code; try { validateCms("ErrorCode", code); } catch { code = "native_restore_required"; }
              const failure = await continuation.post("V4-17", { authority: authorityOf(lease), code, native_change_applied: false, safe_detail: null, retry_after_seconds: null }, { work_id: lease.work.work_id });
              await continuation.settleMutation(); await continuation.releaseCompletedLease(failure.value.work); return;
            }
            await stoppedCommands(continuation, transactionId);
            await writerFence(); const restored = await journal.restore(transactionId);
            if (prepared) {
              const abort = { mutation_id: randomUUID(), authority: privateAuthority(lease), transaction_id: transactionId, native_restored: restored.native_restored, safe_detail: null };
              await journal.queueMutation("abort", abort, lease.lease_token);
              const result = await continuation.post("V4-20", journal.pendingRequest(lease.lease_token).payload, { work_id: lease.work.work_id });
              await journal.acceptMutation(abort.mutation_id, result.value); await continuation.settleMutation(); await continuation.releaseCompletedLease(result.value.work);
            } else {
              let code = error.code; try { validateCms("ErrorCode", code); } catch { code = "native_restore_required"; }
              const failure = await continuation.post("V4-17", { authority: authorityOf(lease), code, native_change_applied: true, safe_detail: null, retry_after_seconds: null }, { work_id: lease.work.work_id });
              await continuation.settleMutation(); await continuation.releaseCompletedLease(failure.value.work);
            }
          }
        });
      }
      return summary;
    }));
}
