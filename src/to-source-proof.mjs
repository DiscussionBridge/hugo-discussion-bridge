import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { decodeHTML } from "entities";
import { nativeSemanticJson } from "./native-state.mjs";
import { validateCms } from "./protocol-v4/cms-runtime.mjs";
import { validateSourceCapture } from "./source-preparation.mjs";
import path from "node:path";

// Resolve the parser through the existing sanitizer dependency, including
// isolated package-manager layouts. No additional runtime dependency is needed.
const { parseDocument } = createRequire(import.meta.resolve("sanitize-html"))("htmlparser2");

export const HUGO_TO_SOURCE_PROFILE = "hugo-to-owned-full-article-1";
export const sourceDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const failed = () => Object.assign(new Error("Hugo source public verification requires the complete owned native article, current edition and issued challenge."), { code: "public_verification_failed" });
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

// This is a component-private To receipt. It is never a From Work receipt or a
// claim that the receiver independently fetched/inspected a native CMS object.
export function validateToSourceReceipt(receipt) {
  if (!exact(receipt, ["schema_version", "verification_profile", "binding", "resource_id", "topic_id", "external_id", "native_id", "canonical_url", "source_revision",
    "source_file_sha256", "source_content_sha256", "source_content_bytes", "title", "source_authors", "source_created_at", "source_updated_at", "capture",
    "native_inputs_sha256", "public_data_sha256", "move_id", "proof_nonce"])
      || receipt.schema_version !== "db-hugo-to-source-receipt-1" || receipt.verification_profile !== HUGO_TO_SOURCE_PROFILE) throw failed();
  if (!exact(receipt.binding, ["connection_id", "forum_origin", "site_root", "content_root", "scope_revision", "lane"])) throw failed();
  validateCms("ConnectionId", receipt.binding.connection_id); validateCms("Url", receipt.binding.forum_origin);
  validateCms("Revision", receipt.binding.scope_revision); validateCms("Lane", receipt.binding.lane);
  if (!path.isAbsolute(receipt.binding.site_root) || !path.isAbsolute(receipt.binding.content_root)) throw failed();
  validateCms("UUID", receipt.resource_id);
  if (receipt.move_id !== null) validateCms("UUID", receipt.move_id);
  validateCms("CoreId", receipt.topic_id);
  validateCms("OpaqueId", receipt.external_id);
  if (typeof receipt.native_id !== "string" || !receipt.native_id || /[\\\p{Cc}]/u.test(receipt.native_id)
      || receipt.native_id.split("/").some((part) => ["", ".", ".."].includes(part))) throw failed();
  validateCms("Url", receipt.canonical_url); validateCms("Revision", receipt.source_revision);
  for (const key of ["source_file_sha256", "source_content_sha256", "native_inputs_sha256"]) validateCms("Sha256", receipt[key]);
  if (receipt.public_data_sha256 !== null) validateCms("Sha256", receipt.public_data_sha256);
  validateCms("UInt", receipt.source_content_bytes); validateCms("Title", receipt.title); validateCms("SourceAuthors", receipt.source_authors);
  for (const key of ["source_created_at", "source_updated_at"]) if (receipt[key] !== null) validateCms("Instant", receipt[key]);
  if (receipt.proof_nonce !== null) validateCms("PublicNonce", receipt.proof_nonce);
  if ((receipt.move_id === null) !== (receipt.proof_nonce === null)) throw failed();
  if (!exact(receipt.capture, ["birth", "native_before", "native_after", "prepared"])) throw failed();
  validateSourceCapture(receipt.capture.birth);
  for (const key of ["native_before", "native_after", "prepared"]) {
    const blob = receipt.capture[key];
    if (!exact(blob, ["path", "bytes", "sha256"]) || !/^source-moves\/[a-f0-9-]{36}\/[a-z0-9.-]+$/u.test(blob.path)) throw failed();
    validateCms("UInt", blob.bytes); validateCms("Sha256", blob.sha256);
  }
  if (receipt.capture.birth.source_id !== receipt.external_id || receipt.capture.prepared.sha256 !== receipt.source_content_sha256
      || receipt.capture.prepared.bytes !== receipt.source_content_bytes) throw failed();
  return receipt;
}
export function hashToSourceReceipt(receipt) {
  return sourceDigest(Buffer.from(nativeSemanticJson(validateToSourceReceipt(receipt))));
}

