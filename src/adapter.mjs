import { createHash, randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { readRegular, durableDirectory, syncDirectory } from "./native-io.mjs";
import { assertCmsSafePath } from "./native-lock.mjs";
import { prepareNativeToSource, preserveSourceCapture } from "./source-preparation.mjs";
import { retrieveSimple } from "./public-core.mjs";
import { withHugoNativeWriter } from "./cms-native-authority.mjs";
import { assertCurrentNativeTo, authorizeTo, captureToNative, reconcileRejectedToIntent, resolveTo, toInventory,
  assertFreshToRetryBinding, assertUnchangedToRetrySnapshot } from "./to-source.mjs";
import { sweepToWithdrawals } from "./to-withdrawal.mjs";
import { moveToSourceUrl } from "./to-source-move.mjs";
import { retireToSourceCache, sourceMoveProblem } from "./to-source-move-state.mjs";
import { beginAttempt, completeAttempt, failAttempt, readOperationalState, summarizeOperationalState, withOperationalStateLock, writeOperationalState,
  rejectedToCode, stageOperatorRetry } from "./operational-state.mjs";
import { assertLocalRetryAction } from "./to-retry-action.mjs";
import { parseCmsJson, validateCms, semanticIdentity } from "./protocol-v4/cms-runtime.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const attention = (code) => Object.assign(new Error(`Hugo V4 ${code}; current native source requires attention.`), { code });
const origin = (value) => { validateCms("Url", value); const url = new URL(value); if (url.pathname !== "/" || url.search || url.hash) throw attention("scope_denied"); return url.origin; };
function parsePages(manifest, state) {
  const site = origin(manifest.site_origin); if (!Array.isArray(manifest.pages)) throw attention("invalid_field");
  const keys = new Set(), identities = new Set(), urls = new Set();
  const pages = manifest.pages.map((raw) => {
    if (!raw || typeof raw.key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(raw.key) || keys.has(raw.key)) throw attention("identity_conflict");
    keys.add(raw.key); if (!["to_discourse", "simple", "full", "interactive"].includes(raw.mode)) throw attention("presentation_unsupported");
    validateCms("Url", raw.canonical_url); if (new URL(raw.canonical_url).origin !== site || urls.has(raw.canonical_url)) throw attention("scope_denied"); urls.add(raw.canonical_url);
    validateCms("Title", raw.title); const page = { ...raw };
    if (raw.mode === "to_discourse") {
      if (raw.published !== true || raw.native_publication === true) throw attention("source_ineligible");
      if (typeof raw.content_html !== "string" || !raw.content_html.isWellFormed()) throw attention("invalid_field");
      const prior = Object.values(state.operations).find((operation) => operation.pageKey === raw.key);
      const capturedBase = prior?.currentSourceMove && raw.native_source_sha256 === prior.toNativeBinding?.source_sha256
        ? prior.toSourceCapture.source_article_url : raw.canonical_url;
      const preparation = prepareNativeToSource(raw.content_html, capturedBase);
      page.full_content_html = preparation.html; page.preparation_losses = preparation.losses;
      page.external_id = raw.external_id ?? prior?.externalId ?? `hugo-page:${hash(raw.canonical_url)}`;
      validateCms("OpaqueId", page.external_id); if (identities.has(page.external_id) || prior && prior.externalId !== page.external_id) throw attention("identity_conflict"); identities.add(page.external_id);
      if (prior?.toNativeBinding && prior.toNativeBinding.source_file !== raw.native_source_file) throw attention("native_ownership_conflict");
      page.to_created_at = raw.native_source_created_at ?? null; page.to_updated_at = raw.native_source_updated_at ?? null;
      for (const time of [page.to_created_at, page.to_updated_at]) if (time !== null) validateCms("Instant", time);
      if (page.to_created_at !== null && page.to_updated_at !== null && page.to_updated_at < page.to_created_at) throw attention("invalid_field");
      page.source_authors = raw.source_authors ?? []; validateCms("SourceAuthors", page.source_authors);
      if (raw.primary_source_author_id !== undefined) { validateCms("OpaqueId", raw.primary_source_author_id); if (!page.source_authors.some((author) => author.id === raw.primary_source_author_id)) throw attention("invalid_field"); }
      if (raw.topic_id !== undefined) { validateCms("CoreId", raw.topic_id); page.existing_topic_id = raw.topic_id; }
    } else if (raw.topic_id !== undefined) validateCms("CoreId", raw.topic_id);
    return page;
  });
  return { site, pages };
}
async function atomicOutput(file, value) {
  await assertCmsSafePath(file); await durableDirectory(path.dirname(file));
  const before = await readRegular(file), temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); } finally { await handle.close(); }
    const current = await readRegular(file);
    if ((before === null ? null : hash(before)) !== (current === null ? null : hash(current))) throw attention("native_local_edit_conflict");
    await rename(temp, file); await syncDirectory(path.dirname(file));
  } finally { await rm(temp, { force: true }); }
}
export async function prepare({ manifestPath, outputPath, statePath, config, fetchImpl = fetch, captureNative = captureToNative }) {
  if (!statePath || !config.toNative || ["toTransport", "nativeTransport", "toInitializeKey"].some((field) => Object.hasOwn(config, field))) throw attention("invalid_field");
  return withOperationalStateLock(statePath, async (sourceFence) => {
    const state = await readOperationalState(statePath); const save = () => writeOperationalState(statePath, state);
    const manifest = await captureNative({ manifestPath, statePath, config, state, save, assertFence: sourceFence });
    const { site, pages } = parsePages(manifest, state); const { client, connection } = await authorizeTo(config, site, fetchImpl);
    return withHugoNativeWriter({ nativeRoot: config.toNative.contentRoot ?? path.join(config.toNative.siteRoot, "content"), connection,
      forumOrigin: client.origin, privateRoot: path.dirname(path.resolve(statePath)) }, async (writerFence) => {
      const assertFence = async () => { await sourceFence(); await writerFence(); };
      for (const operation of Object.values(state.operations)) await retireToSourceCache(operation, save, assertFence);
      await sweepToWithdrawals({ pages, census: manifest.private_lifecycle, config, state, client, connection, save, assertFence });
      const inventory = await toInventory(client), output = Object.create(null);
      for (const page of pages) {
        if (page.mode !== "to_discourse") {
          if (page.topic_id !== undefined) {
            const topic_url = `${client.origin}/t/${page.topic_id}`;
            output[page.key] = page.mode === "simple" ? await retrieveSimple(page, config, fetchImpl) : { topic_id: page.topic_id, topic_url, forum_origin: client.origin };
          }
          continue;
        }
        const prior = Object.hasOwn(state.operations, page.external_id) ? state.operations[page.external_id] : undefined;
        if (prior?.toWithdrawn || prior?.pendingToWithdrawal) continue;
        if (prior?.sourceMoves?.pending) continue;
        await assertFence(); await assertCurrentNativeTo(page, config);
        const bytes = Buffer.from(page.content_html), sourcePin = { source_id: page.external_id, source_revision: page.native_source_sha256,
          content_bytes: bytes.length, content_sha256: hash(bytes) }; // Private capture/file pin, not a wire source edition.
        page.source_capture = await preserveSourceCapture(path.dirname(path.resolve(statePath)), sourcePin, bytes, page.canonical_url);
        if (page.preparation_losses.length) {
          state.sourceLimitations ??= Object.create(null);
          Object.defineProperty(state.sourceLimitations, page.external_id, { enumerable: true, writable: true, configurable: true, value: {
            source_file: page.native_source_file, source_sha256: page.native_source_sha256, content_sha256: sourcePin.content_sha256, content_bytes: bytes.length,
            source_snapshot: page.source_capture.source_snapshot, source_capture: page.source_capture, cause: page.preparation_losses, scope_revision: connection.scope_revision, policy_revision: connection.policy.policy_revision,
            status: "native_source_preparation_unresolved" } });
          await save(); continue; // No receiver resolve, withdrawal, new edition or full-success claim.
        }
        if (state.sourceLimitations && Object.hasOwn(state.sourceLimitations, page.external_id)) {
          state.sourceLimitationHistory ??= []; state.sourceLimitationHistory.push(state.sourceLimitations[page.external_id]);
          delete state.sourceLimitations[page.external_id]; await save();
        }
        // A definitive rejected intent is retained exactly. A normal build is
        // not an automatic retry or proof of a repaired receiver integration.
        if (prior?.rejectedToIntent !== undefined && !await reconcileRejectedToIntent({ page, config, operation: prior, client, connection, inventory, save, assertFence })) continue;
        const operation = beginAttempt(state, { externalId: page.external_id, canonicalUrl: page.canonical_url, pageKey: page.key }); await save();
        try {
          const result = await resolveTo({ page, config, operation, client, connection, inventory, save, assertFence });
          if (result.current_source_record) {
            // This is the actual retained29 Record, not a fabricated02 receipt.
            operation.outcome = "resolved"; operation.retryable = false; operation.reconciliationRequired = false;
            const record = result.current_source_record; output[page.key] = { resource_id: record.resource_id, topic_id: record.topic_id, topic_url: record.topic_url,
              source_revision: record.source_revision, forum_origin: result.forum_origin };
          } else { completeAttempt(operation, result); output[page.key] = result; }
          await save();
        } catch (error) {
          failAttempt(operation, error); await save();
          if (operation.rejectedToIntent !== undefined) continue; // Other sources retain their ordinary authority.
          throw error;
        }
      }
      for (const operation of Object.values(state.operations)) if (!Object.hasOwn(output, operation.pageKey) && operation.lastToResponse) {
        const record = operation.toWithdrawn?.record ?? operation.lastToResponse;
        output[operation.pageKey] = { resource_id: operation.resourceId, topic_id: operation.topicId, topic_url: record.topic_url, forum_origin: client.origin, source_revision: operation.acceptedSourceRevision };
      }
      await assertFence(); await atomicOutput(outputPath, output);
      return { output, status: summarizeOperationalState(state) };
    });
  });
}
// Explicit existing local CLI control, separate from ordinary prepare. It never
// sweeps other sources, creates a new edition or treats a stale action as a new
// retry. A linked uncertain replacement uses the same ordinary exact resolver.
export async function retrySource({ manifestPath, outputPath, statePath, config, pageKey, refusedMutationId, localAction,
  fetchImpl = fetch, captureNative = captureToNative }) {
  const action = assertLocalRetryAction(localAction, { statePath, pageKey, refusedMutationId });
  if (!statePath || !outputPath || !config.toNative || ["toTransport", "nativeTransport", "toInitializeKey"].some((field) => Object.hasOwn(config, field))) throw attention("invalid_field");
  return withOperationalStateLock(statePath, async (sourceFence) => {
    const state = await readOperationalState(statePath), save = () => writeOperationalState(statePath, state);
    const selected = Object.values(state.operations).filter((entry) => entry.pageKey === pageKey);
    if (selected.length !== 1) throw attention("native_ownership_conflict");
    const operation = selected[0], previous = operation.toOperatorRetries?.find((entry) => entry.refused_mutation_id === refusedMutationId);
    if (previous && (operation.pendingToMutation?.request.mutation_id !== previous.replacement_pending.request.mutation_id || operation.rejectedToIntent)) {
      return { retry_action: "already_recorded", replacement_mutation_id: previous.replacement_pending.request.mutation_id,
        status: summarizeOperationalState(state) };
    }
    if (operation.toWithdrawn || operation.pendingToWithdrawal || operation.sourceMoves?.pending) throw attention("native_ownership_conflict");
    if (!previous && (rejectedToCode(operation.rejectedToIntent) !== "invalid_field"
        || operation.rejectedToIntent.pending.request.mutation_id !== refusedMutationId)) throw attention("native_ownership_conflict");
    const pending = previous?.replacement_pending ?? operation.rejectedToIntent.pending;
    const manifest = await captureNative({ manifestPath, statePath, config, state, save, assertFence: sourceFence });
    const { site, pages } = parsePages(manifest, state), page = pages.find((entry) => entry.key === pageKey && entry.external_id === operation.externalId);
    if (!page) throw attention("source_ineligible");
    const { client, connection } = await authorizeTo(config, site, fetchImpl);
    return withHugoNativeWriter({ nativeRoot: config.toNative.contentRoot ?? path.join(config.toNative.siteRoot, "content"), connection,
      forumOrigin: client.origin, privateRoot: path.dirname(path.resolve(statePath)) }, async (writerFence) => {
      const assertFence = async () => { await sourceFence(); await writerFence(); };
      assertUnchangedToRetrySnapshot(page, connection, pending);
      await assertFence(); await assertCurrentNativeTo(page, config);
      const inventory = await toInventory(client);
      if (!previous) await assertFreshToRetryBinding({ page, config, operation, client, inventory, assertFence });
      else if (semanticIdentity(operation.pendingToMutation) !== semanticIdentity(previous.replacement_pending)) throw attention("native_ownership_conflict");
      if (!previous) {
        const bytes = Buffer.from(page.content_html), pin = { source_id: page.external_id, source_revision: page.native_source_sha256,
          content_bytes: bytes.length, content_sha256: hash(bytes) };
        page.source_capture = await preserveSourceCapture(path.dirname(path.resolve(statePath)), pin, bytes, page.canonical_url);
        await assertFence(); await assertCurrentNativeTo(page, config);
        if (state.sourceLimitations && Object.hasOwn(state.sourceLimitations, page.external_id)) {
          state.sourceLimitationHistory ??= []; state.sourceLimitationHistory.push(state.sourceLimitations[page.external_id]);
          delete state.sourceLimitations[page.external_id];
        }
        stageOperatorRetry(operation, action, { source_file: page.native_source_file, source_sha256: page.native_source_sha256, source_capture: page.source_capture });
        await save(); // ONE old-refusal/action-link/replacement commit BEFORE HTTP.
      }
      try {
        const result = await resolveTo({ page, config, operation, client, connection, inventory, save, assertFence });
        completeAttempt(operation, result); await save();
        const before = await readRegular(outputPath), output = before === null ? Object.create(null)
          : parseCmsJson(before, { maximumBytes: Number.MAX_SAFE_INTEGER });
        if (!output || typeof output !== "object" || Array.isArray(output)) throw attention("native_ownership_conflict");
        Object.defineProperty(output, page.key, { value: result, enumerable: true, writable: true, configurable: true });
        await assertFence(); await atomicOutput(outputPath, output);
        return { retry_action: previous ? "reconciled" : "dispatched", replacement_mutation_id: operation.lastToRequest.mutation_id,
          status: summarizeOperationalState(state) };
      } catch (error) { failAttempt(operation, error); await save(); throw error; }
    });
  });
}
// Public Core snapshots retain a credential-free native path. No V4 connection
// or source publication is introduced just to render a selected discussion.
export async function preparePublicDiscussions({ manifestPath, outputPath, config, fetchImpl = fetch }) {
  const manifest = parseCmsJson(await readRegular(manifestPath), { maximumBytes: Number.MAX_SAFE_INTEGER });
  const { pages } = parsePages(manifest, { operations: {} }); const output = Object.create(null), forum = origin(config.serverUrl);
  for (const page of pages) {
    if (page.mode === "to_discourse") throw attention("source_ineligible");
    if (page.topic_id === undefined) continue;
    output[page.key] = page.mode === "simple" ? await retrieveSimple(page, config, fetchImpl)
      : { topic_id: page.topic_id, topic_url: `${forum}/t/${page.topic_id}`, forum_origin: forum };
  }
  await atomicOutput(outputPath, output); return output;
}

