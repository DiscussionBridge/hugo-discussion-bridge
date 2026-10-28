import { createHash } from "node:crypto";
import { decodeHTML } from "entities";
import { validateCms } from "./protocol-v4/cms-runtime.mjs";

export const HUGO_CMS_VERIFICATION_PROFILE = "hugo-cms-owned-fragment-1";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const failed = () => Object.assign(new Error("Hugo CMS public_verification_failed; exact native content, identity and discussion require attention."), { code: "public_verification_failed" });

export function ownedNativeFragment(html, expected) {
  if (!Buffer.isBuffer(html)) throw failed();
  validateCms("UUID", expected.mappingId);
  const begin = Buffer.from(`<!--discussionbridge-cms-start:${expected.mappingId}-->`);
  const end = Buffer.from(`<!--discussionbridge-cms-end:${expected.mappingId}-->`);
  const first = html.indexOf(begin), last = html.indexOf(end);
  if (first < 0 || last < first + begin.length || html.indexOf(begin, first + begin.length) !== -1 || html.indexOf(end, last + end.length) !== -1) throw failed();
  const fragment = html.subarray(first, last + end.length);
  let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(fragment); } catch { throw failed(); }
  const section = /^<!--discussionbridge-cms-start:[^>]+-->\s*<section\b([^>]*)>/u.exec(text);
  if (!section) throw failed();
  const attributes = new Map();
  for (const [, key, value] of section[1].matchAll(/\b(data-discussionbridge-cms-[a-z-]+)="([^"]*)"/gu)) {
    if (attributes.has(key)) throw failed(); attributes.set(key, decodeHTML(value));
  }
  for (const [key, value] of Object.entries({ "resource-id": expected.resourceId, "native-id": expected.nativeId, "source-revision": expected.sourceRevision, "presentation": expected.presentationMode })) {
    if (attributes.get(`data-discussionbridge-cms-${key}`) !== value) throw failed();
  }
  if (expected.moveId !== undefined || expected.proofNonce !== undefined) {
    validateCms("UUID", expected.moveId); validateCms("PublicNonce", expected.proofNonce); validateCms("Url", expected.canonicalUrl);
    for (const [key, value] of Object.entries({ "move-id": expected.moveId, "proof-nonce": expected.proofNonce, "canonical-url": expected.canonicalUrl })) {
      if (attributes.get(`data-discussionbridge-cms-${key}`) !== value) throw failed();
    }
  }
  if (!text.includes('class="discussionbridge-from"') || !text.includes('id="discourse-comments"') && !text.includes("data-discussionbridge-simple-live")) throw failed();
  return { bytes: fragment, sha256: sha(fragment) };
}

export async function verifyNativePublic({ action, receipt, representation, expectedHtml, presentationMode, destinationOrigin, timeoutMs = 15000, publicFetch = fetch, now = Date.now }) {
  validateCms("NativeOwnershipReceipt", receipt); validateCms("Url", destinationOrigin);
  const url = new URL(receipt.canonical_url);
  if (url.origin !== new URL(destinationOrigin).origin || !["publish_revision", "withdraw"].includes(action)) throw failed();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw failed();
  const expected = { mappingId: receipt.mapping_id, resourceId: receipt.resource_id, nativeId: receipt.native_id, sourceRevision: receipt.source_revision, presentationMode };
  if ((receipt.move_id === null) !== (receipt.proof_nonce === null)) throw failed();
  if (receipt.move_id !== null) Object.assign(expected, { moveId: receipt.move_id, proofNonce: receipt.proof_nonce, canonicalUrl: receipt.canonical_url });
  const native = action === "publish_revision" ? ownedNativeFragment(expectedHtml, expected) : null;
  if (action === "publish_revision") validateCms("Representation", representation);
  const abort = new AbortController(); let timer, reader;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(failed()); }, timeoutMs); });
  const operation = async () => {
    const response = await publicFetch(url, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store", signal: abort.signal, headers: { Accept: "text/html", "Accept-Encoding": "identity" } });
    if (response.redirected || response.url && new URL(response.url).href !== url.href) throw failed();
    if (action === "withdraw") {
      if (![404, 410].includes(response.status)) throw failed();
      response.body?.cancel().catch(() => {});
      const verification = { kind: "absent", url: receipt.canonical_url, native_id: receipt.native_id, checked_at: new Date(now()).toISOString(), http_status: response.status };
      return validateCms("AbsentVerification", verification);
    }
    if (response.status !== 200 || !/^text\/html(?:\s*;|\s*$)/iu.test(response.headers.get("content-type") ?? "")) throw failed();
    // The budget follows this actual complete native build artifact, not a
    // metadata bound or universal publication-size limit. An overrun fails;
    // no partial response is ever accepted as a publication.
    const chunks = []; let length = 0;
    reader = response.body?.getReader(); if (!reader) throw failed();
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength; if (length > expectedHtml.byteLength) throw failed(); chunks.push(value);
    }
    const actual = ownedNativeFragment(Buffer.concat(chunks, length), expected);
    if (actual.sha256 !== native.sha256 || !actual.bytes.equals(native.bytes)) throw failed();
    const verification = { kind: "published", url: receipt.canonical_url, native_id: receipt.native_id, source_revision: receipt.source_revision,
      source_content_sha256: representation.source_content_sha256, native_publication_sha256: actual.sha256,
      verification_profile: HUGO_CMS_VERIFICATION_PROFILE, checked_at: new Date(now()).toISOString(), representation };
    return validateCms("PublishedVerification", verification);
  };
  try { return await Promise.race([operation(), expired]); }
  catch { throw failed(); }
  finally { clearTimeout(timer); abort.abort(); try { reader?.cancel().catch(() => {}); } catch {} try { reader?.releaseLock(); } catch {} }
}
