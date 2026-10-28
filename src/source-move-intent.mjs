import { validateCms, projectGeneratedReadMoreMove, validateGeneratedEnvelope } from "./protocol-v4/cms-runtime.mjs";

const attention = () => Object.assign(new Error("Hugo source URL projection is unavailable; inspect the protected source-move journal and native state."), { code: "native_source_public_profile_unresolved" });
// Owned suffix projection is separate from actual native movement/finalization.
export function projectSourceMoveRecord(record, newUrl, newRevision, updatedAt) {
  if (record.representation.kind === "generated_excerpt") return projectGeneratedReadMoreMove(record, newUrl, newRevision, updatedAt);
  validateCms("ToRecord", record); validateCms("Url", newUrl); validateCms("Revision", newRevision);
  if (newRevision === record.source_revision || newUrl === record.canonical_url || new URL(newUrl).origin !== new URL(record.canonical_url).origin) throw attention();
  const result = { ...structuredClone(record), canonical_url: newUrl, expected_source_revision: record.source_revision, source_revision: newRevision, source_updated_at: updatedAt };
  validateGeneratedEnvelope(result); return result;
}
export async function readSourceUrlHistory(client, resourceId, cursor) {
  validateCms("UUID", resourceId);
  return (await client.request("V4-31", { path: { resource_id: resourceId }, query: cursor === undefined ? {} : { cursor } })).value;
}
