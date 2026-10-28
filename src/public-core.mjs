import { readFile } from "node:fs/promises";
import sanitizeHtml from "sanitize-html";
const enc = new TextEncoder();
const brandingCache = new Map();
const BRANDING_CACHE_MS = 300000;

export async function retrieveSimple(page, config, fetchImpl) {
  config = { timeoutMs: 15000, maxResponseBytes: 65536, ...config };
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 600000
      || !Number.isSafeInteger(config.maxResponseBytes) || config.maxResponseBytes < 1) throw new Error("Hugo Simple public bounds are invalid.");
  const base = serviceBase(config.serverUrl);
  const [topic, poweredBy, wordmark] = await Promise.all([
    publicJson(new URL(`/t/${page.topic_id}.json`, base), config, fetchImpl),
    publicPoweredByDiscourse(base, config, fetchImpl).catch(() => false),
    readFile(new URL("../assets/discourse-wordmark.svg", import.meta.url), "utf8"),
  ]);
  const stream = topic?.post_stream?.stream;
  const initial = topic?.post_stream?.posts;
  if (!Array.isArray(stream) || !Array.isArray(initial)) throw new Error(`Hugo Simple topic ${page.key} is invalid.`);
  const ids = stream.slice(1, 51);
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error(`Hugo Simple topic ${page.key} is invalid.`);
  const byId = new Map(initial.filter((post) => Number.isSafeInteger(post?.id)).map((post) => [post.id, post]));
  const missing = ids.filter((id) => !byId.has(id));
  for (let offset = 0; offset < missing.length; offset += 20) {
    const url = new URL(`/t/${page.topic_id}/posts.json`, base);
    for (const id of missing.slice(offset, offset + 20)) url.searchParams.append("post_ids[]", String(id));
    const batch = await publicJson(url, config, fetchImpl);
    if (!Array.isArray(batch?.post_stream?.posts)) throw new Error(`Hugo Simple topic ${page.key} is invalid.`);
    for (const post of batch.post_stream.posts) {
      if (!Number.isSafeInteger(post?.id) || post.id <= 0) throw new Error(`Hugo Simple topic ${page.key} is invalid.`);
      byId.set(post.id, post);
    }
  }
  const slug = typeof topic.slug === "string" && /^[a-z0-9-]+$/.test(topic.slug) ? topic.slug : "topic";
  const topicUrl = new URL(`/t/${slug}/${page.topic_id}`, base).href;
  const replies = ids.map((id) => simpleReply(byId.get(id), topicUrl, base)).filter(Boolean);
  return { topic_id: page.topic_id, topic_url: topicUrl, forum_origin: base.origin,
    simple_html: simpleMarkup(replies, topicUrl, stream.length - 1 > 50, poweredBy, wordmark) };
}

async function publicPoweredByDiscourse(base, config, fetchImpl) {
  const now = Date.now();
  const cached = brandingCache.get(base.origin);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = readPublicPoweredByDiscourse(base, config, fetchImpl);
  brandingCache.set(base.origin, { expiresAt: now + BRANDING_CACHE_MS, value });
  try { return await value; } catch (error) { brandingCache.delete(base.origin); throw error; }
}

async function readPublicPoweredByDiscourse(base, config, fetchImpl) {
  const response = await fetchImpl(new URL("/", base), {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(config.timeoutMs),
    headers: {
      Accept: "text/html",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    },
  });
  if (response.url && new URL(response.url).origin !== base.origin) throw new Error("Discourse branding response changed service origin.");
  if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) throw new Error("Discourse branding response is invalid.");
  const text = await response.text();
  if (enc.encode(text).byteLength > 512 * 1024) throw new Error("Discourse branding response is too large.");
  const match = /<script[^>]+id=["']data-preloaded["'][^>]*>([\s\S]*?)<\/script>/iu.exec(text);
  if (!match) throw new Error("Discourse branding setting is unavailable.");
  let outer, settings;
  try { outer = JSON.parse(match[1]); settings = JSON.parse(outer.siteSettings); } catch { throw new Error("Discourse branding setting is invalid."); }
  if (typeof settings?.enable_powered_by_discourse !== "boolean") throw new Error("Discourse branding setting is invalid.");
  return settings.enable_powered_by_discourse;
}

async function publicJson(url, config, fetchImpl) {
  const base = serviceBase(config.serverUrl);
  const response = await fetchImpl(url, { method: "GET", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(config.timeoutMs), headers: { Accept: "application/json" } });
  if (response.url && new URL(response.url).origin !== base.origin) throw new Error("Discourse public response changed service origin.");
  if (!response.ok) throw new Error(`Discourse public request failed (${response.status}).`);
  return boundedJson(response, config.maxResponseBytes);
}

