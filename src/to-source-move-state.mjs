import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { durableDirectory, readRegular, syncDirectory, nativePath } from "./native-io.mjs";
import { validateCms, validateCmsResponse, semanticIdentity, projectGeneratedReadMoreMove } from "./protocol-v4/cms-runtime.mjs";
import { sourceDigest, validateToSourceReceipt, hashToSourceReceipt } from "./to-source-proof.mjs";
import { validateSourceCapture } from "./source-preparation.mjs";

export const sourceMoveProblem = (code = "native_restore_required") => Object.assign(new Error(`Hugo To source URL move ${code}; retain exact journal/native state for reconciliation.`), { code });
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
export function currentToSourceRecord(operation) {
  if (!operation.currentSourceMove) return operation.lastToRequest?.bridge_record;
  const entry = operation.sourceMoves?.history.find((item) => item.phase === "committed" && item.move?.move_id === operation.currentSourceMove.move_id);
  if (!entry || entry.finalize.response.source_revision !== operation.acceptedSourceRevision) throw sourceMoveProblem();
  return entry.projected_record;
}
export function currentToSourceObservation(operation) {
  if (!operation.currentSourceMove) return null;
  currentToSourceRecord(operation);
  return operation.sourceMoves.history.find((item) => item.move.move_id === operation.currentSourceMove.move_id).finalize.response;
}
export function validateSourceMoveBlob(value) {
  if (!exact(value, ["path", "bytes", "sha256"]) || !/^source-moves\/[a-f0-9-]{36}\/[a-z0-9.-]+$/u.test(value.path)) throw sourceMoveProblem();
  validateCms("UInt", value.bytes); validateCms("Sha256", value.sha256); return value;
}
export async function keepSourceMoveBlob(privateRoot, transaction, name, bytes) {
  validateCms("UUID", transaction); if (!/^[a-z0-9.-]+$/u.test(name)) throw sourceMoveProblem();
  const relative = `source-moves/${transaction}/${name}`, file = nativePath(privateRoot, relative);
  await durableDirectory(path.dirname(file)); const before = await readRegular(file);
  if (before !== null) { if (!before.equals(bytes)) throw sourceMoveProblem(); }
  else {
    let handle;
    try { handle = await open(file, "wx", 0o600); await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle?.close(); }
    await syncDirectory(path.dirname(file));
  }
  return { path: relative, bytes: bytes.length, sha256: sourceDigest(bytes) };
}
export async function readSourceMoveBlob(privateRoot, descriptor) {
  validateSourceMoveBlob(descriptor); const bytes = await readRegular(nativePath(privateRoot, descriptor.path));
  if (bytes === null || bytes.length !== descriptor.bytes || sourceDigest(bytes) !== descriptor.sha256) throw sourceMoveProblem();
  return bytes;
}
export async function sourceMoveFileCas(file, before, bytes, assertFence) {
  await assertFence(); await durableDirectory(path.dirname(file));
  const current = await readRegular(file); if ((current === null ? null : sourceDigest(current)) !== before) throw sourceMoveProblem("native_local_edit_conflict");
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`); let handle;
  try {
    handle = await open(temporary, "wx", 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    await assertFence(); const actual = await readRegular(file);
    if ((actual === null ? null : sourceDigest(actual)) !== before) throw sourceMoveProblem("native_local_edit_conflict");
    await rename(temporary, file); await syncDirectory(path.dirname(file));
  } finally { await handle?.close(); await rm(temporary, { force: true }); }
}
export async function retireToSourceCache(operation, save, assertFence) {
  const pending = operation.sourceCacheRetirement; if (!pending) return;
  await assertFence(); const bytes = await readRegular(pending.file);
  if (bytes !== null) {
    if (sourceDigest(bytes) !== pending.sha256) throw sourceMoveProblem("native_local_edit_conflict");
    await rm(pending.file); await syncDirectory(path.dirname(pending.file));
  }
  delete operation.sourceCacheRetirement; await save();
}

// Deliberately bounded native integration: top-level TOML url, preserving the
// authored body/all unrelated bytes. Native capture must independently establish
// its resulting exact .Permalink; wire identities are never normalized here.
export function patchNativeSourceUrl(bytes, newUrl) {
  validateCms("Url", newUrl); const url = new URL(newUrl);
  if (url.search || url.hash) throw sourceMoveProblem("native_source_public_profile_unresolved");
  let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw sourceMoveProblem(); }
  const header = /^(\+\+\+\r?\n)([\s\S]*?)(^\+\+\+(?:\r?\n|$))/mu.exec(text);
  if (!header || header.index !== 0) throw sourceMoveProblem("native_source_public_profile_unresolved");
  if (header[2].includes('"""') || header[2].includes("'''")) throw sourceMoveProblem("native_source_public_profile_unresolved");
  const lines = header[2].match(/[^\n]*\n|[^\n]+$/gu) ?? []; let table = false, found = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r?\n$/u, "");
    if (/^\s*\[/u.test(line)) table = true;
    if (!table && /^\s*(?:url|"url"|'url')\s*=/iu.test(line)) {
      if (found !== -1 || !/^\s*url\s*=\s*(?:"(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/u.test(line)) throw sourceMoveProblem("native_source_public_profile_unresolved");
      found = i;
    }
  }
  const newline = header[1].endsWith("\r\n") ? "\r\n" : "\n";
  if (found < 0) lines.unshift(`url = ${JSON.stringify(url.pathname)}${newline}`);
  else lines[found] = lines[found].replace(/^(\s*url\s*=\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*')/u, (_, prefix) => prefix + JSON.stringify(url.pathname));
  const updated = header[1] + lines.join("") + header[3] + text.slice(header[0].length);
  return Buffer.from(updated);
}

export function validateToSourceMoves(operation) {
  if (operation.sourceCacheRetirement !== undefined) {
    const pending = operation.sourceCacheRetirement;
    if (!exact(pending, ["file", "sha256", "mutation_id"]) || !path.isAbsolute(pending.file)) throw sourceMoveProblem();
    validateCms("Sha256", pending.sha256); validateCms("UUID", pending.mutation_id);
    if (operation.lastToRequest?.mutation_id !== pending.mutation_id || !operation.sourceMoves?.history.some((entry) => entry.public_data?.file === pending.file && entry.public_data.blob.sha256 === pending.sha256)) throw sourceMoveProblem();
  }
  const moves = operation.sourceMoves; if (moves === undefined) { if (operation.currentSourceMove) throw sourceMoveProblem(); return; }
  if (!exact(moves, ["pending", "history"]) || !Array.isArray(moves.history)) throw sourceMoveProblem();
  const ids = new Set();
  for (const entry of [...moves.history, ...(moves.pending === null ? [] : [moves.pending])]) {
    const required = ["schema_version", "phase", "prepare", "before", "after_file", "prepared_article", "binding", "scope", "inputs", "new_revision", "commands"];
    const optional = ["move", "captured", "public_data", "receipt", "deployment", "built_article", "verification", "finalize", "abort", "restoration", "rejection", "failure_code", "projected_record", "native_publication_sha256"];
    if (!entry || required.some((key) => !Object.hasOwn(entry, key)) || Object.keys(entry).some((key) => !required.includes(key) && !optional.includes(key))
        || entry.schema_version !== "db-hugo-to-source-move-1" || !["prepare_intent", "prepared", "applying_file", "applied_file", "captured", "applying_data", "applied", "built", "deployed", "verified", "finalize_intent", "abort_intent", "committed", "aborted", "attention", "rejected"].includes(entry.phase)
        || ids.has(entry.prepare.request.mutation_id)) throw sourceMoveProblem();
    ids.add(entry.prepare.request.mutation_id); validateCms("SourceUrlMovePrepare", entry.prepare.request);
    if (!exact(entry.prepare, ["request", ...(Object.hasOwn(entry.prepare, "response") ? ["response"] : [])])
        || !exact(entry.before, ["record", "current", "capture", "native_binding", "source_file", "native_rendered", "file", "public_data"])) throw sourceMoveProblem();
    if (!exact(entry.scope, ["connection_id", "scope_revision", "publication_lane", "destination_origin", "forum_origin"])) throw sourceMoveProblem();
    validateCms("ConnectionId", entry.scope.connection_id); validateCms("Revision", entry.scope.scope_revision); validateCms("Lane", entry.scope.publication_lane);
    validateCms("Url", entry.scope.destination_origin); validateCms("Url", entry.scope.forum_origin);
    if (entry.prepare.response !== undefined) validateCms("SourceUrlMove", entry.prepare.response);
    validateCms("ToRecord", entry.before.record); validateCms("Record", entry.before.current); validateSourceCapture(entry.before.capture);
    for (const blob of [entry.before.file, entry.before.native_rendered, entry.after_file, entry.prepared_article]) validateSourceMoveBlob(blob);
    if (entry.before.public_data !== null) validateSourceMoveBlob(entry.before.public_data);
    if (entry.prepared_article.sha256 !== entry.before.record.source_content_sha256 || entry.prepared_article.bytes !== entry.before.record.source_content_bytes
        || entry.before.native_binding.source_file !== entry.before.source_file || entry.before.native_binding.source_sha256 !== entry.before.file.sha256
        || entry.before.native_binding.source_revision !== entry.before.record.source_revision || entry.before.capture.source_id !== operation.externalId) throw sourceMoveProblem();
    validateCms("Sha256", entry.binding); validateCms("Revision", entry.new_revision);
    if (entry.before.record.external_id !== operation.externalId || entry.prepare.request.external_id !== operation.externalId
        || entry.prepare.request.expected_source_revision !== entry.before.record.source_revision || entry.prepare.request.old_url !== entry.before.record.canonical_url
        || entry.before.current.resource_id !== operation.resourceId || entry.before.current.topic_id !== operation.topicId
        || entry.before.current.source_revision !== entry.before.record.source_revision || entry.before.current.canonical_url !== entry.before.record.canonical_url
        || entry.new_revision === entry.before.record.source_revision || !Array.isArray(entry.inputs) || !Array.isArray(entry.commands)) throw sourceMoveProblem();
    for (const input of entry.inputs) { if (!exact(input, ["path", "sha256"]) || !path.isAbsolute(input.path)) throw sourceMoveProblem(); validateCms("Sha256", input.sha256); }
    for (const command of entry.commands) {
      if (!exact(command, ["name", "value"]) || !exact(command.value, ["transaction_id", "kind", "command_sha256", "phase", "owner_pid", "process_identity", "completed_at"])) throw sourceMoveProblem();
      validateCms("UUID", command.value.transaction_id); validateCms("Sha256", command.value.command_sha256);
      if (command.name !== `native/${command.value.transaction_id}/${command.value.kind}.json` || !["build", "deploy"].includes(command.value.kind)
          || !["intent", "running", "completed"].includes(command.value.phase)) throw sourceMoveProblem();
      if (command.value.phase === "completed") validateCms("Instant", command.value.completed_at);
      else if (command.value.completed_at !== null) throw sourceMoveProblem();
      if (command.value.owner_pid !== null && (!Number.isSafeInteger(command.value.owner_pid) || command.value.owner_pid < 1)) throw sourceMoveProblem();
    }
    if (entry.move) {
      validateCms("SourceUrlMove", entry.move);
      if (entry.move.resource_id !== operation.resourceId || entry.move.expected_source_revision !== entry.before.record.source_revision
          || entry.move.old_url !== entry.prepare.request.old_url || entry.move.new_url !== entry.prepare.request.new_url
          || semanticIdentity(entry.move) !== semanticIdentity(entry.prepare.response)) throw sourceMoveProblem();
    }
    if (entry.phase !== "prepare_intent" && !entry.move) throw sourceMoveProblem();
    if (entry.receipt) {
      validateToSourceReceipt(entry.receipt);
      if (entry.receipt.external_id !== operation.externalId || entry.receipt.resource_id !== operation.resourceId || entry.receipt.topic_id !== operation.topicId
          || entry.receipt.native_id !== entry.before.source_file || entry.receipt.canonical_url !== entry.move.new_url || entry.receipt.source_revision !== entry.new_revision
          || entry.receipt.source_file_sha256 !== entry.after_file.sha256 || entry.receipt.source_content_sha256 !== entry.before.record.source_content_sha256
          || entry.receipt.source_content_bytes !== entry.before.record.source_content_bytes || entry.receipt.move_id !== entry.move.move_id || entry.receipt.proof_nonce !== entry.move.proof_nonce
          || entry.receipt.binding.connection_id !== entry.scope.connection_id || entry.receipt.binding.scope_revision !== entry.scope.scope_revision
          || entry.receipt.binding.lane !== entry.scope.publication_lane || entry.receipt.binding.forum_origin !== entry.scope.forum_origin
          || semanticIdentity(entry.receipt.capture.birth) !== semanticIdentity(entry.before.capture)
          || semanticIdentity(entry.receipt.capture.native_before) !== semanticIdentity(entry.before.native_rendered)
          || semanticIdentity(entry.receipt.capture.native_after) !== semanticIdentity(entry.captured.native_rendered)
          || semanticIdentity(entry.receipt.capture.prepared) !== semanticIdentity(entry.prepared_article)) throw sourceMoveProblem();
    }
    if (entry.public_data) {
      validateSourceMoveBlob(entry.public_data.blob);
      if (!exact(entry.public_data, ["file", "blob", "before_sha256"]) || !path.isAbsolute(entry.public_data.file)
          || entry.public_data.before_sha256 !== (entry.before.public_data?.sha256 ?? null) || entry.receipt.public_data_sha256 !== entry.public_data.blob.sha256) throw sourceMoveProblem();
    }
    if (entry.built_article) validateSourceMoveBlob(entry.built_article);
    if (entry.deployment) {
      if (!exact(entry.deployment, ["deployment_id", "deployed_at"])) throw sourceMoveProblem();
      validateCms("OpaqueId", entry.deployment.deployment_id); validateCms("Instant", entry.deployment.deployed_at);
    }
    if (entry.native_publication_sha256 !== undefined) validateCms("Sha256", entry.native_publication_sha256);
    if (entry.verification) {
      validateCms("SourceUrlVerification", entry.verification);
      if (entry.verification.url !== entry.move.new_url || entry.verification.external_id !== operation.externalId || entry.verification.source_revision !== entry.new_revision
          || entry.verification.source_content_sha256 !== entry.before.record.source_content_sha256
          || entry.verification.native_ownership_receipt_sha256 !== hashToSourceReceipt(entry.receipt)
          || entry.verification.native_publication_sha256 !== entry.native_publication_sha256) throw sourceMoveProblem();
    }
    if (entry.captured) {
      if (!exact(entry.captured, ["canonical_url", "source_sha256", "source_updated_at", "native_rendered"]) || entry.captured.canonical_url !== entry.move.new_url || entry.captured.source_sha256 !== entry.after_file.sha256) throw sourceMoveProblem();
      validateSourceMoveBlob(entry.captured.native_rendered);
      if (entry.captured.source_updated_at !== null) validateCms("Instant", entry.captured.source_updated_at);
    }
    if (entry.projected_record !== undefined) {
      validateCms("ToRecord", entry.projected_record);
      const expected = entry.before.record.representation.kind === "generated_excerpt"
        ? projectGeneratedReadMoreMove(entry.before.record, entry.move.new_url, entry.new_revision, entry.captured.source_updated_at)
        : { ...entry.before.record, canonical_url: entry.move.new_url, source_revision: entry.new_revision, expected_source_revision: entry.before.record.source_revision, source_updated_at: entry.captured.source_updated_at };
      if (semanticIdentity(expected) !== semanticIdentity(entry.projected_record)) throw sourceMoveProblem();
    }
    if (entry.finalize) {
      validateCms("SourceUrlMoveFinalize", entry.finalize.request);
      if (!exact(entry.finalize, ["request", ...(Object.hasOwn(entry.finalize, "dispatched") ? ["dispatched"] : []), ...(Object.hasOwn(entry.finalize, "response") ? ["response"] : [])])
          || entry.finalize.request.move_id !== entry.move.move_id || entry.finalize.request.proof_nonce !== entry.move.proof_nonce
          || entry.finalize.request.expected_source_revision !== entry.before.record.source_revision || entry.finalize.request.new_source_revision !== entry.new_revision
          || semanticIdentity(entry.finalize.request.verification) !== semanticIdentity(entry.verification)
          || entry.finalize.request.source_updated_at !== entry.captured.source_updated_at) throw sourceMoveProblem();
      if (entry.finalize.dispatched !== undefined && typeof entry.finalize.dispatched !== "boolean") throw sourceMoveProblem();
      if (entry.finalize.response) {
        const response = entry.finalize.response; validateCms("Record", response);
        if (response.direction !== "to_discourse" || response.state !== "active" || response.resource_id !== operation.resourceId || response.topic_id !== operation.topicId
            || response.external_id !== operation.externalId || response.canonical_url !== entry.move.new_url || response.source_revision !== entry.new_revision
            || response.source_created_at !== entry.before.record.source_created_at || response.source_updated_at !== entry.captured.source_updated_at) throw sourceMoveProblem();
      }
    }
    if (entry.restoration) {
      const value = entry.restoration, required = ["transaction_id", "phase"], optional = ["native_rendered", "public_data", "receipt", "built_article", "deployment", "verification"];
      if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
          || !["restoring_file", "restored_file", "restoring_data", "rebuilding", "verified_old"].includes(value.phase)) throw sourceMoveProblem();
      validateCms("UUID", value.transaction_id);
      for (const key of ["native_rendered", "public_data", "built_article"]) if (value[key] !== undefined) validateSourceMoveBlob(value[key]);
      if (value.receipt !== undefined) {
        validateToSourceReceipt(value.receipt);
        if (value.receipt.resource_id !== operation.resourceId || value.receipt.topic_id !== operation.topicId || value.receipt.external_id !== operation.externalId
            || value.receipt.canonical_url !== entry.move.old_url || value.receipt.source_revision !== entry.before.record.source_revision
            || value.receipt.source_file_sha256 !== entry.before.file.sha256 || value.receipt.public_data_sha256 !== value.public_data?.sha256
            || semanticIdentity(value.receipt.capture.native_after) !== semanticIdentity(value.native_rendered)) throw sourceMoveProblem();
      }
      if (value.deployment !== undefined) {
        if (!exact(value.deployment, ["deployment_id", "deployed_at"])) throw sourceMoveProblem();
        validateCms("OpaqueId", value.deployment.deployment_id); validateCms("Instant", value.deployment.deployed_at);
      }
      if (value.verification !== undefined) {
        validateCms("SourceUrlVerification", value.verification);
        if (value.verification.url !== entry.move.old_url || value.verification.source_revision !== entry.before.record.source_revision
            || value.verification.external_id !== operation.externalId || value.verification.source_content_sha256 !== entry.before.record.source_content_sha256
            || value.verification.native_ownership_receipt_sha256 !== hashToSourceReceipt(value.receipt)) throw sourceMoveProblem();
      }
      if (["restoring_data", "rebuilding", "verified_old"].includes(value.phase) && (!value.native_rendered || !value.public_data || !value.receipt)) throw sourceMoveProblem();
      if (value.phase === "verified_old" && (!value.built_article || !value.deployment || !value.verification)) throw sourceMoveProblem();
    }
    if (entry.abort) {
      if (!exact(entry.abort, ["request", "receipt", ...(Object.hasOwn(entry.abort, "response") ? ["response"] : [])])) throw sourceMoveProblem();
      validateCms("SourceUrlMoveAbort", entry.abort.request); validateToSourceReceipt(entry.abort.receipt);
      if (entry.abort.request.expected_source_revision !== entry.before.record.source_revision || entry.abort.request.move_id !== entry.move.move_id
          || entry.abort.request.old_url !== entry.move.old_url || entry.abort.request.native_ownership_receipt_sha256 !== hashToSourceReceipt(entry.abort.receipt)
          || entry.abort.receipt.canonical_url !== entry.move.old_url || entry.abort.receipt.source_file_sha256 !== entry.before.file.sha256
          || entry.abort.receipt.source_revision !== entry.before.record.source_revision) throw sourceMoveProblem();
      if (entry.abort.request.native_change_applied && (entry.restoration?.phase !== "verified_old" || semanticIdentity(entry.abort.receipt) !== semanticIdentity(entry.restoration.receipt))) throw sourceMoveProblem();
      if (!entry.abort.request.native_change_applied && (entry.restoration || entry.commands.length)) throw sourceMoveProblem();
      if (entry.abort.response) {
        const response = entry.abort.response; validateCms("SourceUrlMove", response);
        if (response.move_id !== entry.move.move_id || response.resource_id !== operation.resourceId || response.expected_source_revision !== entry.before.record.source_revision
            || response.old_url !== entry.move.old_url || response.new_url !== entry.move.new_url || response.proof_nonce !== entry.move.proof_nonce
            || response.state !== (entry.abort.request.native_change_applied ? "attention" : "aborted")) throw sourceMoveProblem();
      }
    }
    if (entry.rejection) {
      if (!exact(entry.rejection, ["route_id", "http_status", "error"]) || entry.rejection.route_id !== "V4-29" || entry.rejection.http_status !== 422
          || entry.rejection.error.code !== "content_preservation_unavailable") throw sourceMoveProblem();
      validateCmsResponse("V4-29", entry.rejection.error, entry.rejection.http_status);
    }
    if (["captured", "applying_data", "applied", "built", "deployed", "verified", "finalize_intent", "committed", "rejected"].includes(entry.phase) && (!entry.captured || !entry.projected_record)) throw sourceMoveProblem();
    if (["applying_data", "applied", "built", "deployed", "verified", "finalize_intent", "committed", "rejected"].includes(entry.phase) && (!entry.receipt || !entry.public_data)) throw sourceMoveProblem();
    if (["built", "deployed", "verified", "finalize_intent", "committed", "rejected"].includes(entry.phase) && (!entry.built_article || !entry.native_publication_sha256)) throw sourceMoveProblem();
    if (["verified", "finalize_intent", "committed", "rejected"].includes(entry.phase) && (!entry.verification || !entry.deployment)) throw sourceMoveProblem();
    if (entry.phase === "abort_intent" && !entry.abort || ["aborted", "attention"].includes(entry.phase) && !entry.abort?.response
        || entry.phase === "rejected" && !entry.rejection) throw sourceMoveProblem();
    if (entry.phase === "committed" && (!entry.finalize?.response || !entry.projected_record || entry.finalize.response.source_revision !== entry.new_revision
        || entry.projected_record.source_revision !== entry.new_revision || entry.finalize.response.canonical_url !== entry.move.new_url)) throw sourceMoveProblem();
  }
  if (operation.currentSourceMove !== undefined) {
    if (!exact(operation.currentSourceMove, ["move_id"])) throw sourceMoveProblem();
    const record = currentToSourceRecord(operation), observation = currentToSourceObservation(operation);
    if (record.canonical_url !== operation.canonicalUrl || observation.resource_id !== operation.resourceId || observation.topic_id !== operation.topicId) throw sourceMoveProblem();
  }
}
