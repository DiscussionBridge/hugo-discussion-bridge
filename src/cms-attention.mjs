import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { readRegular, fileFingerprint } from "./native-io.mjs";
import { withCmsJournalObservation, handoffCmsRecordedBaseline, restoreCmsRecordedBaseline } from "./cms-journal.mjs";
import { ownedNativeFragment, verifyNativePublic } from "./cms-proof.mjs";
import { hashCmsOwnershipReceipt } from "./cms-ownership.mjs";
import { parseCmsJson, semanticIdentity, validateCms } from "./protocol-v4/cms-runtime.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const identity = (value) => hash(semanticIdentity(value));
const journalOptions = (config, mappingId) => ({ journalRoot: path.join(config.privateRoot, "journals"), nativeRoot: config.siteRoot, mappingId });
const ownership = (receipt) => ({ resource_id: receipt.resource_id, external_id: receipt.external_id, native_id: receipt.native_id,
  canonical_url: receipt.canonical_url, source_revision: receipt.source_revision, ownership_receipt_sha256: hashCmsOwnershipReceipt(receipt) });
const manifest = (files, side) => identity(files.map((file) => ({ path: file.path, sha256: file[`${side}_sha256`] })));

async function operationState(continuation, transactionId) {
  let command = "none";
  if (transactionId) for (const kind of ["build", "deploy"]) {
    const record = await continuation.nativeRecord(`native/${transactionId}/${kind}.json`);
    if (record !== null) {
      if (record.transaction_id !== transactionId || record.kind !== kind || record.phase !== "completed") return "uncertain";
      command = "settled";
    }
  }
  return command;
}

// The current public artifact is only a candidate for baseline proof. Require
// its actual owned fragment to equal the retained verified hash before using
// the existing anonymous verifier against the exact retained URL/identity.
async function publicBaseline({ config, baseline, publicFetch, now }) {
  const previous = baseline?.finalize_report?.verification;
  if (!previous || baseline.phase !== "verified") throw new Error("Hugo baseline public evidence is unavailable.");
  const expectedHtml = await readRegular(path.join(config.publicRoot, new URL(baseline.receipt.canonical_url).pathname, "index.html"));
  const presentationMode = baseline.finalize_receiver_receipt?.mapping?.presentation_mode;
  if (baseline.action === "publish_revision") {
    const actual = ownedNativeFragment(expectedHtml, { mappingId: baseline.receipt.mapping_id, resourceId: baseline.receipt.resource_id,
      nativeId: baseline.receipt.native_id, sourceRevision: baseline.receipt.source_revision, presentationMode });
    if (actual.sha256 !== previous.native_publication_sha256) throw new Error("Hugo retained public baseline differs from current artifact.");
  }
  return verifyNativePublic({ action: baseline.action, receipt: baseline.receipt, representation: baseline.native_result?.representation,
    expectedHtml, presentationMode, destinationOrigin: config.siteUrl, publicFetch, now });
}

