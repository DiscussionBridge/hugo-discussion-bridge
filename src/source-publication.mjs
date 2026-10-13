import { createHash } from "node:crypto";
import sanitizeHtml from "sanitize-html";
import { decodeHTML } from "entities";

const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const validTime = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value));

export function sourcePublication(page, createdAt, updatedAt) {
  if (createdAt === undefined && updatedAt === undefined) return undefined;
  if (!validTime(createdAt) || !validTime(updatedAt) || Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error(`Hugo page ${page.key} needs authoritative source creation/update dates.`);
  return { revision: hash(JSON.stringify([page.title, page.full_content_html, page.source_authors, page.primary_source_author_id ?? null, createdAt, updatedAt])), previous_revision: null, created_at: createdAt, updated_at: updatedAt, content_sha256: hash(page.full_content_html), content_bytes: Buffer.byteLength(page.full_content_html), excerpted: Buffer.byteLength(page.full_content_html) > 49152 };
}

export function outboundBody(html, canonicalUrl, maximumBytes = 49152, forceExcerpt = false) {
  if (!forceExcerpt && Buffer.byteLength(html) <= maximumBytes) return html;
  const parts = [];
  sanitizeHtml(html, { allowedTags: [], allowedAttributes: {}, textFilter(text) { parts.push(text); return ""; }, onOpenTag(tag) { if (["p", "br", "h1", "h2", "h3", "li"].includes(tag)) parts.push(" "); } });
  const suffix = `</p><p><a href="${escape(canonicalUrl)}" rel="nofollow noopener noreferrer">Read more at the source</a></p>`;
  const budget = maximumBytes - Buffer.byteLength(`<p>${suffix}`);
  if (budget < 1) throw new Error("Hugo publication metadata leaves no room for a source excerpt.");
  // Slice whole Unicode code points; an excerpt must not introduce an unpaired
  // surrogate when a non-BMP character falls on the boundary.
  const characters = [...decodeHTML(parts.join("")).trim()];
  let end = Math.min(characters.length, budget);
  let text = characters.slice(0, end).join("");
  while (Buffer.byteLength(escape(text)) > budget) { end = Math.floor(end * 0.9); text = characters.slice(0, end).join(""); }
  return `<p>${escape(text)}${suffix}`;
}
