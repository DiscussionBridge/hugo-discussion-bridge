import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OUTCOMES = new Set(["pending", "created", "resolved", "retryable_failure", "rejected", "reconciliation_required"]);

export async function readOperationalState(file) {
  let value;
  try { value = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return emptyState(); throw error; }
  return validateState(value);
}

export async function writeOperationalState(file, state) {
  validateState(state);
  if (state.withdrawalRecovery && Object.keys(state.withdrawalRecovery).length && /(?:^|[\\/])(?:public|static)(?:[\\/]|$)/iu.test(path.resolve(file))) throw new Error("Hugo withdrawal recovery state must stay outside static/public paths.");
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, file);
  } catch (error) {
    await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); throw error;
  }
}

export async function withOperationalStateLock(file, action, options = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  let release;
  try {
    release = await lock(file, {
      realpath: false,
      retries: 0,
      stale: options.staleMs ?? 30_000,
      update: options.updateMs ?? 10_000,
    });
  } catch (error) {
    if (error.code === "ELOCKED") throw new Error(`Hugo publication state is already in use: ${file}`);
    throw error;
  }
  try {
    return await action();
  } finally {
    await release();
  }
}

export function beginAttempt(state, { externalId, canonicalUrl, pageKey }, now = new Date()) {
  const prior = state.operations[externalId];
  if (prior && prior.canonicalUrl !== canonicalUrl) throw new Error("Hugo operational state contains a canonical identity collision.");
  const operation = {
    ...prior, externalId, canonicalUrl, ...(pageKey ? { pageKey } : {}),
    correlationId: prior?.correlationId ?? randomUUID(),
    attempts: (prior?.attempts ?? 0) + 1,
    outcome: "pending", retryable: false, reconciliationRequired: false,
    lastAttemptAt: now.toISOString(),
  };
  delete operation.lastError;
  state.operations[externalId] = operation;
  return operation;
}

export function completeAttempt(operation, result, now = new Date()) {
  operation.outcome = result.outcome;
  operation.retryable = false;
  operation.reconciliationRequired = false;
  operation.resourceId = result.resource_id;
  operation.topicId = result.topic_id;
  operation.topicUrl = result.topic_url;
  if (result.source_revision) operation.acceptedSourceRevision = result.source_revision;
  operation.lastSuccessAt = now.toISOString();
  delete operation.lastError;
}

export function stageAttemptResult(operation, result) {
  operation.outcome = "pending";
  operation.retryable = true;
  operation.reconciliationRequired = true;
  operation.resourceId = result.resource_id;
  operation.topicId = result.topic_id;
  operation.topicUrl = result.topic_url;
  if (result.source_revision) operation.acceptedSourceRevision = result.source_revision;
  operation.lastError = "Receiver accepted the publication; platform output commit is pending.";
  delete operation.lastSuccessAt;
}

export function failAttempt(operation, error, { retryable, reconciliationRequired }) {
  operation.outcome = reconciliationRequired ? "reconciliation_required" : retryable ? "retryable_failure" : "rejected";
  operation.retryable = retryable;
  operation.reconciliationRequired = reconciliationRequired;
  operation.lastError = (error instanceof Error ? error.message : "Unknown publication failure.").replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 500);
}

export function summarizeOperationalState(state) {
  validateState(state);
  const summary = { operations: 0, pending: 0, healthy: 0, retryable: 0, reconciliationRequired: 0, rejected: 0 };
  for (const operation of Object.values(state.operations)) {
    summary.operations++;
    if (operation.outcome === "pending") summary.pending++;
    if (operation.outcome === "created" || operation.outcome === "resolved") summary.healthy++;
    if (operation.retryable) summary.retryable++;
    if (operation.reconciliationRequired) summary.reconciliationRequired++;
    if (operation.outcome === "rejected") summary.rejected++;
  }
  return summary;
}

function emptyState() { return { schemaVersion: 1, adapterId: "hugo-discussion-bridge", operations: {} }; }

function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 || value.adapterId !== "hugo-discussion-bridge" || !value.operations || typeof value.operations !== "object" || Array.isArray(value.operations)) throw new Error("Hugo operational state is invalid.");
  for (const [key, operation] of Object.entries(value.operations)) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation) || key !== operation.externalId || typeof operation.canonicalUrl !== "string" || !UUID.test(operation.correlationId ?? "") || !Number.isSafeInteger(operation.attempts) || operation.attempts < 1 || !OUTCOMES.has(operation.outcome) || typeof operation.retryable !== "boolean" || typeof operation.reconciliationRequired !== "boolean" || !validDate(operation.lastAttemptAt) || (operation.lastSuccessAt !== undefined && !validDate(operation.lastSuccessAt))) throw new Error("Hugo operational state entry is invalid.");
    for (const text of [operation.externalId, operation.canonicalUrl, operation.lastError, operation.resourceId, operation.topicUrl]) if (text !== undefined && (typeof text !== "string" || /[\u0000-\u001f\u007f]/u.test(text))) throw new Error("Hugo operational state entry is invalid.");
    if (operation.resourceId !== undefined && !UUID.test(operation.resourceId)) throw new Error("Hugo operational state entry is invalid.");
    if (operation.topicId !== undefined && (!Number.isSafeInteger(operation.topicId) || operation.topicId < 1)) throw new Error("Hugo operational state entry is invalid.");
    for (const revision of [operation.acceptedSourceRevision, operation.requestedSourceRevision, operation.requestedPreviousRevision]) if (revision !== undefined && revision !== null && (typeof revision !== "string" || !/^[a-f0-9]{64}$/u.test(revision))) throw new Error("Hugo source publication revision state is invalid.");
  }
  if (value.withdrawalRecovery !== undefined) {
    if (!value.withdrawalRecovery || typeof value.withdrawalRecovery !== "object" || Array.isArray(value.withdrawalRecovery) || Object.keys(value.withdrawalRecovery).length > 10000) throw new Error("Hugo withdrawal recovery metadata is invalid.");
    for (const [key, recovery] of Object.entries(value.withdrawalRecovery)) {
      const allowed = new Set(["resourceId", "canonicalUrl", "topicId", "forumOrigin", "priorSourceEdition", "presentationMode", "withdrawalEdition", "publicWithdrawalVerified"]);
      if (Object.keys(recovery ?? {}).some((field) => !allowed.has(field)) || (recovery?.priorSourceEdition !== undefined && !/^[a-f0-9]{64}$/u.test(recovery.priorSourceEdition)) || (recovery?.presentationMode !== undefined && !["simple", "full", "interactive"].includes(recovery.presentationMode))) throw new Error("Hugo withdrawal recovery metadata is invalid.");
      if (!UUID.test(key) || !recovery || typeof recovery !== "object" || recovery.resourceId !== key || typeof recovery.canonicalUrl !== "string" || !Number.isSafeInteger(recovery.topicId) || recovery.topicId < 1 || typeof recovery.forumOrigin !== "string" || !/^[a-f0-9]{64}$/u.test(recovery.withdrawalEdition ?? "") || recovery.publicWithdrawalVerified !== false || Object.hasOwn(recovery, "content_html") || Object.hasOwn(recovery, "body")) throw new Error("Hugo withdrawal recovery metadata is invalid.");
    }
  }
  return value;
}

function validDate(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
