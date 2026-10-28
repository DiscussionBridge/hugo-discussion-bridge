import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { assertCmsSafePath } from "./native-lock.mjs";

import { semanticIdentity, validateCms } from "./protocol-v4/cms-runtime.mjs";
const attention = (code) => Object.assign(new Error(`Hugo To binding withdrawal ${code}; native reconciliation requires attention.`), { code });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function currentFile(native) {
  const file = path.join(native.content_root, native.source_file); await assertCmsSafePath(file);
  let stat; try { stat = await lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw attention("native_ownership_conflict");
  return hash(await readFile(file));
}
function requireBinding(operation, config, connection, client) {
  const native = operation.toNativeBinding;
  if (!native || !operation.acceptedSourceRevision || !operation.resourceId || !operation.topicId || !operation.lastToRequest || !operation.lastToResponse) throw attention("metadata_unavailable");
  // Shared publication selection Policy.enabled governs From work, not To05.
  if (native.source_revision !== operation.acceptedSourceRevision || native.scope_revision !== connection.scope_revision
      || native.policy_revision !== connection.policy.policy_revision || native.lane !== connection.publication_lane
      || native.site_root !== path.resolve(config.toNative.siteRoot) || native.content_root !== path.resolve(config.toNative.contentRoot ?? path.join(config.toNative.siteRoot,"content"))
      || semanticIdentity(operation.toBinding) !== semanticIdentity({connection_id:config.connectionId,forum_origin:client.origin,native_origin:new URL(operation.canonicalUrl).origin})) throw attention("scope_denied");

  return native;
}
function assertRecord(record, operation) {
  if (record.resource_id !== operation.resourceId || record.direction !== "to_discourse" || record.external_id !== operation.externalId || record.canonical_url !== operation.canonicalUrl || record.topic_id !== String(operation.topicId)) throw attention("native_ownership_conflict");
  if (record.source_revision !== operation.acceptedSourceRevision) throw attention("revision_conflict");
}
export async function sweepToWithdrawals({state,pages,census,config,client,connection,save,assertFence}) {
  let count=0;
  for (const operation of Object.values(state.operations)) {
    if (operation.toWithdrawn) continue;
    if (operation.sourceMoves?.pending) continue;
    const eligible=pages.some((page)=>page.mode === "to_discourse" && page.external_id === operation.externalId);
    if (eligible && !operation.pendingToWithdrawal) continue;
    const native=requireBinding(operation,config,connection,client); let pending=operation.pendingToWithdrawal;
    if (operation.pendingToMutation) {
      // This is a closed-source withdrawal of accepted A only. Pending B is
      // immutable uncertainty, not evidence of acceptance or a new predecessor.
      const held=operation.pendingToMutation;
      if (held.request.bridge_record.expected_source_revision !== operation.acceptedSourceRevision
          || held.request.bridge_record.external_id !== operation.externalId
          || held.native_evidence.source_file !== native.source_file
          || held.request.bridge_record.canonical_url !== operation.canonicalUrl) throw attention("metadata_unavailable");
    }
    if (!pending) {
      const fingerprint=await currentFile(native); let reason;
      if (fingerprint === null) reason="source_deleted";
      else {
        if (!census || typeof census.site_origin !== "string") throw attention("metadata_unavailable");
        const origin=new URL(census.site_origin);
        if (origin.origin !== new URL(operation.canonicalUrl).origin || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw attention("scope_denied");
        const matches=census.sources?.filter((entry)=>entry.source_file === native.source_file);
        if (!Array.isArray(matches) || matches.length !== 1) throw attention("metadata_unavailable");
        const source=matches[0];
        if (source.source_sha256 !== fingerprint || typeof source.published !== "boolean" || typeof source.to_opted_in !== "boolean" || typeof source.native_publication !== "boolean" || source.external_id !== undefined && source.external_id !== operation.externalId) throw attention("native_ownership_conflict");
        if (!source.published) reason="source_unpublished";
        else if (!source.to_opted_in || source.native_publication) reason="source_ineligible";
        else throw attention("metadata_unavailable");
      }
      if (operation.pendingToMutation) {
        // Metadata cannot promote B. Only a scoped current A binding permits
        // closing A; B/different binding remains local reconciliation.
        await assertFence(); const retained=(await client.request("V4-04",{path:{resource_id:operation.resourceId}})).value;
        assertRecord(retained,operation); if (retained.state !== "active") throw attention("native_ownership_conflict");
      }
      pending={phase:"intent",request:{mutation_id:randomUUID(),expected_source_revision:operation.acceptedSourceRevision,reason},resource_id:operation.resourceId,
        binding:operation.toBinding,native_evidence:{source_file:native.source_file,source_sha256:fingerprint,reason}};
      validateCms("WithdrawInput",pending.request); operation.pendingToWithdrawal=pending; await save();
    }
    if (pending.resource_id !== operation.resourceId || pending.request.expected_source_revision !== operation.acceptedSourceRevision || semanticIdentity(pending.binding) !== semanticIdentity(operation.toBinding)) throw attention("scope_denied");
    await assertFence(); const current=(await client.request("V4-04",{path:{resource_id:operation.resourceId}})).value; assertRecord(current,operation);
    if (!["active","withdrawn"].includes(current.state)) throw attention("native_ownership_conflict");
    if (pending.phase === "intent") {
      if (await currentFile(native) !== pending.native_evidence.source_sha256) throw attention("native_local_edit_conflict");
      pending.phase="dispatched"; await save();
    }
    await assertFence();
    // On uncertain replay the captured lifecycle event remains historical;
    // never replace its reason/predecessor or silently resume a reappeared page.
    const {value:record}=await client.request("V4-05",{path:{resource_id:pending.resource_id},body:pending.request});
    assertRecord(record,operation); if (record.state !== "withdrawn") throw attention("native_ownership_conflict");
    operation.toWithdrawn={request:pending.request,record,native_evidence:pending.native_evidence}; delete operation.pendingToWithdrawal; await save(); count++;
    // Never clear/replay a pending To02 while settling this independent close.
  }
  return count;
}
