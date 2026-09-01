import DOMPurify from "dompurify";

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_REPLIES = 50;
const INITIAL_REPLIES = 5;
const BRANDING_CACHE_MS = 10 * 60 * 1000;
const brandingCache = new Map();

async function refresh(root) {
  const origin = exactOrigin(root.dataset.discourseOrigin);
  const topicId = positiveInteger(root.dataset.topicId);
  const topicUrl = exactTopicUrl(root.dataset.topicUrl, origin, topicId);
  const [topic, poweredBy] = await Promise.all([
    publicJson(new URL(`/t/${topicId}.json`, `${origin}/`), origin),
    poweredByDiscourse(origin).catch(() => undefined),
  ]);
  const stream = topic?.post_stream?.stream;
  const initial = topic?.post_stream?.posts;
  if (!Array.isArray(stream) || !Array.isArray(initial)) throw new Error("Invalid public topic stream.");
  const ids = stream.slice(1, MAX_REPLIES + 1).map(positiveInteger);
  const posts = new Map(initial.filter((post) => validPost(post, topicId)).map((post) => [post.id, post]));
  const missing = ids.filter((id) => !posts.has(id));
  for (let offset = 0; offset < missing.length; offset += 20) {
    const endpoint = new URL(`/t/${topicId}/posts.json`, `${origin}/`);
    for (const id of missing.slice(offset, offset + 20)) endpoint.searchParams.append("post_ids[]", String(id));
    const batch = await publicJson(endpoint, origin);
    if (!Array.isArray(batch?.post_stream?.posts)) throw new Error("Invalid public post batch.");
    for (const post of batch.post_stream.posts) {
      if (!validPost(post, topicId)) throw new Error("Invalid public reply.");
      posts.set(post.id, post);
    }
  }
  const replies = ids.map((id) => posts.get(id));
  if (replies.some((post) => !post)) throw new Error("Incomplete public reply set.");
  if (typeof poweredBy === "boolean") root.querySelector("[data-discussionbridge-powered-by]")?.toggleAttribute("hidden", !poweredBy);
  render(root, replies, topicUrl, origin, stream.length - 1 > MAX_REPLIES);
  root.dataset.discussionbridgeSimpleState = "live";
}

