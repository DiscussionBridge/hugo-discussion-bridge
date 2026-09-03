import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

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

export function beginAttempt(state, { externalId, canonicalUrl }, now = new Date()) {
  const prior = state.operations[externalId];
  if (prior && prior.canonicalUrl !== canonicalUrl) throw new Error("Hugo operational state contains a canonical identity collision.");
  const operation = {
    ...prior, externalId, canonicalUrl,
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
  }
  return value;
}

function validDate(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
