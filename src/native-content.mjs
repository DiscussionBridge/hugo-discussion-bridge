import { createHash } from "node:crypto";
import sanitizeHtml from "sanitize-html";
import { decodeHTML } from "entities";

const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// Passive semantics on tags the existing cleaner already supports. These do
// not admit scripts, styles, providers or additional URL schemes.
const passiveAttributes = {
  ol: ["start", "reversed", "type"], li: ["value"],
  td: ["id", "colspan", "rowspan", "headers"], th: ["id", "colspan", "rowspan", "scope", "headers"],
  col: ["span"], colgroup: ["span"], time: ["datetime"],
};

// Resolve only copied relative references. Absolute references and the existing
// rejected protocol-relative form still reach the unchanged sanitizer policy.
export function copiedSourceTarget(value, sourceArticleUrl) {
  if (sourceArticleUrl === undefined || typeof value !== "string" || /^[a-z][a-z0-9+.-]*:/iu.test(value.trimStart()) || value.trimStart().startsWith("//")) return value;
  try { return new URL(value, sourceArticleUrl).href; } catch { return value; }
}
function copiedReferenceTransforms(sourceArticleUrl) {
  return Object.fromEntries([["a", "href"], ["img", "src"]].map(([tag, attribute]) => [tag, (tagName, attributes) => ({
    tagName, attribs: { ...attributes, ...(attributes[attribute] === undefined ? {} : { [attribute]: copiedSourceTarget(attributes[attribute], sourceArticleUrl) }) }
  })]));
}

// Preserve the native To sanitizer and its order: complete sanitized content
// is measured before article selection. Generated Read More is codec-owned.
export function cleanSourceHtml(value, sourceArticleUrl) {
  const withoutPresentation = value.replace(/<section[^>]+class="discussionbridge-presentation"[\s\S]*?<\/section>/giu, "");
  const clean = sanitizeHtml(withoutPresentation, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2"]),
    allowedAttributes: { ...passiveAttributes, a: ["href", "title"], img: ["src", "alt", "title", "width", "height"], code: ["class"], pre: ["class"], span: ["class"], div: ["class"] },
    allowedClasses: { span: ["math"], div: ["math"] },
    allowedSchemes: ["https"], allowProtocolRelative: false,
    transformTags: copiedReferenceTransforms(sourceArticleUrl)
  });
  if (!clean.trim()) throw new Error("Hugo source content is empty after sanitization.");
  return clean;
}

export function completeSourceFingerprint(html) {
  return { content_sha256: createHash("sha256").update(html, "utf8").digest("hex"), content_bytes: Buffer.byteLength(html, "utf8") };
}

export function excerptArticle(html, maximumBytes) {
  const parts = [];
  sanitizeHtml(html, { allowedTags: [], allowedAttributes: {}, textFilter(text) { parts.push(text); return ""; }, onOpenTag(tag) { if (["p", "br", "h1", "h2", "h3", "li"].includes(tag)) parts.push(" "); } });
  const budget = maximumBytes - Buffer.byteLength("<p></p>");
  if (budget < 1) throw new Error("Hugo publication metadata leaves no room for a source excerpt.");
  const characters = [...decodeHTML(parts.join("")).trim()];
  let end = Math.min(characters.length, budget);
  let text = characters.slice(0, end).join("");
  while (Buffer.byteLength(escape(text)) > budget) { end = Math.floor(end * 0.9); text = characters.slice(0, end).join(""); }
  return `<p>${escape(text)}</p>`;
}

export function sanitizePublicationHtml(sourceHtml, sourceArticleUrl) {
  return sanitizeHtml(sourceHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
    allowedAttributes: { ...passiveAttributes, a: ["href", "title", "rel"], img: ["src", "alt", "title", "width", "height"], code: ["class"], pre: ["class"], span: ["class"], div: ["class"] },
    allowedClasses: { span: ["math"], div: ["math"] },
    allowedSchemes: ["https"], allowProtocolRelative: false,
    transformTags: copiedReferenceTransforms(sourceArticleUrl)
  });
}