function hiddenStyle(style) {
  const declarations = []; let part = "", quote = null, depth = 0;
  for (let i = 0; i < style.length; i++) {
    const char = style[i];
    if (quote !== null) {
      part += char;
      if (char === "\\" && i + 1 < style.length) part += style[++i];
      else if (char === quote) quote = null;
    } else if (char === "/" && style[i + 1] === "*") {
      const end = style.indexOf("*/", i + 2); if (end < 0) break;
      part += " "; i = end + 1;
    } else if (char === '"' || char === "'") { quote = char; part += char; }
    else if (char === "(") { depth++; part += char; }
    else if (char === ")") { depth = Math.max(0, depth - 1); part += char; }
    else if (char === ";" && depth === 0) { declarations.push(part); part = ""; }
    else part += char;
  }
  declarations.push(part);
  const values = new Map();
  const supported = {
    display: new Set(["none", "block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "flow-root", "contents", "table", "inline-table", "table-row", "table-cell", "list-item", "initial"]),
    visibility: new Set(["visible", "hidden", "collapse", "initial"]),
    "content-visibility": new Set(["visible", "hidden", "auto", "initial"]),
  };
  for (const declaration of declarations) {
    const colon = declaration.indexOf(":"); if (colon < 0) continue;
    const name = declaration.slice(0, colon).trim().toLowerCase();
    const raw = declaration.slice(colon + 1), important = /!\s*important\s*$/iu.test(raw);
    const value = raw.replace(/!\s*important\s*$/iu, "").trim().toLowerCase();
    if (!Object.hasOwn(supported, name) || !supported[name].has(value)) continue;
    if (!values.get(name)?.important || important) values.set(name, { value, important });
  }
  return values.get("display")?.value === "none" || ["hidden", "collapse"].includes(values.get("visibility")?.value)
    || values.get("content-visibility")?.value === "hidden";
}
function inactive(node) {
  for (let current = node; current; current = current.parent) {
    const attributes = current.attribs ?? {};
    if (["template", "noscript", "textarea", "script", "style", "title", "xmp", "iframe", "noembed", "noframes", "plaintext"].includes(current.name)
        || Object.hasOwn(attributes, "hidden") || Object.hasOwn(attributes, "inert")
        || hiddenStyle(attributes.style ?? "")) return true;
  }
  return false;
}
function activeFrame(html, frame, opening, receipt) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(html); } catch { throw failed(); }
  const start = `<!--discussionbridge-to-source-start:${receipt.resource_id}-->`, end = `<!--discussionbridge-to-source-end:${receipt.resource_id}-->`;
  const at = text.indexOf(start), finish = text.indexOf(end), ownerAt = at + opening[0].lastIndexOf("<article");
  const nodes = [], pending = [parseDocument(text, { decodeEntities: true, withStartIndices: true, withEndIndices: true })];
  while (pending.length) { const node = pending.pop(); nodes.push(node); if (node.children) for (const child of node.children) pending.push(child); }
  const comment = (position, marker) => nodes.find((node) => node.type === "comment" && node.startIndex === position && node.data === marker.slice(4, -3));
  const before = comment(at, start), after = comment(finish, end);
  const owner = nodes.find((node) => node.name === "article" && node.startIndex === ownerAt);
  if (!before || !after || !owner || owner.parent !== before.parent || owner.parent !== after.parent || owner.endIndex >= finish
      || text.slice(before.endIndex + 1, ownerAt).trim() || text.slice(owner.endIndex + 1, finish).trim() || inactive(owner)) throw failed();
  const title = (owner.children ?? []).find((node) => node.name === "h1");
  if (title && inactive(title)) throw failed();
  const bodyStart = "<!--discussionbridge-to-source-article-start-->", bodyEnd = "<!--discussionbridge-to-source-article-end-->";
  const bodyBefore = comment(at + frame.indexOf(bodyStart), bodyStart), bodyAfter = comment(at + frame.indexOf(bodyEnd), bodyEnd);
  const belongs = (node) => { for (let current = node?.parent; current; current = current.parent) if (current === owner) return true; return false; };
  if (!bodyBefore || !bodyAfter || bodyBefore.parent !== bodyAfter.parent || !belongs(bodyBefore) || !belongs(bodyAfter)
      || inactive(bodyBefore) || inactive(bodyAfter)) throw failed();
}

