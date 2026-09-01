import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import sanitizeHtml from "sanitize-html";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONNECTION = /^dbc_[a-f0-9]{24}$/;
const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODES = new Set(["simple", "full", "to_discourse", "from_discourse"]);
const enc = new TextEncoder();

export async function syncNativePublications({ contentDir, siteUrl, config, fetchImpl = fetch }) {
  validateConfig(config);
  const site = new URL(siteUrl);
  if (site.protocol !== "https:" || site.username || site.password || site.pathname !== "/" || site.search || site.hash) throw new Error("Hugo site URL must be an HTTPS origin.");
  const summary = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  let page = 1;
  for (;;) {
    const response = await request(config, `/discussion-bridge/v1/bridge-records.json?page=${page}`, { method: "GET" }, fetchImpl);
    const payload = await boundedJson(response, Math.min(config.maxResponseBytes * 4, 262_144));
    if (!response.ok || !Array.isArray(payload.bridge_records) || !payload.pagination || typeof payload.pagination !== "object") throw new Error("DiscussionBridge publication feed is invalid.");
    if (payload.pagination.page !== page || !Number.isSafeInteger(payload.pagination.pages) || payload.pagination.pages < 1 || payload.pagination.pages > 10_000) throw new Error("DiscussionBridge publication pagination is invalid.");
    for (const record of payload.bridge_records) {
      try {
        const item = nativePublication(record, site.origin, config.serverUrl);
        if (!item) { summary.skipped++; continue; }
        const file = path.join(contentDir, "discussionbridge", `${item.slug}.md`);
        const publicationSummary = `Published from The Bridge by ${item.authorName}.`;
        const output = `+++\ntitle = ${JSON.stringify(item.title)}\ndescription = ${JSON.stringify(publicationSummary)}\nsummary = ${JSON.stringify(publicationSummary)}\ndate = ${JSON.stringify(item.updatedAt)}\ndiscussionbridge_mode = "from_discourse"\ndiscussionbridge_resource_id = "${item.resourceId}"\ndiscussionbridge_native_publication = true\ndiscussionbridge_source_author = ${JSON.stringify(item.authorName)}\ndiscussionbridge_source_revision = "${item.revision}"\ndiscussionbridge_adapter_version = "0.1.0-alpha.9"\ndiscussionbridge_topic_id = ${item.topicId}\n+++\n\n{{< discussionbridge mode="from_discourse" >}}\n`;
        let prior = null;
        try { prior = await readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (prior === output) { summary.unchanged++; continue; }
        if (prior && !prior.includes(`discussionbridge_resource_id = "${item.resourceId}"`)) throw new Error("Hugo publication identity collision.");
        await mkdir(path.dirname(file), { recursive: true });
        await atomicWrite(file, output);
        summary[prior ? "updated" : "created"]++;
      } catch { summary.failed++; }
    }
    if (page >= payload.pagination.pages) break;
    page++;
  }
  return summary;
}

function nativePublication(record, siteOrigin, serverUrl) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Hugo publication record is invalid.");
  const bindings = Array.isArray(record.bindings) ? record.bindings.filter((item) => item && typeof item === "object" && !Array.isArray(item) && item.role === "presentation" && item.state === "active") : [];
  if (!bindings.some((item) => item.native_materialization === true)) return null;
  if (bindings.length !== 1 || bindings[0].native_materialization !== true) throw new Error("Hugo publication authority is ambiguous.");
  if (record.direction !== "from_discourse" || record.state !== "healthy" || !Number.isSafeInteger(record.topic_id) || record.topic_id < 1) throw new Error("Hugo publication record is invalid.");
  const id = resourceId(record.resource_id);
  const destination = new URL(bounded(bindings[0].canonical_url, 2048, "Hugo publication destination"));
  if (destination.origin !== siteOrigin || destination.search || destination.hash) throw new Error("Hugo publication destination is invalid.");
  const match = /^\/discussionbridge\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/u.exec(destination.pathname);
  if (!match) throw new Error("Hugo publication path is invalid.");
  const source = record.source;
  const base = serviceBase(serverUrl);
  if (!source || typeof source !== "object" || source.platform !== "discourse" || source.origin !== base.origin || source.topic_id !== record.topic_id || source.post_number !== 1 || !Number.isSafeInteger(source.post_id) || source.post_id < 1 || !Number.isSafeInteger(source.post_version) || source.post_version < 1 || source.revision !== `post:${source.post_id}:version:${source.post_version}`) throw new Error("Hugo publication source is invalid.");
  const identity = presentationIdentity(record, serverUrl, "Hugo publication");
  const updatedAt = bounded(source.updated_at, 64, "Hugo publication update time");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(updatedAt) || !Number.isFinite(Date.parse(updatedAt))) throw new Error("Hugo publication update time is invalid.");
  const authorName = bounded(source.author?.name, 200, "Hugo publication author");
  const profile = new URL(bounded(source.author?.profile_url, 2048, "Hugo publication author URL"));
  if (profile.origin !== base.origin || profile.search || profile.hash) throw new Error("Hugo publication author URL is invalid.");
  return { resourceId: id, slug: match[1], title: bounded(record.title, 1024, "Hugo publication title"), revision: source.revision, updatedAt, authorName, topicId: record.topic_id, topicUrl: identity.topic_url };
}

