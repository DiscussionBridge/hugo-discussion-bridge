export const cmsConfig = { serverUrl: "https://forum.example", connectionId: "dbc_0123456789abcdef01234567", connectionSecret: "s".repeat(48) };
export const nativeOrigin = "https://hugo.example";
export function connection() {
  return { connection_id: cmsConfig.connectionId, profile: "hugo", destination_origin: nativeOrigin,
    scope_revision: "scope-1", forum_name: "Source Forum", directions: ["from_discourse"], publication_lane: "default",
    policy: { policy_revision: "policy-1", enabled: true, selection: "all_public", category_ids: [], include_topic_ids: [], exclude_topic_ids: [], include_unlisted: false,
      publication_kind: "static", presentation_mode: "interactive", author_ids: [], taxonomy_ids: [] },
    native_capabilities: { native_revision: "hugo-1", supported_presentations: ["simple", "full", "interactive"], publication_kind: "static", complete_content_supported: true } };
}
export const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
export const mappingId = "11111111-1111-4111-8111-111111111111";
export const workId = "33333333-3333-4333-8333-333333333333";
export const leaseToken = Buffer.alloc(32, 7).toString("base64url");
export function work() {
  return { work_id: workId, mapping_id: mappingId, source_id: "source-a", source_revision: "revision-1", policy_revision: "policy-1", action: "publish_revision", state: "leased",
    attempt_cycle: "55555555-5555-4555-8555-555555555555", attempt: 1, lease_generation: 1, retry_at: null, last_failure_code: null };
}
export function lease() {
  return { work: work(), lease_token: leaseToken, lease_generation: 1, expires_at: "2026-10-14T12:05:00.000Z", server_time: "2026-10-14T12:00:00.000Z" };
}