export async function moveSourceUrl({ manifestPath, statePath, config, pageKey, newUrl, fetchImpl = fetch, publicFetch = fetch, captureNative = captureToNative, abortMove = false }) {
  return withOperationalStateLock(statePath, async (sourceFence) => {
    const state = await readOperationalState(statePath), save = () => writeOperationalState(statePath, state);
    const operation = Object.values(state.operations).find((entry) => entry.pageKey === pageKey);
    if (!operation) throw sourceMoveProblem("native_ownership_conflict");
    const pending = operation.sourceMoves?.pending;
    if (pending && (["applying_file", "applying_data", "attention", "rejected"].includes(pending.phase)
        || pending.commands?.some((command) => command.value.phase !== "completed"))) throw sourceMoveProblem();
    const capture = async () => {
      const manifest = await captureNative({ manifestPath, statePath, config, state, save, assertFence: sourceFence });
      const result = parsePages(manifest, state), page = result.pages.find((entry) => entry.key === pageKey);
      if (!page) throw sourceMoveProblem("native_source_public_profile_unresolved"); return { page, site: result.site };
    };
    const initial = await capture(), { client, connection } = await authorizeTo(config, initial.site, fetchImpl);
    return withHugoNativeWriter({ nativeRoot: config.toNative.contentRoot ?? path.join(config.toNative.siteRoot, "content"), connection,
      forumOrigin: client.origin, privateRoot: path.dirname(path.resolve(statePath)) }, async (writerFence) => {
      const assertFence = async () => { await sourceFence(); await writerFence(); };
      return moveToSourceUrl({ operation, page: initial.page, newUrl, config, privateRoot: path.dirname(path.resolve(statePath)), connection, client, save, assertFence,
        capturePage: async () => { await assertFence(); return (await capture()).page; }, publicFetch, abortMove });
    });
  });
}