function simpleReply(post, topicUrl, base) {
  if (!post || !Number.isSafeInteger(post.post_number) || post.post_number < 2 || typeof post.username !== "string" || !post.username.trim() || typeof post.cooked !== "string" || typeof post.created_at !== "string") throw new Error("Discourse reply is invalid.");
  const date = new Date(post.created_at); if (Number.isNaN(date.valueOf())) throw new Error("Discourse reply is invalid.");
  const body = sanitizeHtml(post.cooked, { allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]), allowedAttributes: { a: ["href", "title", "rel"], img: ["src", "alt", "title", "width", "height"], code: ["class"], pre: ["class"] }, allowedSchemes: ["https"], allowProtocolRelative: false });
  if (!body.trim()) return "";
  const name = typeof post.name === "string" && post.name.trim() ? post.name.trim() : post.username.trim();
  const template = typeof post.avatar_template === "string" && /^\/(?!\/)[^\u0000-\u001f\u007f]{1,500}$/.test(post.avatar_template) ? post.avatar_template : null;
  const avatar = template ? `<img src="${escapeHtml(new URL(template.replace("{size}", "48"), base).href)}" alt="" width="48" height="48" loading="lazy">` : escapeHtml(post.username.trim().slice(0, 1).toUpperCase());
  const href = `${topicUrl}/${post.post_number}`;
  return `<article class="discussionbridge-simple__reply"><span class="discussionbridge-simple__avatar" aria-hidden="true">${avatar}</span><div class="discussionbridge-simple__content"><header class="discussionbridge-simple__meta"><strong>${escapeHtml(name)}</strong><a href="${escapeHtml(href)}" rel="nofollow noopener noreferrer"><time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }))}</time></a></header><div class="discussionbridge-simple__body">${body}</div></div></article>`;
}

function simpleMarkup(replies, topicUrl, truncated, poweredBy, wordmark) {
  const initial = replies.slice(0, 5).join(""); const rest = replies.slice(5);
  const more = rest.length ? `<details class="discussionbridge-simple__more"><summary><span class="discussionbridge-simple__more-closed">Show ${rest.length} more ${rest.length === 1 ? "comment" : "comments"}</span><span class="discussionbridge-simple__more-open">Show fewer comments</span></summary>${rest.join("")}</details>` : "";
  const limit = truncated ? `<p class="discussionbridge-simple__limit">Showing the first 50 comments. <a href="${escapeHtml(topicUrl)}" rel="nofollow noopener noreferrer">View the complete source discussion</a>.</p>` : "";
  const attribution = `<div data-discussionbridge-attributions><a class="discussionbridge-powered-by" data-discussionbridge-powered-by href="https://www.discourse.org/powered-by" aria-label="Powered by Discourse" rel="nofollow noopener noreferrer"${poweredBy ? "" : " hidden"}><span>Powered by</span><span class="discussionbridge-powered-by__wordmark">${wordmark}</span></a></div>`;
  const styles = '<style>.discussionbridge-powered-by{display:flex;align-items:center;justify-content:center;gap:.45rem;margin:.8rem auto 0;color:inherit;font-size:.8rem;text-decoration:none;opacity:.72}.discussionbridge-powered-by[hidden]{display:none}.discussionbridge-powered-by__wordmark{display:inline-flex;width:6.4rem;padding:.12rem .28rem;border-radius:.2rem;background:#fff}.discussionbridge-powered-by__wordmark svg{display:block;width:100%;height:auto}</style>';
  return `<div class="discussionbridge-simple__header"><h2>Comments</h2><a href="${escapeHtml(topicUrl)}" rel="nofollow noopener noreferrer">Open discussion</a></div>${replies.length ? initial + more : '<p class="discussionbridge-simple__empty">No comments yet.</p>'}${limit}${attribution}${styles}`;
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }


function serviceBase(value) { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("DiscussionBridge server URL must be HTTPS."); url.pathname = "/"; return url; }

async function boundedJson(response, maximum) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error("DiscussionBridge response is too large.");
  if (!/^application\/json\b/i.test(response.headers.get("content-type") ?? "")) throw new Error("DiscussionBridge response is not JSON.");
  const reader = response.body?.getReader(); const chunks = []; let length = 0;
  if (!reader) throw new Error("DiscussionBridge response body is unavailable.");
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > maximum) { await reader.cancel(); throw new Error("DiscussionBridge response is too large."); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DiscussionBridge response JSON is invalid."); return value;
}
