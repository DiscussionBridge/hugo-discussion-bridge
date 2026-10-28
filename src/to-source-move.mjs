import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRegular, nativePath, syncDirectory } from "./native-io.mjs";
import { nativeSemanticJson } from "./native-state.mjs";
import { runCmsNativeCommand, validateCmsNativeCommand } from "./native-command.mjs";
import { CmsReceiverRejection } from "./cms-client.mjs";
import { prepareNativeToSource, readSourceCapture } from "./source-preparation.mjs";
import { projectSourceMoveRecord } from "./source-move-intent.mjs";
import { validateCms, semanticIdentity, parseCmsJson } from "./protocol-v4/cms-runtime.mjs";
import { HUGO_TO_SOURCE_PROFILE, hashToSourceReceipt, ownedToSourceArticle, sourceDigest, verifyToSourcePublic } from "./to-source-proof.mjs";
import { currentToSourceRecord, keepSourceMoveBlob, patchNativeSourceUrl, readSourceMoveBlob, sourceMoveFileCas, sourceMoveProblem } from "./to-source-move-state.mjs";

const contains = (root, file) => { const relative = path.relative(root, file); return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
export function sourceMoveConfiguration(config, privateRoot) {
  const native = config.toNative, value = native?.sourceMoves;
  if (!value || Object.keys(value).some((key) => !["profile", "publicRoot", "dataRoot", "artifactPattern", "build", "deploy", "inputs"].includes(key))
      || value.profile !== HUGO_TO_SOURCE_PROFILE || !path.isAbsolute(value.publicRoot) || !path.isAbsolute(value.dataRoot)
      || typeof value.artifactPattern !== "string" || !value.artifactPattern || !Array.isArray(value.inputs) || value.inputs.length === 0) throw sourceMoveProblem("native_source_public_profile_unresolved");
  validateCmsNativeCommand(value.build); validateCmsNativeCommand(value.deploy);
  const siteRoot = path.resolve(native.siteRoot), contentRoot = path.resolve(native.contentRoot ?? path.join(siteRoot, "content"));
  const publicRoot = path.resolve(value.publicRoot), dataRoot = path.resolve(value.dataRoot);
  if (!contains(siteRoot, dataRoot) || !contains(siteRoot, publicRoot) || contains(siteRoot, privateRoot) || contains(privateRoot, siteRoot)
      || [dataRoot, publicRoot].some((root) => contains(root, contentRoot) || contains(contentRoot, root)) || contains(publicRoot, dataRoot) || contains(dataRoot, publicRoot)) throw sourceMoveProblem("native_ownership_conflict");
  const result = { ...value, siteRoot, contentRoot, publicRoot, dataRoot, privateRoot: path.resolve(privateRoot) };
  if (JSON.stringify(result).includes(config.connectionSecret)) throw sourceMoveProblem("metadata_unavailable");
  return result;
}
async function nativeInputs(config) {
  const inputs = [...new Set([...config.inputs.map((file) => path.resolve(config.siteRoot, file)),
    fileURLToPath(new URL("../layouts/partials/discussionbridge/source-article.html", import.meta.url))])].sort();
  const result = [];
  for (const file of inputs) { const bytes = await readRegular(file); if (bytes === null) throw sourceMoveProblem("native_source_public_profile_unresolved"); result.push({ path: file, sha256: sourceDigest(bytes) }); }
  return result;
}
async function checkInputs(entry) {
  for (const input of entry.inputs) { const bytes = await readRegular(input.path); if (bytes === null || sourceDigest(bytes) !== input.sha256) throw sourceMoveProblem("native_local_edit_conflict"); }
}
function configBinding(config, inputs) {
  return sourceDigest(Buffer.from(nativeSemanticJson({ siteRoot: config.siteRoot, contentRoot: config.contentRoot, publicRoot: config.publicRoot, dataRoot: config.dataRoot,
    profile: config.profile, artifactPattern: config.artifactPattern, build: config.build, deploy: config.deploy, inputs })));
}
const dataFile = (config, nativeId) => path.join(config.dataRoot, "discussionbridge_source_moves", `${sourceDigest(nativeId)}.json`);
function nativeArtifact(config, url) {
  const parsed = new URL(url); if (parsed.search || parsed.hash) throw sourceMoveProblem("native_source_public_profile_unresolved");
  const relative = config.artifactPattern.replaceAll("{url_path}", parsed.pathname.replace(/^\//u, "").replace(/\/$/u, ""));
  if (/[{}]/u.test(relative)) throw sourceMoveProblem("native_source_public_profile_unresolved");
  return nativePath(config.publicRoot, relative);
}
function assertCurrentRecord(record, operation, baseline) {
  validateCms("Record", record);
  if (record.direction !== "to_discourse" || record.state !== "active" || record.resource_id !== operation.resourceId || record.topic_id !== operation.topicId
      || record.external_id !== operation.externalId || record.canonical_url !== baseline.canonical_url || record.source_revision !== baseline.source_revision) throw sourceMoveProblem("revision_conflict");
}
async function sourceSnapshot(page, baseline, capture, privateRoot, allowUpdatedAt = false) {
  const original = await readSourceCapture(privateRoot, capture), preparedOriginal = prepareNativeToSource(original.toString("utf8"), capture.source_article_url);
  const current = prepareNativeToSource(page.content_html, capture.source_article_url);
  if (preparedOriginal.losses.length || current.losses.length || current.html !== preparedOriginal.html) throw sourceMoveProblem("native_source_public_profile_unresolved");
  const complete = Buffer.from(current.html);
  if (complete.length !== baseline.source_content_bytes || sourceDigest(complete) !== baseline.source_content_sha256
      || page.title !== baseline.title || semanticIdentity(page.source_authors ?? []) !== semanticIdentity(baseline.source_authors ?? [])
      || (page.primary_source_author_id ?? null) !== (baseline.primary_source_author_id ?? null)
      || (page.native_source_created_at ?? null) !== baseline.source_created_at
      || !allowUpdatedAt && (page.native_source_updated_at ?? null) !== baseline.source_updated_at
      || page.external_id !== baseline.external_id || page.mode !== "to_discourse" || page.published !== true || page.native_publication === true) throw sourceMoveProblem("native_local_edit_conflict");
  return complete;
}
async function checkOwnedFiles(entry, operation, config, expected = "after") {
  const source = nativePath(config.contentRoot, operation.toNativeBinding.source_file), bytes = await readRegular(source);
  if (bytes === null || sourceDigest(bytes) !== (expected === "after" ? entry.after_file.sha256 : entry.before.file.sha256)) throw sourceMoveProblem("native_local_edit_conflict");
  const data = await readRegular(dataFile(config, entry.before.source_file));
  const expectedData = expected === "before" ? entry.before.public_data?.sha256 ?? null
    : entry.public_data && !["captured", "applying_data"].includes(entry.phase) ? entry.public_data.blob.sha256 : entry.before.public_data?.sha256 ?? null;
  if ((data === null ? null : sourceDigest(data)) !== expectedData) throw sourceMoveProblem("native_local_edit_conflict");
  await checkInputs(entry); return source;
}
async function currentMoveAuthority(client, connection, operation, baseline) {
  const current = (await client.request("V4-01")).value;
  if (current.profile !== "hugo" || current.connection_id !== connection.connection_id || !current.directions.includes("to_discourse")
      || current.destination_origin !== connection.destination_origin || current.scope_revision !== connection.scope_revision
      || current.publication_lane !== connection.publication_lane) throw sourceMoveProblem("scope_denied");
  assertCurrentRecord((await client.request("V4-04", { path: { resource_id: operation.resourceId } })).value, operation, baseline);
}
function receiptFor(operation, config, entry, { canonicalUrl, sourceRevision, sourceFileSha, updatedAt, publicDataSha, challenge }) {
  return { schema_version: "db-hugo-to-source-receipt-1", verification_profile: HUGO_TO_SOURCE_PROFILE,
    binding: { connection_id: operation.toBinding.connection_id, forum_origin: operation.toBinding.forum_origin, site_root: config.siteRoot, content_root: config.contentRoot,
      scope_revision: entry.scope.scope_revision, lane: entry.scope.publication_lane },
    resource_id: operation.resourceId, topic_id: operation.topicId, external_id: operation.externalId, native_id: operation.toNativeBinding.source_file,
    canonical_url: canonicalUrl, source_revision: sourceRevision, source_file_sha256: sourceFileSha, source_content_sha256: entry.before.record.source_content_sha256,
    source_content_bytes: entry.before.record.source_content_bytes, title: entry.before.record.title, source_authors: entry.before.record.source_authors ?? [],
    source_created_at: entry.before.record.source_created_at, source_updated_at: updatedAt,
    capture: { birth: entry.before.capture, native_before: entry.before.native_rendered,
      native_after: entry.restoration?.native_rendered ?? entry.captured?.native_rendered ?? entry.before.native_rendered, prepared: entry.prepared_article }, native_inputs_sha256: entry.binding,
    public_data_sha256: publicDataSha, move_id: challenge?.move_id ?? null, proof_nonce: challenge?.proof_nonce ?? null };
}
function commandContinuation(entry, save) {
  return { async nativeRecord(name, value) {
    const prior = entry.commands.find((record) => record.name === name);
    if (value === undefined) return prior?.value ?? null;
    if (prior) prior.value = value; else entry.commands.push({ name, value }); await save();
  } };
}
async function runSourceCommand(kind, entry, config, save, assertFence, transaction = entry.prepare.request.mutation_id, sourceUrl = entry.move.new_url) {
  const receiptPath = nativePath(config.privateRoot, `source-moves/${transaction}/deployment.json`);
  await runCmsNativeCommand({ kind, transactionId: transaction, command: config[kind], values: { transaction_id: transaction, site_root: config.siteRoot,
    public_root: config.publicRoot, receipt_path: receiptPath, source_file: entry.before.source_file, source_url: sourceUrl, move_id: entry.move.move_id },
    continuation: commandContinuation(entry, save), assertFence });
  return receiptPath;
}
async function deploymentAt(file, notBefore, secret) {
  const bytes = await readRegular(file); if (bytes === null || bytes.length > 262144) throw sourceMoveProblem("native_service_unavailable");
  const value = parseCmsJson(bytes, { maximumBytes: 262144 });
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "deployment_id") || !Object.hasOwn(value, "deployed_at") || JSON.stringify(value).includes(secret)) throw sourceMoveProblem("native_service_unavailable");
  validateCms("OpaqueId", value.deployment_id); validateCms("Instant", value.deployed_at);
  if (value.deployed_at < notBefore) throw sourceMoveProblem("native_service_unavailable"); return value;
}

export async function moveToSourceUrl({ operation, page, newUrl, config: connectionConfig, privateRoot, connection, client, save, assertFence, capturePage, publicFetch = fetch, now = Date.now, abortMove = false }) {
  validateCms("Url", newUrl); const config = sourceMoveConfiguration(connectionConfig, privateRoot);
  if (!operation.lastToRequest || !operation.lastToResponse || !operation.toSourceCapture || !operation.toNativeBinding
      || operation.pendingToMutation || operation.pendingToWithdrawal || operation.toWithdrawn || operation.rejectedToIntent) throw sourceMoveProblem();
  if (connection.profile !== "hugo" || !connection.directions.includes("to_discourse") || connection.connection_id !== operation.toBinding.connection_id
      || new URL(connection.destination_origin).origin !== new URL(newUrl).origin || client.origin !== operation.toBinding.forum_origin
      || operation.toNativeBinding.site_root !== config.siteRoot || operation.toNativeBinding.content_root !== config.contentRoot
      || operation.toNativeBinding.lane !== connection.publication_lane || page.native_source_file !== operation.toNativeBinding.source_file) throw sourceMoveProblem("scope_denied");
  let entry = operation.sourceMoves?.pending;
  const inputs = await nativeInputs(config), binding = configBinding(config, inputs);
  const scope = { connection_id: connection.connection_id, scope_revision: connection.scope_revision, publication_lane: connection.publication_lane,
    destination_origin: connection.destination_origin, forum_origin: client.origin };
  if (entry && (entry.binding !== binding || entry.prepare.request.new_url !== newUrl || semanticIdentity(entry.scope) !== semanticIdentity(scope))) throw sourceMoveProblem();
  const baseline = currentToSourceRecord(operation);
  if (abortMove && !entry) throw sourceMoveProblem();
  if (!entry) {
    if (newUrl === baseline.canonical_url || page.canonical_url !== baseline.canonical_url || operation.acceptedSourceRevision !== baseline.source_revision) throw sourceMoveProblem("revision_conflict");
    await assertFence(); const current = (await client.request("V4-04", { path: { resource_id: operation.resourceId } })).value; assertCurrentRecord(current, operation, baseline);
    const complete = await sourceSnapshot(page, baseline, operation.toSourceCapture, config.privateRoot);
    const source = nativePath(config.contentRoot, page.native_source_file), before = await readRegular(source);
    if (before === null || sourceDigest(before) !== page.native_source_sha256 || page.native_source_sha256 !== operation.toNativeBinding.source_sha256) throw sourceMoveProblem("native_local_edit_conflict");
    const after = patchNativeSourceUrl(before, newUrl), mutation = randomUUID(), revision = randomUUID();
    if (after.equals(before)) throw sourceMoveProblem("native_source_public_profile_unresolved");
    projectSourceMoveRecord(baseline, newUrl, revision, baseline.source_updated_at); nativeArtifact(config, newUrl);
    const priorData = await readRegular(dataFile(config, page.native_source_file)), active = operation.currentSourceMove
      && operation.sourceMoves.history.find((item) => item.move.move_id === operation.currentSourceMove.move_id);
    if (priorData !== null && (!active || sourceDigest(priorData) !== active.public_data.blob.sha256)) throw sourceMoveProblem("native_ownership_conflict");
    entry = { schema_version: "db-hugo-to-source-move-1", phase: "prepare_intent",
      prepare: { request: { mutation_id: mutation, expected_source_revision: baseline.source_revision, old_url: baseline.canonical_url, new_url: newUrl, external_id: operation.externalId } },
      before: { record: structuredClone(baseline), current, capture: structuredClone(operation.toSourceCapture), native_binding: structuredClone(operation.toNativeBinding), source_file: page.native_source_file,
        native_rendered: await keepSourceMoveBlob(config.privateRoot, mutation, "native-before.html", Buffer.from(page.content_html)),
        file: await keepSourceMoveBlob(config.privateRoot, mutation, "authored-before.bin", before),
        public_data: priorData === null ? null : await keepSourceMoveBlob(config.privateRoot, mutation, "public-data-before.json", priorData) },
      after_file: await keepSourceMoveBlob(config.privateRoot, mutation, "authored-after.bin", after),
      prepared_article: await keepSourceMoveBlob(config.privateRoot, mutation, "complete-prepared.html", complete), binding, scope, inputs, new_revision: revision, commands: [] };
    operation.sourceMoves ??= { pending: null, history: [] }; operation.sourceMoves.pending = entry; await save();
  }
  const context = { operation, page, entry, config, connectionConfig, connection, client, save, assertFence, capturePage, publicFetch, now };
  if (entry.phase === "abort_intent") return finishSourceAbort(context);
  if (abortMove) return abortNativeSourceMove(context, entry.phase !== "prepared");
  try { return await continueToSourceMove(context); }
  catch (error) {
    const knownPreservationRejection = error instanceof CmsReceiverRejection && entry.rejection?.error.code === "content_preservation_unavailable";
    const knownPublicMismatch = error.code === "public_verification_failed" && ["applied", "built", "deployed"].includes(entry.phase)
      && entry.commands.every((command) => command.value.phase === "completed");
    if (knownPreservationRejection || knownPublicMismatch) {
      entry.failure_code = knownPreservationRejection ? "content_preservation_unavailable" : "public_verification_failed"; await save();
      await abortNativeSourceMove(context, true);
    }
    throw error;
  }
}

async function continueToSourceMove({ operation, page, entry, config, connectionConfig, connection, client, save, assertFence, capturePage, publicFetch, now }) {
  // Remaining phases are deliberately centralized in this same source engine;
  // exact request trees and command outcomes are saved before side effects.
  if (["attention", "rejected", "applying_file", "applying_data"].includes(entry.phase)) throw sourceMoveProblem();
  if (entry.phase === "prepare_intent") {
    await checkOwnedFiles(entry, operation, config, "before"); await currentMoveAuthority(client, connection, operation, entry.before.record); await assertFence();
    const response = (await client.request("V4-28", { path: { resource_id: operation.resourceId }, body: entry.prepare.request })).value;
    if (response.resource_id !== operation.resourceId || response.expected_source_revision !== entry.before.record.source_revision || response.old_url !== entry.prepare.request.old_url
        || response.new_url !== entry.prepare.request.new_url || response.state !== "prepared") throw sourceMoveProblem("identity_conflict");
    entry.prepare.response = response; entry.move = response; entry.phase = "prepared"; await save();
  }
  if (entry.phase === "prepared") {
    const source = await checkOwnedFiles(entry, operation, config, "before");
    await currentMoveAuthority(client, connection, operation, entry.before.record);
    entry.phase = "applying_file"; await save();
    await sourceMoveFileCas(source, entry.before.file.sha256, await readSourceMoveBlob(config.privateRoot, entry.after_file), assertFence);
    entry.phase = "applied_file"; await save();
  }
  if (entry.phase === "applied_file") {
    await checkOwnedFiles(entry, operation, config); const current = await capturePage();
    if (current.native_source_sha256 !== entry.after_file.sha256 || current.native_source_file !== entry.before.source_file || current.canonical_url !== entry.move.new_url) throw sourceMoveProblem("native_source_public_profile_unresolved");
    await sourceSnapshot(current, entry.before.record, entry.before.capture, config.privateRoot, true);
    entry.projected_record = projectSourceMoveRecord(entry.before.record, entry.move.new_url, entry.new_revision, current.native_source_updated_at ?? null);
    entry.captured = { canonical_url: current.canonical_url, source_sha256: current.native_source_sha256, source_updated_at: current.native_source_updated_at ?? null,
      native_rendered: await keepSourceMoveBlob(config.privateRoot, entry.prepare.request.mutation_id, "native-after.html", Buffer.from(current.content_html)) };
    entry.phase = "captured"; await save();
  }
  if (entry.phase === "captured") {
    await checkOwnedFiles(entry, operation, config);
    const complete = await readSourceMoveBlob(config.privateRoot, entry.prepared_article);
    const data = { profile: HUGO_TO_SOURCE_PROFILE, resource_id: operation.resourceId, topic_id: operation.topicId, external_id: operation.externalId,
      native_id: entry.before.source_file, canonical_url: entry.move.new_url, source_revision: entry.new_revision, source_file_sha256: entry.after_file.sha256,
      source_content_sha256: entry.before.record.source_content_sha256, source_authors_sha256: sourceDigest(Buffer.from(nativeSemanticJson(entry.before.record.source_authors ?? []))),
      title: entry.before.record.title, move_id: entry.move.move_id, proof_nonce: entry.move.proof_nonce, article_html: complete.toString("utf8") };
    const bytes = Buffer.from(JSON.stringify(data) + "\n");
    entry.public_data = { file: dataFile(config, entry.before.source_file), blob: await keepSourceMoveBlob(config.privateRoot, entry.prepare.request.mutation_id, "public-data-after.json", bytes),
      before_sha256: entry.before.public_data?.sha256 ?? null };
    entry.receipt = receiptFor(operation, config, entry, { canonicalUrl: entry.move.new_url, sourceRevision: entry.new_revision, sourceFileSha: entry.after_file.sha256,
      updatedAt: entry.captured.source_updated_at, publicDataSha: entry.public_data.blob.sha256, challenge: entry.move });
    entry.phase = "applying_data"; await save();
    await sourceMoveFileCas(dataFile(config, entry.before.source_file), entry.public_data.before_sha256, bytes, assertFence);
    entry.phase = "applied"; await save();
  }
  if (entry.phase === "applied") {
    await checkOwnedFiles(entry, operation, config); await currentMoveAuthority(client, connection, operation, entry.before.record);
    await runSourceCommand("build", entry, config, save, assertFence);
    const html = await readRegular(nativeArtifact(config, entry.move.new_url));
    const frame = ownedToSourceArticle(html, entry.receipt, await readSourceMoveBlob(config.privateRoot, entry.prepared_article));
    entry.native_publication_sha256 = frame.sha256;
    entry.built_article = await keepSourceMoveBlob(config.privateRoot, entry.prepare.request.mutation_id, "native-built-page.html", html);
    entry.phase = "built"; await save();
  }
  if (entry.phase === "built") {
    await checkOwnedFiles(entry, operation, config); await currentMoveAuthority(client, connection, operation, entry.before.record);
    const receiptFile = await runSourceCommand("deploy", entry, config, save, assertFence);
    const build = entry.commands.find((record) => record.value.kind === "build");
    entry.deployment = await deploymentAt(receiptFile, build.value.completed_at, connectionConfig.connectionSecret);
    entry.phase = "deployed"; await save();
  }
  if (entry.phase === "deployed") {
    await checkOwnedFiles(entry, operation, config);
    entry.verification = await verifyToSourcePublic({ receipt: entry.receipt, completeArticle: await readSourceMoveBlob(config.privateRoot, entry.prepared_article),
      expectedHtml: await readSourceMoveBlob(config.privateRoot, entry.built_article), publicFetch, notBefore: entry.deployment.deployed_at, now });
    entry.phase = "verified"; await save();
  }
  if (entry.phase === "verified") {
    await checkOwnedFiles(entry, operation, config);
    assertCurrentRecord((await client.request("V4-04", { path: { resource_id: operation.resourceId } })).value, operation, entry.before.record);
    entry.finalize = { request: { mutation_id: randomUUID(), move_id: entry.move.move_id, proof_nonce: entry.move.proof_nonce,
      expected_source_revision: entry.before.record.source_revision, verification: entry.verification, new_source_revision: entry.new_revision,
      source_updated_at: entry.captured.source_updated_at } };
    validateCms("SourceUrlMoveFinalize", entry.finalize.request); entry.phase = "finalize_intent"; await save();
  }
  if (entry.phase === "finalize_intent") {
    await checkOwnedFiles(entry, operation, config); await assertFence();
    if (entry.finalize.dispatched) await reconcilePendingSourceFinalize({ entry, operation, config, client, publicFetch, now });
    entry.finalize.dispatched = true; await save();
    let response;
    try { response = (await client.request("V4-29", { path: { resource_id: operation.resourceId, move_id: entry.move.move_id }, body: entry.finalize.request })).value; }
    catch (error) {
      if (error instanceof CmsReceiverRejection && error.rejection.route_id === "V4-29") {
        entry.rejection = structuredClone(error.rejection); entry.phase = "rejected"; await save();
      }
      throw error;
    }
    if (response.direction !== "to_discourse" || response.state !== "active" || response.resource_id !== operation.resourceId || response.topic_id !== operation.topicId
        || response.external_id !== operation.externalId || response.canonical_url !== entry.move.new_url || response.source_revision !== entry.new_revision
        || response.source_created_at !== entry.before.record.source_created_at || response.source_updated_at !== entry.captured.source_updated_at) throw sourceMoveProblem("identity_conflict");
    entry.finalize.response = response; entry.phase = "committed";
    operation.sourceMoves.history.push(structuredClone(entry)); operation.sourceMoves.pending = null;
    operation.currentSourceMove = { move_id: entry.move.move_id }; operation.canonicalUrl = response.canonical_url; operation.acceptedSourceRevision = response.source_revision;
    operation.toNativeBinding.source_sha256 = entry.after_file.sha256; operation.toNativeBinding.source_revision = response.source_revision;
    operation.toNativeBinding.scope_revision = connection.scope_revision;
    operation.toNativeBinding.policy_revision = connection.policy.policy_revision; // observed provenance, never a To gate
    operation.outcome = "resolved"; operation.retryable = false; operation.reconciliationRequired = false;
    await save(); return { record: response, move_id: entry.move.move_id, verification: entry.verification };
  }
  throw sourceMoveProblem();
}

async function reconcilePendingSourceFinalize({ entry, operation, config, client, publicFetch, now }) {
  const current = (await client.request("V4-04", { path: { resource_id: operation.resourceId } })).value;
  if (current.resource_id !== operation.resourceId || current.topic_id !== operation.topicId || current.external_id !== operation.externalId || current.state !== "active") throw sourceMoveProblem("native_ownership_conflict");
  if (current.source_revision === entry.new_revision && current.canonical_url === entry.move.new_url) {
    let cursor, found = false; const seen = new Set();
    for (let count = 0; count < 100; count++) {
      const history = (await client.request("V4-31", { path: { resource_id: operation.resourceId }, query: cursor === undefined ? {} : { cursor } })).value;
      if (history.items.some((item) => item.move_id === entry.move.move_id && item.url === entry.move.old_url)) found = true;
      if (history.next_cursor === null) break;
      if (seen.has(history.next_cursor) || count === 99) throw sourceMoveProblem("cursor_invalid"); seen.add(history.next_cursor); cursor = history.next_cursor;
    }
    if (!found) throw sourceMoveProblem();
  } else if (current.source_revision !== entry.before.record.source_revision || current.canonical_url !== entry.move.old_url) throw sourceMoveProblem("revision_conflict");
  // Current GET/history cannot fabricate acceptance. Re-observe actual native
  // public state, then replay ONLY the original exact29 to obtain its receipt.
  await verifyToSourcePublic({ receipt: entry.receipt, completeArticle: await readSourceMoveBlob(config.privateRoot, entry.prepared_article),
    expectedHtml: await readSourceMoveBlob(config.privateRoot, entry.built_article), publicFetch, notBefore: entry.deployment.deployed_at, now });
}

function sourcePublicData(operation, entry, canonicalUrl, revision, fileSha, complete) {
  return { profile: HUGO_TO_SOURCE_PROFILE, resource_id: operation.resourceId, topic_id: operation.topicId, external_id: operation.externalId,
    native_id: entry.before.source_file, canonical_url: canonicalUrl, source_revision: revision, source_file_sha256: fileSha,
    source_content_sha256: entry.before.record.source_content_sha256, source_authors_sha256: sourceDigest(Buffer.from(nativeSemanticJson(entry.before.record.source_authors ?? []))),
    title: entry.before.record.title, move_id: entry.move.move_id, proof_nonce: entry.move.proof_nonce, article_html: complete.toString("utf8") };
}

async function abortNativeSourceMove(context, applied) {
  const { operation, entry, config, connectionConfig, connection, client, save, assertFence, capturePage, publicFetch, now } = context;
  await currentMoveAuthority(client, connection, operation, entry.before.record);
  if (!entry.move || entry.finalize?.dispatched && !entry.rejection) throw sourceMoveProblem();
  let receipt;
  if (applied) {
    if (entry.commands.some((command) => command.value.phase !== "completed")) throw sourceMoveProblem();
    await checkOwnedFiles(entry, operation, config);
    entry.restoration = { transaction_id: randomUUID(), phase: "restoring_file" }; await save();
    await sourceMoveFileCas(nativePath(config.contentRoot, entry.before.source_file), entry.after_file.sha256,
      await readSourceMoveBlob(config.privateRoot, entry.before.file), assertFence);
    entry.restoration.phase = "restored_file"; await save();
    const restored = await capturePage();
    if (restored.canonical_url !== entry.move.old_url || restored.native_source_sha256 !== entry.before.file.sha256) throw sourceMoveProblem();
    await sourceSnapshot(restored, entry.before.record, entry.before.capture, config.privateRoot, true);
    entry.restoration.native_rendered = await keepSourceMoveBlob(config.privateRoot, entry.prepare.request.mutation_id, "native-restored.html", Buffer.from(restored.content_html));
    const complete = await readSourceMoveBlob(config.privateRoot, entry.prepared_article);
    const bytes = Buffer.from(JSON.stringify(sourcePublicData(operation, entry, entry.move.old_url, entry.before.record.source_revision, entry.before.file.sha256, complete)) + "\n");
    const blob = await keepSourceMoveBlob(config.privateRoot, entry.prepare.request.mutation_id, "restored-public-data.json", bytes);
    receipt = receiptFor(operation, config, entry, { canonicalUrl: entry.move.old_url, sourceRevision: entry.before.record.source_revision,
      sourceFileSha: entry.before.file.sha256, updatedAt: restored.native_source_updated_at ?? null, publicDataSha: blob.sha256, challenge: entry.move });
    entry.restoration.public_data = blob; entry.restoration.receipt = receipt; entry.restoration.phase = "restoring_data"; await save();
    await sourceMoveFileCas(dataFile(config, entry.before.source_file), entry.public_data?.blob.sha256 ?? entry.before.public_data?.sha256 ?? null, bytes, assertFence);
    entry.restoration.phase = "rebuilding"; await save();
    await runSourceCommand("build", entry, config, save, assertFence, entry.restoration.transaction_id, entry.move.old_url);
    const html = await readRegular(nativeArtifact(config, entry.move.old_url)); ownedToSourceArticle(html, receipt, complete);
    entry.restoration.built_article = await keepSourceMoveBlob(config.privateRoot, entry.prepare.request.mutation_id, "restored-native-page.html", html);
    const receiptFile = await runSourceCommand("deploy", entry, config, save, assertFence, entry.restoration.transaction_id, entry.move.old_url);
    const build = entry.commands.find((command) => command.value.transaction_id === entry.restoration.transaction_id && command.value.kind === "build");
    entry.restoration.deployment = await deploymentAt(receiptFile, build.value.completed_at, connectionConfig.connectionSecret);
    entry.restoration.verification = await verifyToSourcePublic({ receipt, completeArticle: complete, expectedHtml: html, publicFetch,
      notBefore: entry.restoration.deployment.deployed_at, now });
    entry.restoration.phase = "verified_old"; await save();
  } else {
    await checkOwnedFiles(entry, operation, config, "before");
    if (entry.phase !== "prepared" || entry.commands.length) throw sourceMoveProblem();
    receipt = receiptFor(operation, config, entry, { canonicalUrl: entry.move.old_url, sourceRevision: entry.before.record.source_revision,
      sourceFileSha: entry.before.file.sha256, updatedAt: entry.before.record.source_updated_at, publicDataSha: entry.before.public_data?.sha256 ?? null, challenge: null });
  }
  entry.abort = { request: { mutation_id: randomUUID(), move_id: entry.move.move_id, expected_source_revision: entry.before.record.source_revision,
    native_change_applied: applied, old_url: entry.move.old_url, native_ownership_receipt_sha256: hashToSourceReceipt(receipt) }, receipt };
  entry.phase = "abort_intent"; await save();
  return finishSourceAbort(context);
}

async function finishSourceAbort({ entry, operation, config, client, save, assertFence }) {
  await assertFence(); await checkInputs(entry);
  const source = await readRegular(nativePath(config.contentRoot, entry.before.source_file));
  const data = await readRegular(dataFile(config, entry.before.source_file));
  if (source === null || sourceDigest(source) !== entry.before.file.sha256
      || (data === null ? null : sourceDigest(data)) !== (entry.abort.request.native_change_applied ? entry.restoration.public_data.sha256 : entry.before.public_data?.sha256 ?? null)) throw sourceMoveProblem();
  const response = (await client.request("V4-30", { path: { resource_id: operation.resourceId, move_id: entry.move.move_id }, body: entry.abort.request })).value;
  if (response.move_id !== entry.move.move_id || response.resource_id !== operation.resourceId || response.old_url !== entry.move.old_url
      || response.new_url !== entry.move.new_url || response.state !== (entry.abort.request.native_change_applied ? "attention" : "aborted")) throw sourceMoveProblem("identity_conflict");
  entry.abort.response = response; entry.phase = entry.abort.request.native_change_applied ? "attention" : "aborted";
  operation.reconciliationRequired = entry.abort.request.native_change_applied;
  if (entry.phase === "aborted") { operation.sourceMoves.history.push(structuredClone(entry)); operation.sourceMoves.pending = null; }
  await save(); return { move: response, native_change_applied: entry.abort.request.native_change_applied };
}
