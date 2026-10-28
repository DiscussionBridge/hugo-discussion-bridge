import { createHash, randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { readRegular, durableDirectory, syncDirectory } from "./native-io.mjs";
import { withCmsNativeLock, assertCmsSafePath } from "./native-lock.mjs";
import { candidateId, cmsSchemaIdentity, parseCmsJson, semanticIdentity, validateCms, validateCmsResponse } from "./protocol-v4/cms-runtime.mjs";
import { validateSourceCapture } from "./source-preparation.mjs";
import { validateToSourceMoves } from "./to-source-move-state.mjs";
import { validateLocalRetryRecord } from "./to-retry-action.mjs";

export const SOURCE_CANDIDATE = Object.freeze({ candidate_id: candidateId, schema_sha256: cmsSchemaIdentity.sha256,
  runtime_sha256: "e1790fd800abcae9772d327625ea188f04ec68c63ce7917cb0785f5cdea22538" });
export const SOURCE_STATE_IDENTITY = Object.freeze({ wire_version: "v4", state_format: "db-hugo-source-state-1" });
const states = new WeakMap();
const hash = (bytes) => bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
const validDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const exact = (value, fields) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
const failure = () => new Error("Hugo current V4 source ledger needs reconciliation.");
const requestIdentity = (request) => {
  const value = structuredClone(request.bridge_record);
  for (const key of ["source_revision", "expected_source_revision", "adapter_id", "adapter_version", "correlation_id"]) delete value[key];
  return hash(Buffer.from(semanticIdentity(value)));
};
function validateRequest(request, operation, identity, historical = false) {
  validateCms("ToResolve", request);
  if (request.bridge_record.external_id !== operation.externalId || !historical && request.bridge_record.canonical_url !== operation.canonicalUrl || requestIdentity(request) !== identity) throw failure();
}
function validatePendingTo(pending, operation, historical = false) {
  if (!exact(pending, ["identity", "request", "native_evidence"])) throw failure();
  const native = pending.native_evidence;
  if (!exact(native, ["source_file", "source_sha256", ...(Object.hasOwn(native, "source_capture") ? ["source_capture"] : [])])
      || typeof native.source_file !== "string" || path.isAbsolute(native.source_file)
      || native.source_file.split(/[\\/]/u).some((part) => !part || [".", ".."].includes(part))) throw failure();
  validateCms("Sha256", native.source_sha256);
  validateRequest(pending.request, operation, pending.identity, historical);
  if (native.source_capture !== undefined) {
    const capture = validateSourceCapture(native.source_capture);
    if (capture.source_id !== operation.externalId || capture.source_revision !== native.source_sha256
        || capture.source_article_url !== pending.request.bridge_record.canonical_url) throw failure();
  }
}
export const rejectedToCode = (rejected) => rejected?.receiver?.error?.code ?? rejected?.receiver?.code;
function validateRejectedTo(rejected, operation) {
  const witnessed = rejected?.schema_version === "db-hugo-to-rejection-2";
  const receiverFields = witnessed ? ["route_id", "http_status", "code", ...(Object.hasOwn(rejected.receiver ?? {}, "error") ? ["error"] : [])]
    : ["route_id", "http_status", "error"];
  if (!exact(rejected, ["schema_version", "outcome", "pending", "receiver"])
      || !["db-hugo-to-rejection-1", "db-hugo-to-rejection-2"].includes(rejected.schema_version)
      || rejected.outcome !== "rejected" || !exact(rejected.receiver, receiverFields)
      || rejected.receiver.route_id !== "V4-02" || rejected.receiver.http_status !== 422) throw failure();
  validatePendingTo(rejected.pending, operation, true);
  // Version2 is private already-witnessed typed-refusal evidence, not an import
  // or operator attestation API. Missing historical decoded/raw diagnostics stay
  // UNKNOWN by absence; never synthesize a six-field Error or null correlation.
  if (witnessed && rejected.receiver.code !== "invalid_field") throw failure();
  const envelope = rejected.receiver.error;
  if (witnessed && envelope === undefined) return;
  validateCmsResponse(rejected.receiver.route_id, envelope, rejected.receiver.http_status);
  if (!exact(envelope, ["outcome", "code", "retryable", "retry_after_seconds", "correlation_id", "core_fallback"])
      || envelope.outcome !== "rejected" || envelope.code !== (witnessed ? "invalid_field" : "content_preservation_unavailable") || envelope.retryable !== false
      || envelope.retry_after_seconds !== null || envelope.core_fallback !== false) throw failure();
}

function validateOperatorRetries(operation) {
  if (operation.toOperatorRetries === undefined) return;
  if (!Array.isArray(operation.toOperatorRetries)) throw failure();
  const actions = new Set(), refusedIds = new Set(), replacements = new Set();
  for (const entry of operation.toOperatorRetries) {
    if (!exact(entry, ["schema_version", "action", "refused_mutation_id", "replacement_pending"])
        || entry.schema_version !== "db-hugo-to-operator-retry-1") throw failure();
    validateLocalRetryRecord(entry.action); validateCms("UUID", entry.refused_mutation_id);
    validatePendingTo(entry.replacement_pending, operation, true);
    const replacement = entry.replacement_pending.request.mutation_id;
    const refused = operation.rejectedToHistory?.find((saved) => saved.pending.request.mutation_id === entry.refused_mutation_id);
    if (!refused || rejectedToCode(refused) !== "invalid_field" || entry.action.refused_mutation_id !== entry.refused_mutation_id
        || entry.action.page_key !== operation.pageKey || actions.has(entry.action.action_id) || refusedIds.has(entry.refused_mutation_id)
        || replacements.has(replacement) || replacement === entry.refused_mutation_id
        || semanticIdentity(refused.pending.request.bridge_record) !== semanticIdentity(entry.replacement_pending.request.bridge_record)
        || refused.pending.native_evidence.source_file !== entry.replacement_pending.native_evidence.source_file
        || refused.pending.identity !== entry.replacement_pending.identity) throw failure();
    const retainedRequests = [operation.pendingToMutation?.request, operation.lastToRequest,
      ...(operation.toHistory ?? []).map((saved) => saved.request), operation.rejectedToIntent?.pending.request,
      ...(operation.rejectedToHistory ?? []).map((saved) => saved.pending.request)];
    for (const request of retainedRequests) if (request?.mutation_id === replacement
        && semanticIdentity(request) !== semanticIdentity(entry.replacement_pending.request)) throw failure();
    actions.add(entry.action.action_id); refusedIds.add(entry.refused_mutation_id); replacements.add(replacement);
  }
}
function validateNativeBinding(native) {
  if (!exact(native, ["site_root", "content_root", "source_file", "source_sha256", "source_revision", "scope_revision", "policy_revision", "lane"])
      || !path.isAbsolute(native.site_root) || !path.isAbsolute(native.content_root) || typeof native.source_file !== "string" || path.isAbsolute(native.source_file)
      || native.source_file.split(/[\\/]/u).some((part) => !part || [".", ".."].includes(part))) throw failure();
  validateCms("Sha256", native.source_sha256);
  for (const field of ["source_revision", "scope_revision", "policy_revision"]) validateCms("Revision", native[field]);
  validateCms("Lane", native.lane);
}
export function validateOperationalState(value) {
  if (!value?.wireIdentity) throw Object.assign(new Error("Hugo V4 source ledger lacks explicit wire/state-format identity; preserve it for native reconciliation, without automatic retagging."), { code: "native_state_identity_unavailable" });
  if (!value || value.schemaVersion !== 1 || value.adapterId !== "hugo-discussion-bridge" || semanticIdentity(value.wireIdentity) !== semanticIdentity(SOURCE_STATE_IDENTITY)
      || !exact(value.candidate, ["candidate_id", "schema_sha256", "runtime_sha256"])
      || !value.operations || typeof value.operations !== "object" || Array.isArray(value.operations)) throw failure();
  // Immutable creation provenance is evidence, not the active decoder selector.
  validateCms("OpaqueId", value.candidate.candidate_id); validateCms("Sha256", value.candidate.schema_sha256); validateCms("Sha256", value.candidate.runtime_sha256);
  if (value.nativeRoots !== undefined && (!exact(value.nativeRoots, ["site_root", "content_root"]) || !path.isAbsolute(value.nativeRoots.site_root) || !path.isAbsolute(value.nativeRoots.content_root))) throw failure();
  for (const [key, operation] of Object.entries(value.operations)) {
    if (!operation || key !== operation.externalId || !Number.isSafeInteger(operation.attempts) || operation.attempts < 1
        || !["pending", "created", "resolved", "updated", "rejected", "reconciliation_required", "retryable_failure"].includes(operation.outcome)
        || typeof operation.retryable !== "boolean" || typeof operation.reconciliationRequired !== "boolean" || !validDate(operation.lastAttemptAt)
        || operation.lastSuccessAt !== undefined && !validDate(operation.lastSuccessAt)) throw failure();
    validateCms("OpaqueId", operation.externalId); validateCms("Url", operation.canonicalUrl); validateCms("UUID", operation.correlationId);
    if (["toTransport", "toProfile"].some((field) => Object.hasOwn(operation, field))) throw failure();
    if (operation.resourceId !== undefined) validateCms("UUID", operation.resourceId);
    if (operation.topicId !== undefined) validateCms("CoreId", operation.topicId);
    for (const revision of [operation.acceptedSourceRevision, operation.requestedSourceRevision, operation.requestedPreviousRevision]) if (revision !== undefined && revision !== null) validateCms("Revision", revision);
    if (operation.pendingToMutation !== undefined) {
      const pending = operation.pendingToMutation; validatePendingTo(pending, operation);
      if (operation.requestedSourceRevision !== pending.request.bridge_record.source_revision || operation.requestedPreviousRevision !== pending.request.bridge_record.expected_source_revision) throw failure();
    }
    if (operation.rejectedToIntent !== undefined) {
      const rejected = operation.rejectedToIntent;
      validateRejectedTo(rejected, operation);
      if (!operation.pendingToMutation || semanticIdentity(rejected.pending) !== semanticIdentity(operation.pendingToMutation)
          || operation.outcome !== "rejected" || operation.retryable !== false || operation.reconciliationRequired !== true) throw failure();
    }
    if (operation.rejectedToHistory !== undefined) {
      if (!Array.isArray(operation.rejectedToHistory)) throw failure();
      const ids = new Set(operation.rejectedToIntent === undefined ? [] : [operation.rejectedToIntent.pending.request.mutation_id]);
      for (const rejected of operation.rejectedToHistory) {
        validateRejectedTo(rejected, operation);
        if (ids.has(rejected.pending.request.mutation_id)) throw failure();
        ids.add(rejected.pending.request.mutation_id);
      }
    }
    validateOperatorRetries(operation);
    if (operation.lastToRequest !== undefined) {
      validateRequest(operation.lastToRequest, operation, operation.lastToIdentity, operation.currentSourceMove !== undefined);
      if (!operation.currentSourceMove && operation.acceptedSourceRevision !== operation.lastToRequest.bridge_record.source_revision) throw failure();
      validateCms("ResolveResult", operation.lastToResponse);
      if (operation.lastToResponse.resource_id !== operation.resourceId || operation.lastToResponse.topic_id !== operation.topicId
          || operation.lastToResponse.source_revision !== operation.lastToRequest.bridge_record.source_revision) throw failure();
    }
    if (operation.toNativeBinding !== undefined) validateNativeBinding(operation.toNativeBinding);
    if (operation.toSourceCapture !== undefined) {
      const capture = validateSourceCapture(operation.toSourceCapture);
      if (capture.source_id !== operation.externalId || capture.source_article_url !== operation.lastToRequest?.bridge_record.canonical_url) throw failure();
    }
    if (operation.toBinding !== undefined) {
      const binding = operation.toBinding;
      if (!exact(binding, ["connection_id", "forum_origin", "native_origin"])) throw failure();
      validateCms("ConnectionId", binding.connection_id);
      for (const origin of [binding.forum_origin, binding.native_origin]) { validateCms("Url", origin); if (new URL(origin).origin !== origin) throw failure(); }
      if (new URL(operation.canonicalUrl).origin !== binding.native_origin) throw failure();
    }
    for (const withdrawal of [operation.pendingToWithdrawal, operation.toWithdrawn]) if (withdrawal !== undefined) {
      validateCms("WithdrawInput", withdrawal.request);
      if (withdrawal.request.expected_source_revision !== operation.acceptedSourceRevision
          || !exact(withdrawal.native_evidence, ["source_file", "source_sha256", "reason"])
          || withdrawal.native_evidence.reason !== withdrawal.request.reason || withdrawal.native_evidence.source_file !== operation.toNativeBinding?.source_file) throw failure();
      if (withdrawal.native_evidence.source_sha256 !== null) validateCms("Sha256", withdrawal.native_evidence.source_sha256);
      if (withdrawal === operation.pendingToWithdrawal) {
        if (!exact(withdrawal, ["phase", "request", "resource_id", "binding", "native_evidence"]) || !["intent", "dispatched"].includes(withdrawal.phase)
            || withdrawal.resource_id !== operation.resourceId || semanticIdentity(withdrawal.binding) !== semanticIdentity(operation.toBinding)) throw failure();
      } else {
        if (!exact(withdrawal, ["request", "record", "native_evidence"])) throw failure(); validateCms("Record", withdrawal.record);
        if (withdrawal.record.state !== "withdrawn" || withdrawal.record.resource_id !== operation.resourceId || withdrawal.record.topic_id !== operation.topicId
            || withdrawal.record.external_id !== operation.externalId || withdrawal.record.canonical_url !== operation.canonicalUrl || withdrawal.record.source_revision !== operation.acceptedSourceRevision) throw failure();
      }
    }
    if (operation.toHistory !== undefined) {
      if (!Array.isArray(operation.toHistory)) throw failure(); const ids = new Set();
      for (const saved of operation.toHistory) {
        if (!exact(saved, ["request", "identity", "response", ...(Object.hasOwn(saved, "source_capture") ? ["source_capture"] : [])]) || ids.has(saved.request?.mutation_id)) throw failure();
        if (saved.source_capture !== undefined && (validateSourceCapture(saved.source_capture).source_id !== operation.externalId || saved.source_capture.source_article_url !== saved.request.bridge_record.canonical_url)) throw failure();
        validateRequest(saved.request, operation, saved.identity, true); validateCms("ResolveResult", saved.response);
        if (saved.response.source_revision !== saved.request.bridge_record.source_revision || saved.response.resource_id !== operation.resourceId || saved.response.topic_id !== operation.topicId) throw failure();
        ids.add(saved.request.mutation_id);
      }
    }
  }
  for (const operation of Object.values(value.operations)) validateToSourceMoves(operation);
  for (const capture of [value.toCapture, value.toLifecycleCapture]) if (capture !== undefined) {
    const record = capture.value;
    if (!exact(capture, ["name", "value"]) || !exact(record, ["transaction_id", "kind", "command_sha256", "phase", "owner_pid", "process_identity", "completed_at"])
        || record.kind !== "build" || capture.name !== `native/${record.transaction_id}/build.json` || !["intent", "running", "completed"].includes(record.phase)
        || record.owner_pid !== null && (!Number.isSafeInteger(record.owner_pid) || record.owner_pid < 1)
        || record.process_identity !== null && (typeof record.process_identity !== "object" || Array.isArray(record.process_identity))
        || (record.phase === "completed" ? !validDate(record.completed_at) : record.completed_at !== null)) throw failure();
    validateCms("UUID", record.transaction_id); validateCms("Sha256", record.command_sha256);
  }
  for (const limitation of [...Object.values(value.sourceLimitations ?? {}), ...(value.sourceLimitationHistory ?? [])]) {
    if (!exact(limitation, ["source_file", "source_sha256", "content_sha256", "content_bytes", "source_snapshot", "cause", "scope_revision", "policy_revision", "status", ...(Object.hasOwn(limitation, "source_capture") ? ["source_capture"] : [])])
        || typeof limitation.source_file !== "string" || !limitation.source_file || path.isAbsolute(limitation.source_file)
        || limitation.source_file.split(/[\\/]/u).some((part) => !part || [".", ".."].includes(part)) || limitation.status !== "native_source_preparation_unresolved"
        || !/^source-snapshots\/[a-f0-9]{64}\/[a-f0-9]{64}-[a-f0-9]{64}\.html$/u.test(limitation.source_snapshot) || !Array.isArray(limitation.cause)) throw failure();
    validateCms("Sha256", limitation.source_sha256); validateCms("Sha256", limitation.content_sha256); validateCms("UInt", limitation.content_bytes);
    validateCms("Revision", limitation.scope_revision); validateCms("Revision", limitation.policy_revision);
    if (limitation.source_capture !== undefined) {
      const capture = validateSourceCapture(limitation.source_capture);
      if (capture.source_snapshot !== limitation.source_snapshot || capture.content_sha256 !== limitation.content_sha256 || capture.content_bytes !== limitation.content_bytes || capture.source_revision !== limitation.source_sha256) throw failure();
    }
  }
  return value;
}
export function decodeOperationalState(bytes) {
  // Private OS audit identity can contain Windows uid/gid=-1. Keep lexical
  // provenance for nested wire records, which validateOperationalState still
  // validates with their unchanged nonnegative CMS numeric requirements.
  return validateOperationalState(parseCmsJson(bytes, { maximumBytes: Number.MAX_SAFE_INTEGER, rejectInvalidNumbers: false }));
}
export async function readOperationalState(file) {
  const bytes = await readRegular(file);
  const state = bytes === null ? { schemaVersion: 1, adapterId: "hugo-discussion-bridge", wireIdentity: SOURCE_STATE_IDENTITY, candidate: SOURCE_CANDIDATE, operations: Object.create(null) }
    : decodeOperationalState(bytes);
  states.set(state, { file: path.resolve(file), hash: hash(bytes) }); return state;
}
export async function writeOperationalState(file, state) {
  validateOperationalState(state); file = path.resolve(file);
  const prior = states.get(state);
  if (!prior || prior.file !== file || /(?:^|[\\/])(?:public|static|assets|data)(?:[\\/]|$)/iu.test(file)) throw failure();
  await assertCmsSafePath(file); await durableDirectory(path.dirname(file));
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`); let handle;
  try {
    handle = await open(temp, "wx", 0o600); const bytes = Buffer.from(JSON.stringify(state) + "\n");
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    if (hash(await readRegular(file)) !== prior.hash) throw failure();
    await rename(temp, file); await syncDirectory(path.dirname(file)); states.set(state, { file, hash: hash(bytes) });
  } finally { await handle?.close().catch(() => {}); await rm(temp, { force: true }); }
}
export async function withOperationalStateLock(file, action) {
  return withCmsNativeLock(`${path.resolve(file)}.source-writer`, action);
}
export function beginAttempt(state, { externalId, canonicalUrl, pageKey }, now = new Date()) {
  const prior = Object.hasOwn(state.operations, externalId) ? state.operations[externalId] : undefined; if (prior && prior.canonicalUrl !== canonicalUrl) throw failure();
  if (prior?.rejectedToIntent !== undefined) throw Object.assign(new Error("Hugo To retains a definitive rejected intent; no automatic retry."), { code: rejectedToCode(prior.rejectedToIntent) });
  const operation = { ...prior, externalId, canonicalUrl, pageKey, correlationId: prior?.correlationId ?? randomUUID(), attempts: (prior?.attempts ?? 0) + 1,
    outcome: "pending", retryable: false, reconciliationRequired: false, lastAttemptAt: now.toISOString() };
  delete operation.lastError; Object.defineProperty(state.operations, externalId, { value: operation, enumerable: true, writable: true, configurable: true }); return operation;
}
export function completeAttempt(operation, result, now = new Date()) {
  operation.outcome = result.outcome; operation.retryable = false; operation.reconciliationRequired = false;
  operation.resourceId = result.resource_id; operation.topicId = result.topic_id; operation.topicUrl = result.topic_url;
  operation.acceptedSourceRevision = result.source_revision; operation.lastSuccessAt = now.toISOString(); delete operation.lastError;
}
export function failAttempt(operation, error) {
  operation.outcome = operation.rejectedToIntent === undefined ? "reconciliation_required" : "rejected"; operation.retryable = false; operation.reconciliationRequired = true;
  operation.lastError = (error instanceof Error ? error.message : "Native source reconciliation required").replace(/\p{Cc}/gu, " ").slice(0, 500);
}
// Caller holds both native writers and has checked current source/authority/CAS.
// The whole operation, old refusal and action→new intent commit in ONE existing
// atomic ledger replacement. There is never a saved gap with no active intent.
export function stageOperatorRetry(operation, action, nativeEvidence = undefined) {
  validateLocalRetryRecord(action);
  if (action.page_key !== operation.pageKey) throw failure();
  const previous = operation.toOperatorRetries?.find((entry) => entry.refused_mutation_id === action.refused_mutation_id);
  if (previous) return previous;
  const refused = operation.rejectedToIntent;
  if (!refused || rejectedToCode(refused) !== "invalid_field" || action.page_key !== operation.pageKey
      || action.refused_mutation_id !== refused.pending.request.mutation_id || operation.toWithdrawn || operation.pendingToWithdrawal
      || operation.sourceMoves?.pending || !operation.pendingToMutation
      || semanticIdentity(operation.pendingToMutation) !== semanticIdentity(refused.pending)) throw failure();
  validateRejectedTo(refused, operation);
  const pending = structuredClone(refused.pending); pending.request.mutation_id = randomUUID();
  if (nativeEvidence !== undefined) pending.native_evidence = structuredClone(nativeEvidence);
  validatePendingTo(pending, operation);
  if (pending.native_evidence.source_file !== refused.pending.native_evidence.source_file) throw failure();
  const entry = { schema_version: "db-hugo-to-operator-retry-1", action: structuredClone(action),
    refused_mutation_id: action.refused_mutation_id, replacement_pending: structuredClone(pending) };
  operation.rejectedToHistory ??= []; operation.rejectedToHistory.push(structuredClone(refused));
  operation.toOperatorRetries ??= []; operation.toOperatorRetries.push(entry);
  delete operation.rejectedToIntent;
  operation.pendingToMutation = pending; operation.requestedSourceRevision = pending.request.bridge_record.source_revision;
  operation.requestedPreviousRevision = pending.request.bridge_record.expected_source_revision;
  operation.outcome = "pending"; operation.retryable = false; operation.reconciliationRequired = false;
  operation.attempts += 1; operation.lastAttemptAt = action.invoked_at; delete operation.lastError;
  return entry;
}
export function summarizeOperationalState(state) {
  validateOperationalState(state); return { operations: Object.keys(state.operations).length,
    pending: Object.values(state.operations).filter((op) => op.outcome === "pending").length,
    healthy: Object.values(state.operations).filter((op) => ["created", "resolved", "updated"].includes(op.outcome) && !op.pendingToMutation && !op.pendingToWithdrawal
      && !op.toWithdrawn && !op.sourceMoves?.pending && !Object.hasOwn(state.sourceLimitations ?? {}, op.externalId)).length,
    reconciliationRequired: Object.values(state.operations).filter((op) => op.reconciliationRequired || op.pendingToMutation || op.pendingToWithdrawal || op.sourceMoves?.pending).length,
    withdrawn: Object.values(state.operations).filter((op) => op.toWithdrawn).length, local_source_limitations: Object.keys(state.sourceLimitations ?? {}).length,
    local_source_issues: Object.entries(state.sourceLimitations ?? {}).map(([externalId, issue]) => ({ external_id: externalId,
      source_file: issue.source_file, status: issue.status, cause: structuredClone(issue.cause),
      source_article_url: issue.source_capture?.source_article_url ?? null,
      capture_descriptor: issue.source_capture?.capture_descriptor ?? null })),
    pending_source_moves: Object.values(state.operations).filter((operation) => operation.sourceMoves?.pending).map((operation) => ({
      external_id: operation.externalId, page_key: operation.pageKey, phase: operation.sourceMoves.pending.phase,
      old_url: operation.sourceMoves.pending.prepare.request.old_url, new_url: operation.sourceMoves.pending.prepare.request.new_url,
      code: operation.sourceMoves.pending.rejection?.error.code ?? operation.sourceMoves.pending.failure_code ?? null })),
    rejected_to_intents: Object.values(state.operations).filter((operation) => operation.rejectedToIntent !== undefined).map((operation) => ({
      external_id: operation.externalId, page_key: operation.pageKey, code: rejectedToCode(operation.rejectedToIntent),
      route_id: operation.rejectedToIntent.receiver.route_id, http_status: operation.rejectedToIntent.receiver.http_status,
      ...(rejectedToCode(operation.rejectedToIntent) === "invalid_field" ? {
        refused_mutation_id: operation.rejectedToIntent.pending.request.mutation_id,
        decoded_error: operation.rejectedToIntent.receiver.error === undefined ? "UNKNOWN" : "RETAINED", raw_response: "UNKNOWN" } : {}) })) };
}