// Validate only response metadata needed by this existing UTF-8 reader. Benign
// MIME parameters stay supported; conflicting/ambiguous charset is not proof.
function utf8Html(value) {
  const essence = /^[ \t]*text\/html(?=[ \t]*(?:;|$))/iu.exec(value);
  if (!essence) return false;
  let remaining = value.slice(essence[0].length), charset = false;
  const parameter = /^[ \t]*;[ \t]*([!#$%&'*+.^_`|~a-z0-9-]+)[ \t]*=[ \t]*(?:"((?:[^"\\\r\n]|\\[\t\x20-\x7e])*)"|([!#$%&'*+.^_`|~a-z0-9-]+))[ \t]*/iu;
  while (!/^[ \t]*$/u.test(remaining)) {
    const match = parameter.exec(remaining); if (!match) return false;
    remaining = remaining.slice(match[0].length);
    if (match[1].toLowerCase() === "charset") {
      const encoding = (match[2] ?? match[3]).replace(/\\(.)/gu, "$1");
      if (charset || encoding.toLowerCase() !== "utf-8") return false;
      charset = true;
    }
  }
  return true;
}

export function ownedToSourceArticle(html, receipt, completeArticle) {
  validateToSourceReceipt(receipt);
  if (!Buffer.isBuffer(html) || !Buffer.isBuffer(completeArticle) || sourceDigest(completeArticle) !== receipt.source_content_sha256
      || completeArticle.length !== receipt.source_content_bytes || receipt.move_id === null) throw failed();
  const start = Buffer.from(`<!--discussionbridge-to-source-start:${receipt.resource_id}-->`), end = Buffer.from(`<!--discussionbridge-to-source-end:${receipt.resource_id}-->`);
  const at = html.indexOf(start), last = html.indexOf(end);
  if (at < 0 || last < at + start.length || html.indexOf(start, at + start.length) !== -1 || html.indexOf(end, last + end.length) !== -1) throw failed();
  const frame = html.subarray(at, last + end.length);
  let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(frame); } catch { throw failed(); }
  const open = /^<!--discussionbridge-to-source-start:[^>]+-->\s*<article\b([^>]*)>/u.exec(text);
  if (!open) throw failed();
  const attributes = new Map();
  for (const [, key, value] of open[1].matchAll(/\b(data-discussionbridge-to-[a-z0-9-]+)="([^"]*)"/gu)) {
    if (attributes.has(key)) throw failed(); attributes.set(key, decodeHTML(value));
  }
  const expected = { profile: HUGO_TO_SOURCE_PROFILE, "resource-id": receipt.resource_id, "topic-id": receipt.topic_id, "external-id": receipt.external_id,
    "native-id": receipt.native_id, "canonical-url": receipt.canonical_url, "source-revision": receipt.source_revision,
    "source-file-sha256": receipt.source_file_sha256, "source-content-sha256": receipt.source_content_sha256,
    "source-authors-sha256": sourceDigest(Buffer.from(nativeSemanticJson(receipt.source_authors))), title: receipt.title,
    "move-id": receipt.move_id, "proof-nonce": receipt.proof_nonce };
  for (const [key, value] of Object.entries(expected)) if (attributes.get(`data-discussionbridge-to-${key}`) !== value) throw failed();
  const bodyStart = Buffer.from("<!--discussionbridge-to-source-article-start-->"), bodyEnd = Buffer.from("<!--discussionbridge-to-source-article-end-->");
  const bodyAt = frame.indexOf(bodyStart), bodyLast = frame.indexOf(bodyEnd);
  if (bodyAt < 0 || bodyLast < bodyAt + bodyStart.length || frame.indexOf(bodyStart, bodyAt + bodyStart.length) !== -1
      || frame.indexOf(bodyEnd, bodyLast + bodyEnd.length) !== -1 || !frame.subarray(bodyAt + bodyStart.length, bodyLast).equals(completeArticle)) throw failed();
  activeFrame(html, text, open, receipt);
  return { bytes: frame, sha256: sourceDigest(frame) };
}

export async function verifyToSourcePublic({ receipt, completeArticle, expectedHtml, publicFetch = fetch, timeoutMs = 15000, notBefore, now = Date.now }) {
  const expected = ownedToSourceArticle(expectedHtml, receipt, completeArticle), url = new URL(receipt.canonical_url);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || url.username || url.password) throw failed();
  const abort = new AbortController(); let reader, timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(failed()); }, timeoutMs); });
  const operation = async () => {
    const response = await publicFetch(url, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store", signal: abort.signal,
      headers: { Accept: "text/html", "Accept-Encoding": "identity" } });
    if (response.redirected || response.url && response.url !== url.href || response.status !== 200
        || !utf8Html(response.headers.get("content-type") ?? "")) throw failed();
    const chunks = []; let bytes = 0; reader = response.body?.getReader(); if (!reader) throw failed();
    for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
      if (bytes > expectedHtml.byteLength) throw failed(); chunks.push(part.value); }
    const actual = ownedToSourceArticle(Buffer.concat(chunks, bytes), receipt, completeArticle);
    if (!actual.bytes.equals(expected.bytes)) throw failed();
    const checkedAt = new Date(now()).toISOString(); if (notBefore && checkedAt < notBefore) throw failed();
    return validateCms("SourceUrlVerification", { url: receipt.canonical_url, external_id: receipt.external_id, source_revision: receipt.source_revision,
      source_content_sha256: receipt.source_content_sha256, native_ownership_receipt_sha256: hashToSourceReceipt(receipt),
      native_publication_sha256: actual.sha256, verification_profile: HUGO_TO_SOURCE_PROFILE, checked_at: checkedAt });
  };
  try { return await Promise.race([operation(), expired]); } catch { throw failed(); }
  finally { clearTimeout(timer); abort.abort(); try { reader?.cancel().catch(() => {}); } catch {} try { reader?.releaseLock(); } catch {} }
}