export async function collectHugoAttention({ config, connection, inspection, continuation, publicFetch = fetch, now = Date.now }) {
  validateCms("AttentionInspection", inspection);
  const mapping = inspection.mapping, work = inspection.work;
  const result = { profile: "hugo-static-1", observed_at: new Date(now()).toISOString(), native_state: "unknown", object_exists: null,
    native_id: mapping.destination_native_id, native_revision: null, ownership: null, native_result: null, verification: null,
    source_revision: null, managed_content_sha256: null, native_command: "none", pending_mutation: "none",
    prepared_transaction_id: inspection.prepared_transaction?.transaction_id ?? null, journal_sha256: null,
    baseline_sha256: null, candidate_sha256: null, current_sha256: null, restoration_operation_id: null, issue: "none" };
  if (connection.connection_id !== mapping.connection_id || work.mapping_id !== mapping.mapping_id || work.source_id !== mapping.source_id
      || work.state !== "attention" || work.policy_revision !== connection.policy.policy_revision) return { ...result, issue: "context_changed" };
  if (connection.policy.author_ids.length || connection.policy.taxonomy_ids.length) return { ...result, issue: "metadata_unavailable" };
  try {
    return await withCmsJournalObservation(journalOptions(config, mapping.mapping_id), async (journal) => {
      const state = journal.snapshot(), transaction = state?.transaction, baseline = state?.last_verified;
      result.journal_sha256 = journal.journalSha256;
      result.pending_mutation = state?.pending_mutation != null || continuation.snapshot().pending !== null ? "uncertain" : "none";
      if (result.pending_mutation === "uncertain") return validateCms("AttentionObservation", { ...result, issue: "uncertain_mutation" });
      if (!state) {
        const slug = `source-${hash(`${connection.connection_id}\0${mapping.source_id}`)}`;
        const files = [path.join(config.contentRoot, "discussionbridge", `${slug}.md`), path.join(config.dataRoot, `${slug}.json`)];
        const absent = (await Promise.all(files.map(fileFingerprint))).every((entry) => entry.sha256 === null);
        if (absent && mapping.destination_native_id === null && inspection.prepared_transaction === null && inspection.native_result === null) {
          const inventory = files.map((file) => ({ path: path.relative(config.siteRoot, file).split(path.sep).join("/"), sha256: null }));
          return validateCms("AttentionObservation", { ...result, native_state: "never_applied", object_exists: false,
            journal_sha256: identity({ journal: null, mapping_id: mapping.mapping_id, inventory }), current_sha256: identity(inventory),
            candidate_sha256: identity({ work_id: work.work_id, source_revision: work.source_revision, inventory }) });
        }
        return validateCms("AttentionObservation", { ...result, issue: "baseline_missing" });
      }
      result.native_command = await operationState(continuation, transaction?.transaction_id);
      if (result.native_command === "uncertain") return validateCms("AttentionObservation", { ...result, issue: "uncertain_command" });
      const move = transaction?.presentation_move;
      if (move && (!["committed", "aborted"].includes(move.phase) || move.baseline_pending)) return validateCms("AttentionObservation", { ...result, issue: "url_move_open" });
      if (transaction && transaction.authority.work_id !== work.work_id && transaction.phase !== "verified") return validateCms("AttentionObservation", { ...result, issue: "context_changed" });
      if (transaction) {
        const rows = await journal.snapshots(transaction.files, "before");
        result.current_sha256 = identity(rows.map(({ path, sha256 }) => ({ path, sha256 })));
        result.candidate_sha256 = manifest(transaction.files, "after");
        if (rows.some((entry) => !entry.before && !entry.after)) return validateCms("AttentionObservation", { ...result, native_state: "conflict", issue: "native_conflict" });
        if (rows.some((entry) => !entry.before) && rows.some((entry) => !entry.after)) return validateCms("AttentionObservation", { ...result, issue: "partial_files" });
      }
      if (!baseline) return validateCms("AttentionObservation", { ...result, issue: "baseline_missing" });
      if (!inspection.prepared_transaction && inspection.native_result !== null
          && semanticIdentity(inspection.native_result) !== semanticIdentity(baseline.native_result)) return validateCms("AttentionObservation", { ...result, issue: "context_changed" });
      if (baseline.receipt.native_id !== mapping.destination_native_id || baseline.receipt.resource_id !== mapping.resource_id
          || baseline.receipt.source_id !== mapping.source_id || baseline.receipt.external_id !== mapping.external_id
          || baseline.receipt.connection_id !== connection.connection_id || baseline.receipt.canonical_url !== mapping.canonical_url
          || semanticIdentity(baseline.native_result) !== semanticIdentity(inspection.verified_native_result)) return validateCms("AttentionObservation", { ...result, issue: "context_changed" });
      const rows = await journal.snapshots(baseline.files, "after");
      result.baseline_sha256 = manifest(baseline.files, "after"); result.current_sha256 = identity(rows.map(({ path, sha256 }) => ({ path, sha256 })));
      // A retained withdrawal is owned absence, not an existing article. Its
      // action label cannot substitute for the complete actual file census.
      if (baseline.action === "withdraw" && (baseline.native_result?.kind !== "withdraw"
          || baseline.files.some((file) => file.after_sha256 !== null)
          || rows.some((row) => row.sha256 !== null))) return validateCms("AttentionObservation", { ...result, native_state: "conflict", issue: "native_conflict" });
      if (rows.some((entry) => !entry.matches)) return validateCms("AttentionObservation", { ...result, native_state: "candidate_applied", issue: "native_conflict" });
      try { result.verification = await publicBaseline({ config, baseline, publicFetch, now }); }
      catch { return validateCms("AttentionObservation", { ...result, issue: "public_proof_unavailable" }); }
      await journal.assertUnchanged();
      return validateCms("AttentionObservation", { ...result, native_state: inspection.prepared_transaction ? "restored_baseline" : "baseline",
        object_exists: baseline.action === "publish_revision", native_revision: baseline.native_result.native_revision,
        ownership: ownership(baseline.receipt), native_result: baseline.native_result, source_revision: baseline.receipt.source_revision,
        managed_content_sha256: baseline.native_result.representation?.source_content_sha256 ?? null });
    });
  } catch { return validateCms("AttentionObservation", { ...result, native_state: "unavailable", issue: "collector_unavailable" }); }
}

