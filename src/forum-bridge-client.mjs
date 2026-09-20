import { PRODUCT_VERSION } from "./version.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_REQUEST_BYTES = 256 * 1024;

export class ForumBridgeClient {
  constructor(config, fetchImplementation = fetch) {
    this.config = config;
    this.fetch = fetchImplementation;
  }

  platformCatalogStatus() {
    return this.request("GET", "/discussion-bridge/v1/platform-catalog.json", undefined, 1024 * 1024);
  }

  updatePlatformCatalog(catalog, expectedCatalogRevision) {
    return this.request("PUT", "/discussion-bridge/v1/platform-catalog.json", {
      catalog,
      ...(expectedCatalogRevision ? { expected_catalog_revision: expectedCatalogRevision } : {}),
    });
  }

  sourceTopics(cursor) {
    return this.request("GET", `/discussion-bridge/v1/source-topics.json${this.cursorQuery(cursor)}`, undefined, 1024 * 1024);
  }

  sourceTopic(topicId) {
    this.topicId(topicId);
    return this.request("GET", `/discussion-bridge/v1/source-topics/${topicId}.json`, undefined, 384 * 1024);
  }

  sourceRevocations(cursor) {
    return this.request("GET", `/discussion-bridge/v1/source-revocations.json${this.cursorQuery(cursor)}`, undefined, 1024 * 1024);
  }

  resolveSourceTopic(topicId, publication) {
    this.topicId(topicId);
    return this.request("POST", `/discussion-bridge/v1/source-topics/${topicId}/resolve.json`, { publication });
  }

  acknowledgePublication(resourceId, acknowledgement) {
    if (!UUID.test(resourceId)) throw new Error("Invalid resource ID");
    return this.request("PUT", `/discussion-bridge/v1/bridge-records/${encodeURIComponent(resourceId)}/acknowledgement.json`, { acknowledgement });
  }

  async request(method, pathname, payload, maximumBytes = 65_536) {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    if (body && Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new Error("DiscussionBridge request is too large");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response;
    try {
      response = await this.fetch(`${this.config.serverUrl}${pathname}`, {
        method,
        body,
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          "X-DiscussionBridge-Connection": this.config.connectionId,
          "X-DiscussionBridge-Secret": this.config.connectionSecret,
          "X-DiscussionBridge-Adapter": "hugo-discussion-bridge",
          "X-DiscussionBridge-Adapter-Version": PRODUCT_VERSION,
        },
      });
    } catch {
      throw new Error("DiscussionBridge transport failed");
    } finally {
      clearTimeout(timer);
    }
    if (response.url && new URL(response.url).origin !== this.config.serverUrl) throw new Error("DiscussionBridge response changed origin");
    if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new Error("DiscussionBridge response is not JSON");
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("DiscussionBridge response is too large");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) throw new Error("DiscussionBridge response is too large");
    let data;
    try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error("DiscussionBridge response JSON is invalid"); }
    if (!response.ok) {
      const error = new Error("DiscussionBridge rejected the request");
      error.status = response.status;
      error.reason = typeof data?.reason === "string" ? data.reason : "request_failed";
      throw error;
    }
    return data;
  }

  cursorQuery(cursor) {
    if (cursor === undefined || cursor === null) return "";
    if (typeof cursor !== "string" || !cursor || Buffer.byteLength(cursor) > 8192 || /[\u0000-\u0020\u007f]/u.test(cursor)) throw new Error("Invalid source cursor");
    return `?${new URLSearchParams({ cursor })}`;
  }

  topicId(value) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid topic ID");
  }
}