async function publicJson(url, expectedOrigin) {
  const response = await fetch(url, { credentials: "omit", headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (response.url && new URL(response.url).origin !== expectedOrigin) throw new Error("Public response changed forum origin.");
  if (!response.ok) throw new Error(`Public topic request failed (${response.status}).`);
  if (response.headers.get("content-type")?.split(";", 1)[0].toLowerCase() !== "application/json") throw new Error("Public topic response is not JSON.");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Public response is too large.");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("Public response is too large.");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Public response JSON is invalid.");
  return value;
}

function render(root, replies, topicUrl, origin, truncated) {
  const attributions = root.querySelector("[data-discussionbridge-attributions]");
  const fragment = document.createDocumentFragment();
  const header = element("div", "discussionbridge-simple__header");
  header.append(element("h2", "", "Comments"), link(topicUrl, "Open discussion")); fragment.append(header);
  if (!replies.length) {
    const empty = element("p", "discussionbridge-simple__empty", "No comments yet. ");
    empty.append(link(topicUrl, "Start the conversation on The Bridge.")); fragment.append(empty);
  } else {
    for (const post of replies.slice(0, INITIAL_REPLIES)) fragment.append(reply(post, topicUrl, origin));
    const remaining = replies.slice(INITIAL_REPLIES);
    if (remaining.length) {
      const details = element("details", "discussionbridge-simple__more"); const summary = document.createElement("summary");
      summary.append(element("span", "discussionbridge-simple__more-closed", `Show ${remaining.length} more ${remaining.length === 1 ? "comment" : "comments"}`), element("span", "discussionbridge-simple__more-open", "Show fewer comments"));
      details.append(summary, ...remaining.map((post) => reply(post, topicUrl, origin))); fragment.append(details);
    }
  }
  if (truncated) {
    const limit = element("p", "discussionbridge-simple__limit", `Showing the first ${MAX_REPLIES} comments. `);
    limit.append(link(topicUrl, "View the complete discussion on The Bridge"), "."); fragment.append(limit);
  }
  root.replaceChildren(fragment, ...(attributions ? [attributions] : []));
}

async function poweredByDiscourse(origin) {
  const now = Date.now(); const cached = brandingCache.get(origin);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = readPoweredByDiscourse(origin); brandingCache.set(origin, { expiresAt: now + BRANDING_CACHE_MS, value });
  try { return await value; } catch (error) { brandingCache.delete(origin); throw error; }
}

async function readPoweredByDiscourse(origin) {
  const response = await fetch(`${origin}/`, { credentials: "omit", headers: { Accept: "text/html" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (response.url && new URL(response.url).origin !== origin) throw new Error("Discourse bootstrap changed forum origin.");
  if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0].toLowerCase() !== "text/html") throw new Error("Invalid Discourse bootstrap response.");
  const text = await response.text(); if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("Discourse bootstrap is too large.");
  const document = new DOMParser().parseFromString(text, "text/html"); const raw = document.querySelector("script#data-preloaded")?.textContent;
  if (!raw) throw new Error("Discourse bootstrap settings are unavailable.");
  const outer = JSON.parse(raw); const settings = JSON.parse(outer?.siteSettings);
  if (typeof settings?.enable_powered_by_discourse !== "boolean") throw new Error("Discourse branding setting is invalid.");
  return settings.enable_powered_by_discourse;
}

function reply(post, topicUrl, origin) {
  const article = element("article", "discussionbridge-simple__reply"); const avatar = element("span", "discussionbridge-simple__avatar"); avatar.setAttribute("aria-hidden", "true");
  const template = post.avatar_template?.replace("{size}", "48"); const avatarUrl = template && safeHttpsUrl(template, origin);
  if (avatarUrl) { const image = document.createElement("img"); image.src = avatarUrl; image.alt = ""; image.width = 48; image.height = 48; image.loading = "lazy"; avatar.append(image); }
  else avatar.textContent = post.username.slice(0, 1).toUpperCase();
  const content = element("div", "discussionbridge-simple__content"); const meta = element("header", "discussionbridge-simple__meta");
  meta.append(element("strong", "", post.name?.trim() || post.username)); const dateLink = link(`${topicUrl}/${post.post_number}`, ""); const time = document.createElement("time");
  time.dateTime = post.created_at; time.textContent = new Date(post.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }); dateLink.append(time); meta.append(dateLink);
  const body = element("div", "discussionbridge-simple__body"); body.append(sanitizedBody(post.cooked, origin)); content.append(meta, body); article.append(avatar, content); return article;
}

function sanitizedBody(cooked, origin) {
  const clean = DOMPurify.sanitize(cooked, { ALLOWED_TAGS: ["a", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "s", "span", "strong", "ul"], ALLOWED_ATTR: ["alt", "class", "height", "href", "src", "title", "width"], RETURN_DOM_FRAGMENT: true });
  for (const node of clean.querySelectorAll("[href], [src]")) {
    for (const attribute of ["href", "src"]) { const value = node.getAttribute(attribute); if (!value) continue; const safe = safeHttpsUrl(value, origin); if (safe) node.setAttribute(attribute, safe); else node.removeAttribute(attribute); }
    if (node instanceof HTMLAnchorElement) node.rel = "nofollow noopener noreferrer";
  }
  return clean;
}

function validPost(post, topicId) { return post && typeof post === "object" && Number.isSafeInteger(post.id) && post.id > 0 && Number.isSafeInteger(post.post_number) && post.post_number > 1 && post.topic_id === topicId && typeof post.username === "string" && post.username.trim() && post.username.length <= 100 && typeof post.cooked === "string" && typeof post.created_at === "string" && Number.isFinite(Date.parse(post.created_at)); }
function positiveInteger(value) { const text = typeof value === "number" ? String(value) : value; if (typeof text !== "string" || !/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error("Invalid positive integer."); return Number(text); }
function exactOrigin(value) { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid forum origin."); return url.origin; }
function exactTopicUrl(value, origin, topicId) { const url = new URL(value); if (url.protocol !== "https:" || url.origin !== origin || !new RegExp(`/t/(?:[^/]+/)?${topicId}(?:/|$)`).test(url.pathname)) throw new Error("Invalid topic URL."); return url.href.replace(/\/$/, ""); }
function safeHttpsUrl(value, base) { try { const url = new URL(value, `${base}/`); return url.protocol === "https:" ? url.href : undefined; } catch { return undefined; } }
function element(tag, className = "", text = "") { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; }
function link(href, text) { const node = document.createElement("a"); node.href = href; node.textContent = text; node.rel = "nofollow noopener noreferrer"; return node; }

for (const root of document.querySelectorAll("[data-discussionbridge-simple-live]")) {
  refresh(root).catch(() => { root.dataset.discussionbridgeSimpleState = "snapshot"; root.querySelector("[data-discussionbridge-simple-status]")?.removeAttribute("hidden"); });
}