export async function probeHugoAttention(client) {
  try {
    const { value } = await client.request("V4-32");
    return value.protocol_revision === "attention-recovery-1" && value.inspection_profiles.includes("hugo-static-1");
  } catch { return false; } // An old receiver cannot silently release attention.
}

// Called under the existing global writer/continuation locks. Each report is
// durably staged before sending, and each recovery before advancing its cursor.
export async function pollHugoAttention({ config, client, connection, continuation, publicFetch, now = Date.now }) {
  if (!await probeHugoAttention(client)) return { supported: false, inspections: 0 };
  const cursorName = "native/attention/cursors.json";
  const cursor = await continuation.nativeRecord(cursorName) ?? { inspections: 0, recoveries: 0 };
  validateCms("UInt", cursor.inspections); validateCms("UInt", cursor.recoveries);
  const { value: checks } = await client.request("V4-33", { query: { after: cursor.inspections } });
  let sequence = cursor.inspections;
  for (const inspection of checks.items) {
    if (inspection.sequence <= sequence) throw new Error("Hugo attention inspection sequence did not increase.");
    const name = `native/attention/${inspection.inspection_id}.json`;
    let record = await continuation.nativeRecord(name);
    if (record === null) {
      const observation = await collectHugoAttention({ config, connection, inspection, continuation, publicFetch, now });
      record = { inspection, report: { mutation_id: randomUUID(), context_sha256: inspection.context_sha256, observation }, result: null };
      await continuation.nativeRecord(name, record);
    } else if (semanticIdentity(record.inspection) !== semanticIdentity(inspection)) throw new Error("Hugo attention inspection changed identity.");
    if (record.result === null) {
      const response = await client.request("V4-34", { path: { inspection_id: inspection.inspection_id }, body: record.report });
      record.result = response.value; await continuation.nativeRecord(name, record);
    }
    sequence = inspection.sequence;
  }
  if (checks.next_after !== sequence) throw new Error("Hugo attention inspection cursor does not match staged observations.");
  cursor.inspections = checks.next_after; await continuation.nativeRecord(cursorName, cursor);
  const queueName = "native/attention/queue.json", queue = await continuation.nativeRecord(queueName) ?? { recovery_ids: [] };
  if (!Array.isArray(queue.recovery_ids) || queue.recovery_ids.length > 25 || new Set(queue.recovery_ids).size !== queue.recovery_ids.length) throw new Error("Hugo attention recovery queue is invalid.");
  if (queue.recovery_ids.length) return { supported: true, inspections: checks.items.length };
  const { value: recoveries } = await client.request("V4-35", { query: { after: cursor.recoveries } });
  sequence = cursor.recoveries;
  for (const recovery of recoveries.items) {
    if (recovery.sequence <= sequence) throw new Error("Hugo attention recovery sequence did not increase.");
    const name = `native/recoveries/${recovery.recovery_id}.json`, existing = await continuation.nativeRecord(name);
    if (existing !== null && semanticIdentity(existing.recovery) !== semanticIdentity(recovery)) throw new Error("Hugo attention successor event changed.");
    if (existing === null) await continuation.nativeRecord(name, { recovery, state: "queued" });
    if (existing?.state !== "settled" && !queue.recovery_ids.includes(recovery.recovery_id)) queue.recovery_ids.push(recovery.recovery_id);
    sequence = recovery.sequence;
  }
  if (recoveries.next_after !== sequence) throw new Error("Hugo attention recovery cursor does not match staged events.");
  await continuation.nativeRecord(queueName, queue);
  cursor.recoveries = recoveries.next_after; await continuation.nativeRecord(cursorName, cursor);
  return { supported: true, inspections: checks.items.length };
}

export async function restoreHugoAttentionBaseline({ config, mappingId, transactionId, operationId, continuation }) {
  validateCms("UUID", mappingId); validateCms("UUID", transactionId); validateCms("UUID", operationId);
  const state = await withCmsJournalObservation(journalOptions(config, mappingId), (journal) => journal.snapshot());
  if (!state?.transaction || state.transaction.transaction_id !== transactionId || continuation.snapshot().pending !== null
      || await operationState(continuation, transactionId) === "uncertain") throw new Error("Hugo restoration has unresolved operation evidence.");
  return restoreCmsRecordedBaseline(journalOptions(config, mappingId), { transactionId, operationId });
}

