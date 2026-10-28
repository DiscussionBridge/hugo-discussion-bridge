import * as currentCodec from "./protocol-v4/cms-runtime.mjs";

export class CmsTransportError extends Error {
  constructor(code, retryAfterSeconds = null) {
    super(`Hugo CMS ${code}; native continuation requires attention or an exact retry.`);
    this.code = code; this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Internal evidence of a fully validated receiver response, not a code-string
// guess about transport outcome. Only the approved preservation response and
// To02 invalid_field refusal use this distinction; route29 is not a Retry grant.
export class CmsReceiverRejection extends CmsTransportError {
  constructor(routeId, status, envelope) {
    super(envelope.code, envelope.retry_after_seconds);
    this.name = "CmsReceiverRejection";
    this.message = `Hugo To ${envelope.code}; this rejected intent has no automatic retry.`;
    this.rejection = Object.freeze({ route_id: routeId, http_status: status, error: Object.freeze({ ...envelope }) });
  }
}

export function createCmsClient(config, { fetchImpl = fetch } = {}) {
  const codec = currentCodec;
  const { CmsValidationError, cmsSchema, parseCmsJson, validateCms, validateCmsResponse, validateCmsRoute } = codec;
  validateCms("ConnectionId", config.connectionId);
  if (typeof config.connectionSecret !== "string" || !config.connectionSecret.isWellFormed() || Buffer.byteLength(config.connectionSecret) < 32
      || Buffer.byteLength(config.connectionSecret) > 256 || /\p{Cc}/u.test(config.connectionSecret)) throw new Error("Hugo CMS connection secret is invalid.");
  let origin;
  try { origin = new URL(config.serverUrl); } catch { throw new Error("Hugo CMS server must be an HTTPS origin."); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Hugo CMS server must be an HTTPS origin.");
  const timeoutMs = config.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("Hugo CMS request deadline is invalid.");
  async function request(id, { body, query = {}, path = {} } = {}) {
    if (!/^V4-(?:0[1-9]|[12][0-9]|3[0-6])$/u.test(id)) throw new Error("Hugo CMS route is outside the active V4 contract.");
    const route = validateCmsRoute(id, { body, query, path });
    const keys = [...route.path.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]);
    if (Object.keys(path).length !== keys.length || Object.keys(path).some((key) => !keys.includes(key))) throw new Error("Hugo CMS path identity is invalid.");
    const url = new URL(route.path.replace(/\{([^}]+)\}/gu, (_, key) => encodeURIComponent(path[key])), origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const rawBody = body === undefined ? undefined : JSON.stringify(body);
    if (rawBody !== undefined && Buffer.byteLength(rawBody) > cmsSchema.transport.request_json_maximum_bytes) throw new CmsTransportError("body_too_large");
    const abort = new AbortController();
    let timer, reader;
    const expired = new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new CmsTransportError("transport_timeout")); }, timeoutMs); });
    const operation = async () => {
      let response;
      try {
        response = await fetchImpl(url, { method: route.method, body: rawBody, redirect: "error", signal: abort.signal, headers: {
          Accept: "application/json", "Accept-Encoding": "identity", ...(rawBody === undefined ? {} : { "Content-Type": "application/json" }),
          "X-DiscussionBridge-Connection": config.connectionId, "X-DiscussionBridge-Secret": config.connectionSecret,
        } });
      } catch { throw new CmsTransportError("transport_timeout"); }
      if (response.redirected || (response.url && new URL(response.url).origin !== origin.origin)) throw new CmsTransportError("scope_denied");
      const maximum = route.response === "ContentChunk" ? 65536 : 262144;
      const chunks = []; let length = 0;
      reader = response.body?.getReader();
      if (reader) for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > maximum) throw new CmsTransportError("metadata_unavailable");
        chunks.push(value);
      }
      const raw = Buffer.concat(chunks, length);
      if (response.status === 204) {
        if (raw.length) throw new CmsTransportError("invalid_json");
        validateCmsResponse(id, undefined, 204); return { status: 204, value: undefined };
      }
      if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/iu.test(response.headers.get("content-type") ?? "")) throw new CmsTransportError("unsupported_media_type");
      const value = parseCmsJson(raw, { maximumBytes: maximum });
      validateCmsResponse(id, value, response.status);
      if (response.status === 422 && value.outcome === "rejected" && value.retryable === false && value.retry_after_seconds === null
          && (["V4-02", "V4-29"].includes(id) && value.code === "content_preservation_unavailable"
            || id === "V4-02" && value.code === "invalid_field")) throw new CmsReceiverRejection(id, response.status, value);
      if (!route.success_http.includes(response.status)) throw new CmsTransportError(value.outcome === "reconciliation_required" ? value.reason : value.code, value.retry_after_seconds);
      return { status: response.status, value };
    };
    try { return await Promise.race([operation(), expired]); }
    catch (error) {
      if (error instanceof CmsTransportError || error instanceof CmsValidationError) throw error;
      throw new CmsTransportError("transport_timeout");
    }
    finally {
      clearTimeout(timer); abort.abort();
      // A stalled body's cancellation callback cannot extend the request deadline.
      try { reader?.cancel().catch(() => {}); } catch {}
      try { reader?.releaseLock(); } catch {}
    }
  }
  return {
    request, origin: origin.origin, connectionId: config.connectionId,
    async authorizeNative(destinationOrigin) {
      validateCms("Url", destinationOrigin);
      const destination = new URL(destinationOrigin);
      if (destination.pathname !== "/" || destination.search) throw new Error("Hugo CMS destination must be an origin.");
      const { value: connection } = await request("V4-01");
      if (connection.connection_id !== config.connectionId || connection.profile !== "hugo" || new URL(connection.destination_origin).origin !== destination.origin
          || !connection.directions.includes("from_discourse") || !connection.policy.enabled || connection.policy.publication_kind !== "static"
          || connection.native_capabilities.publication_kind !== "static"
          || !connection.native_capabilities.supported_presentations.includes(connection.policy.presentation_mode)) throw new CmsTransportError("scope_denied");
      return connection;
    },
  };
}