export async function prepare({ manifestPath, outputPath, config, fetchImpl = fetch }) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const pages = preflight(manifest, config);
  const output = {};
  for (const page of pages) {
    if (page.mode === "simple" && page.topic_id) output[page.key] = await retrieveSimple(page, config, fetchImpl);
    if (page.mode === "to_discourse") output[page.key] = await resolvePage(page, config, fetchImpl);
    if (page.mode === "from_discourse") output[page.key] = await retrieveRecord(page, config, fetchImpl);
  }
  await atomicWrite(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  return { pages: pages.length, records: Object.keys(output).length };
}

export function preflight(manifest, config) {
  validateConfig(config);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !Array.isArray(manifest.pages)) {
    throw new Error("Hugo manifest must contain a pages array.");
  }
  if (manifest.pages.length > 10_000) throw new Error("Hugo manifest exceeds 10,000 pages.");
  const origin = new URL(manifest.site_origin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
    throw new Error("Hugo manifest site_origin must be an HTTPS origin.");
  }
  const keys = new Set(); const urls = new Set();
  const pages = manifest.pages.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Page ${index + 1} is invalid.`);
    const key = bounded(raw.key, 100, "page key");
    if (!KEY.test(key) || keys.has(key)) throw new Error(`Duplicate or invalid page key: ${key}.`);
    keys.add(key);
    if (!MODES.has(raw.mode)) throw new Error(`Page ${key} has an unsupported mode.`);
    const canonical = new URL(bounded(raw.canonical_url, 2048, `${key} canonical URL`));
    if (canonical.protocol !== "https:" || canonical.origin !== origin.origin || canonical.search || canonical.hash) {
      throw new Error(`Page ${key} canonical URL is outside the Hugo site origin.`);
    }
    if (urls.has(canonical.href)) throw new Error(`Duplicate canonical URL: ${canonical.href}.`);
    urls.add(canonical.href);
    const title = bounded(raw.title, 1024, `${key} title`);
    const page = { key, mode: raw.mode, canonical_url: canonical.href, title };
    if (raw.mode === "simple" && raw.topic_id !== undefined) {
      if (!Number.isSafeInteger(raw.topic_id) || raw.topic_id <= 0) throw new Error(`Page ${key} has an invalid topic ID.`);
      page.topic_id = raw.topic_id;
    }
    if (raw.mode === "to_discourse") {
      page.content_html = cleanSourceHtml(boundedText(raw.content_html, 49_152, `${key} content HTML`));
      page.external_id = `hugo-page:${createHash("sha256").update(canonical.href).digest("hex")}`;
      page.source_authors = validateAuthors(raw.source_authors);
      page.primary_source_author_id = raw.primary_source_author_id;
    }
    if (raw.mode === "from_discourse") page.resource_id = resourceId(raw.resource_id);
    return page;
  });
  return pages.sort((a, b) => a.key.localeCompare(b.key, "en"));
}

async function retrieveSimple(page, config, fetchImpl) {
  const base = serviceBase(config.serverUrl);
  const topic = await publicJson(new URL(`/t/${page.topic_id}.json`, base), config, fetchImpl);
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
    simple_html: simpleMarkup(replies, topicUrl, stream.length - 1 > 50) };
}

async function publicJson(url, config, fetchImpl) {
  const base = serviceBase(config.serverUrl);
  const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(config.timeoutMs), headers: { Accept: "application/json" } });
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

function simpleMarkup(replies, topicUrl, truncated) {
  const initial = replies.slice(0, 5).join(""); const rest = replies.slice(5);
  const more = rest.length ? `<details class="discussionbridge-simple__more"><summary><span class="discussionbridge-simple__more-closed">Show ${rest.length} more ${rest.length === 1 ? "comment" : "comments"}</span><span class="discussionbridge-simple__more-open">Show fewer comments</span></summary>${rest.join("")}</details>` : "";
  const limit = truncated ? `<p class="discussionbridge-simple__limit">Showing the first 50 replies. <a href="${escapeHtml(topicUrl)}" rel="nofollow noopener noreferrer">View the complete discussion on The Bridge</a>.</p>` : "";
  return `<div class="discussionbridge-simple__header"><h2>Comments</h2><a href="${escapeHtml(topicUrl)}" rel="nofollow noopener noreferrer">Open discussion</a></div>${replies.length ? initial + more : '<p class="discussionbridge-simple__empty">No comments yet.</p>'}${limit}`;
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }

async function resolvePage(page, config, fetchImpl) {
  const body = { bridge_record: {
    direction: "to_discourse", external_id: page.external_id, canonical_url: page.canonical_url,
    title: page.title, content_html: page.content_html, published: true,
    adapter_id: "hugo-discussion-bridge", adapter_version: "0.1.0-alpha.9",
    correlation_id: randomUUID(), ...(config.lane ? { lane: config.lane } : {}),
    ...(page.source_authors?.length ? { source_authors: page.source_authors, primary_source_author_id: page.primary_source_author_id } : {})
  }};
  const response = await request(config, "/discussion-bridge/v1/bridge-records/resolve.json", { method: "POST", body: JSON.stringify(body) }, fetchImpl);
  const payload = await boundedJson(response, config.maxResponseBytes);
  if (!response.ok || !["created", "resolved"].includes(payload.outcome) || payload.core_fallback !== false || payload.direction !== "to_discourse") {
    throw new Error(`Hugo page ${page.key} was rejected (${response.status}).`);
  }
  return presentationIdentity(payload, config.serverUrl, page.key);
}

async function retrieveRecord(page, config, fetchImpl) {
  const response = await request(config, `/discussion-bridge/v1/bridge-records/${encodeURIComponent(page.resource_id)}.json`, { method: "GET" }, fetchImpl);
  const payload = await boundedJson(response, config.maxResponseBytes);
  const record = payload.bridge_record;
  if (!response.ok || !record || record.direction !== "from_discourse" || record.state !== "healthy" || resourceId(record.resource_id) !== page.resource_id) {
    throw new Error(`Hugo From Discourse record ${page.key} is unavailable.`);
  }
  const identity = presentationIdentity(record, config.serverUrl, page.key);
  const content = sanitizeHtml(boundedText(record.content_html, 65_536, `${page.key} record HTML`), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
    allowedAttributes: { a: ["href", "title", "rel"], img: ["src", "alt", "title", "width", "height"], code: ["class"], pre: ["class"] },
    allowedSchemes: ["https"], allowProtocolRelative: false
  });
  if (!content.trim()) throw new Error(`Hugo From Discourse record ${page.key} sanitized to empty content.`);
  return { ...identity, title: bounded(record.title, 1024, `${page.key} record title`), content_html: content };
}

async function request(config, pathname, init, fetchImpl) {
  const base = serviceBase(config.serverUrl); const endpoint = new URL(pathname, base);
  const response = await fetchImpl(endpoint, { ...init, redirect: "error", signal: AbortSignal.timeout(config.timeoutMs), headers: {
    Accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}),
    "X-DiscussionBridge-Connection": config.connectionId, "X-DiscussionBridge-Secret": config.connectionSecret
  }});
  if (response.url && new URL(response.url).origin !== base.origin) throw new Error("DiscussionBridge response changed service origin.");
  return response;
}

function presentationIdentity(value, serverUrl, key) {
  const id = resourceId(value.resource_id); const topicId = value.topic_id;
  if (!Number.isSafeInteger(topicId) || topicId <= 0) throw new Error(`${key} returned an invalid topic ID.`);
  const topic = new URL(bounded(value.topic_url, 2048, `${key} topic URL`));
  const base = serviceBase(serverUrl);
  if (topic.origin !== base.origin || !new RegExp(`/t/(?:[^/]+/)?${topicId}(?:/|$)`).test(topic.pathname)) throw new Error(`${key} returned an inconsistent topic URL.`);
  return { resource_id: id, topic_id: topicId, topic_url: topic.href, forum_origin: base.origin };
}

function validateConfig(config) {
  serviceBase(config.serverUrl);
  if (!CONNECTION.test(config.connectionId)) throw new Error("DiscussionBridge connection ID is invalid.");
  if (typeof config.connectionSecret !== "string" || config.connectionSecret.length < 32 || config.connectionSecret.length > 256) throw new Error("DiscussionBridge connection secret is invalid.");
  config.timeoutMs ??= 15_000; config.maxResponseBytes ??= 65_536;
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 600_000) throw new Error("DiscussionBridge timeout is invalid.");
  if (!Number.isSafeInteger(config.maxResponseBytes) || config.maxResponseBytes < 1 || config.maxResponseBytes > 1_048_576) throw new Error("DiscussionBridge response bound is invalid.");
  if (config.lane !== undefined) bounded(config.lane, 64, "lane");
}

function serviceBase(value) { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("DiscussionBridge server URL must be HTTPS."); url.pathname = "/"; return url; }
function resourceId(value) { if (typeof value !== "string" || !UUID.test(value)) throw new Error("DiscussionBridge resource ID is invalid."); return value.toLowerCase(); }
function bounded(value, max, label) { if (typeof value !== "string" || !value.trim() || enc.encode(value).byteLength > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} is invalid.`); return value.trim(); }
function boundedText(value, max, label) { if (typeof value !== "string" || !value.trim() || enc.encode(value).byteLength > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error(`${label} is invalid.`); return value.trim(); }
function validateAuthors(value) { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 20) throw new Error("Hugo source authors are invalid."); return value.map((a) => ({ id: bounded(a?.id, 255, "author ID"), name: bounded(a?.name, 200, "author name") })); }
function cleanSourceHtml(value) { const withoutPresentation = value.replace(/<section[^>]+class="discussionbridge-presentation"[\s\S]*?<\/section>/giu, ""); const clean = sanitizeHtml(withoutPresentation, { allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2"]), allowedAttributes: { a: ["href", "title"], img: ["src", "alt", "title", "width", "height"], code: ["class"], pre: ["class"] }, allowedSchemes: ["https"], allowProtocolRelative: false }); if (!clean.trim()) throw new Error("Hugo source content is empty after sanitization."); return clean; }
async function boundedJson(response, maximum) { const declared = Number(response.headers.get("content-length")); if (Number.isFinite(declared) && declared > maximum) throw new Error("DiscussionBridge response is too large."); const type = response.headers.get("content-type") ?? ""; if (!/^application\/json\b/i.test(type)) throw new Error("DiscussionBridge response is not JSON."); const text = await response.text(); if (enc.encode(text).byteLength > maximum) throw new Error("DiscussionBridge response is too large."); const value = JSON.parse(text); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DiscussionBridge response JSON is invalid."); return value; }
async function atomicWrite(file, contents) { const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`); let handle; try { handle = await open(temp, "wx"); await handle.writeFile(contents, "utf8"); await handle.sync(); await handle.close(); handle = undefined; await rename(temp, file); } catch (error) { await handle?.close().catch(() => {}); await rm(temp, { force: true }).catch(() => {}); throw error; } }