export async function verifyHugoRestoredBaseline({ config, mappingId, transactionId, operationId, continuation, publicFetch, now = Date.now, localOnly = false }) {
  validateCms("UUID", mappingId); validateCms("UUID", transactionId); validateCms("UUID", operationId);
  if (continuation && (continuation.snapshot().pending !== null || await operationState(continuation, transactionId) === "uncertain")) throw new Error("Hugo baseline deployment has unresolved operation evidence.");
  return withCmsJournalObservation(journalOptions(config, mappingId), async (journal) => {
    const state = journal.snapshot();
    const bytes = await readRegular(path.join(config.privateRoot, "journals", ".restorations", mappingId, `${operationId}.completed.json`));
    if (bytes === null) throw new Error("Hugo explicit baseline restoration is not complete.");
    const operation = parseCmsJson(bytes, { maximumBytes: 262144 });
    if (!state?.transaction || !state.last_verified || state.transaction.transaction_id !== transactionId || operation.operation_id !== operationId
        || operation.mapping_id !== mappingId || operation.transaction_id !== transactionId || operation.journal_sha256 !== journal.journalSha256
        || operation.restored !== true || semanticIdentity(operation.files) !== semanticIdentity(state.transaction.files)) throw new Error("Hugo recorded restoration evidence changed.");
    const rows = await journal.snapshots(state.transaction.files, "before");
    if (rows.some((row) => !row.matches)) throw new Error("Hugo restored native files changed.");
    if (localOnly) return { native_restored: true, public_restored: false };
    const verification = await publicBaseline({ config, baseline: state.last_verified, publicFetch, now });
    await journal.assertUnchanged(); return { native_restored: true, public_restored: true, verification };
  });
}

export async function handoffHugoAttention({ config, recovery, lease, continuation, connection, publicFetch, assertCurrentLease, now = Date.now }) {
  validateCms("AttentionRecovery", recovery); validateCms("Lease", lease);
  if (typeof assertCurrentLease !== "function") throw new Error("Hugo recovery requires the current receiver lease guard.");
  await assertCurrentLease();
  if (lease.work.work_id !== recovery.work.work_id || lease.work.mapping_id !== recovery.mapping.mapping_id
      || lease.work.attempt_cycle !== recovery.work.attempt_cycle || lease.work.source_revision !== recovery.work.source_revision
      || lease.work.policy_revision !== recovery.work.policy_revision || lease.lease_generation <= recovery.work.lease_generation) throw new Error("Hugo recovery lease does not name the exact admitted successor.");
  const check = await continuation.nativeRecord(`native/attention/${recovery.inspection_id}.json`);
  if (!check || check.inspection.context_sha256 !== recovery.context_sha256 || check.inspection.work.work_id !== recovery.predecessor_work_id
      || check.inspection.work.attempt_cycle !== recovery.predecessor_attempt_cycle
      || ["source_id", "source_revision", "policy_revision", "action"].some((key) => check.inspection.work[key] !== recovery.work[key])
      || ["mapping_id", "resource_id", "connection_id", "source_id", "external_id", "canonical_url", "destination_native_id"].some((key) => check.inspection.mapping[key] !== recovery.mapping[key])
      || semanticIdentity(check.inspection.source) !== semanticIdentity(recovery.source)
      || recovery.mode === "settle_restored_baseline" && check.inspection.prepared_transaction === null) throw new Error("Hugo recovery inspection evidence is unavailable.");
  const observed = await collectHugoAttention({ config, connection, inspection: check.inspection, continuation, publicFetch, now });
  if (!["baseline", "restored_baseline", "never_applied"].includes(observed.native_state) || observed.issue !== "none"
      || observed.baseline_sha256 !== check.report.observation.baseline_sha256 || observed.current_sha256 !== check.report.observation.current_sha256
      || semanticIdentity(observed.native_result) !== semanticIdentity(recovery.native_baseline)) throw new Error("Hugo native baseline changed after administrator inspection.");
  await assertCurrentLease(); // Observation time is not continuing lease/scope authority.
  const state = await withCmsJournalObservation(journalOptions(config, recovery.mapping.mapping_id), (journal) => journal.snapshot());
  if (state?.transaction?.authority.work_id === recovery.predecessor_work_id) await handoffCmsRecordedBaseline(journalOptions(config, recovery.mapping.mapping_id), {
    predecessorWorkId: recovery.predecessor_work_id, successorWorkId: recovery.work.work_id,
    inspectionSha256: identity(check.report), leaseGeneration: lease.lease_generation });
  return recovery;
}
