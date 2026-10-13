import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import sanitizeHtml from "sanitize-html";
import { PRODUCT_VERSION } from "./version.mjs";
import { nativePublicationIdentity, writeNativePublication } from "./publication-file.mjs";
import { hydratePublication, PUBLICATION_CONTRACT, SourceChanged } from "./publication-content.mjs";
import { outboundBody, sourcePublication } from "./source-publication.mjs";
import { beginAttempt, completeAttempt, failAttempt, readOperationalState, stageAttemptResult, withOperationalStateLock, writeOperationalState } from "./operational-state.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONNECTION = /^dbc_[a-f0-9]{24}$/;
const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODES = new Set(["simple", "full", "interactive", "to_discourse", "from_discourse"]);
const enc = new TextEncoder();
const BRANDING_CACHE_MS = 10 * 60 * 1000;
const brandingCache = new Map();

export async function syncNativePublications({ contentDir, siteUrl, config, fetchImpl = fetch }) {
  validateConfig(config);
  const site = new URL(siteUrl);
  if (site.protocol !== "https:" || site.username || site.password || site.pathname !== "/" || site.search || site.hash) throw new Error("Hugo site URL must be an HTTPS origin.");
  const summary = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  const nativeFiles = new Map();
  const nativeDirectory = path.join(contentDir, "discussionbridge");
  let entries = [];
  try { if ((await lstat(nativeDirectory)).isSymbolicLink()) throw new Error("Hugo native content directory must not be linked."); entries = await readdir(nativeDirectory, { withFileTypes: true }); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (entries.length > 10000) throw new Error("Hugo native file census exceeds its bounded namespace.");
  for (const entry of entries) {
    if (!/\.(?:md|markdown)$/iu.test(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error("Hugo native file census must not follow links.");
    if (!entry.isFile()) continue;
    const file = path.resolve(nativeDirectory, entry.name), identity = nativePublicationIdentity(await readFile(file, "utf8"));
    if (!identity) continue;
    const list = nativeFiles.get(identity.resourceId) ?? []; list.push({ ...identity, file }); nativeFiles.set(identity.resourceId, list);
  }
  let page = 1;
  let snapshot; let expectedPages; let expectedTotal;
  const seenResources = new Set();
  for (;;) {
    const query = new URLSearchParams({ page: String(page), publication_contract: PUBLICATION_CONTRACT });
    if (snapshot) query.set("snapshot", snapshot);
    const response = await request(config, `/discussion-bridge/v1/bridge-records.json?${query}`, { method: "GET" }, fetchImpl);
    const payload = await boundedJson(response, 2 * 1024 * 1024);
    if (!response.ok || !Array.isArray(payload.bridge_records) || !payload.pagination || typeof payload.pagination !== "object") throw new Error("DiscussionBridge publication feed is invalid.");
    if (payload.pagination.page !== page || !Number.isSafeInteger(payload.pagination.pages) || payload.pagination.pages < 1 || payload.pagination.pages > 10_000 || !Number.isSafeInteger(payload.pagination.total) || payload.pagination.total < 0 || typeof payload.pagination.snapshot !== "string" || !payload.pagination.snapshot || payload.pagination.snapshot.length > 8_192) throw new Error("DiscussionBridge publication pagination is invalid.");
    if (page === 1) {
      snapshot = payload.pagination.snapshot; expectedPages = payload.pagination.pages; expectedTotal = payload.pagination.total;
    } else if (payload.pagination.snapshot !== snapshot || payload.pagination.pages !== expectedPages || payload.pagination.total !== expectedTotal) {
      throw new Error("DiscussionBridge publication feed changed during synchronization.");
    }
    for (const record of payload.bridge_records) {
      const feedResourceId = resourceId(record?.resource_id);
      if (seenResources.has(feedResourceId)) throw new Error("DiscussionBridge publication feed contains a duplicate resource identity.");
      seenResources.add(feedResourceId);
      try {
        const item = nativePublication(record, site.origin, config);
        if (!item) { summary.skipped++; continue; }
        const file = path.join(contentDir, "discussionbridge", `${item.slug}.md`);
        const matches = nativeFiles.get(item.resourceId) ?? [];
        const equalPath = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
        if (matches.length > 1 || (matches[0] && (equalPath(matches[0].file) !== equalPath(file) || matches[0].topicId !== item.topicId))) throw new Error("Hugo native resource/topic or canonical binding location changed; reconciliation is required.");
        item.createSelected = typeof config.nativeShortcode === "string" && config.nativeShortcode !== "none";
        item.integrationDeclined = config.nativeShortcode === "none";
        if (item.withdrawn) {
          const outcome = await writeNativePublication(file, "", item);
          summary[outcome] = (summary[outcome] ?? 0) + 1;
          continue;
        }
        const publicationSummary = `Published from ${item.forumName} by ${item.authorName}.`;
        item.managedFields = { title: item.title, description: publicationSummary, summary: publicationSummary, lastmod: item.updatedAt, discussionbridge_source_updated_at: item.updatedAt, discussionbridge_source_author: item.authorName, discussionbridge_forum_name: item.forumName };
        if (item.createdAt) Object.assign(item.managedFields, { date: item.createdAt, discussionbridge_source_created_at: item.createdAt });
        const metadata = { ...item.managedFields, discussionbridge_mode: "from_discourse", discussionbridge_resource_id: item.resourceId, discussionbridge_native_publication: true, discussionbridge_source_revision: item.revision, discussionbridge_adapter_version: PRODUCT_VERSION, discussionbridge_topic_id: item.topicId, discussionbridge_source_managed: JSON.stringify(item.managedFields) };
        if (item.edition) metadata.discussionbridge_source_edition = item.edition;
        if (item.presentationMode) metadata.discussionbridge_presentation_mode = item.presentationMode;
        const output = `+++\n${Object.entries(metadata).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n")}\n+++\n\n{{< ${config.nativeShortcode ?? "discussionbridge"} mode="from_discourse" >}}\n`;
        const outcome = await writeNativePublication(file, output, item);
        summary[outcome] = (summary[outcome] ?? 0) + 1;
        if (outcome === "created") nativeFiles.set(item.resourceId, [{ resourceId: item.resourceId, topicId: item.topicId, file: path.resolve(file) }]);
      } catch (error) {
        summary.failed++;
        summary.errors ??= [];
        if (summary.errors.length < 20) summary.errors.push({ resource_id: feedResourceId, reason: error instanceof Error && error.message.startsWith("Hugo ") ? error.message.slice(0, 240) : "Hugo publication could not be committed; native content was retained." });
      }
    }
    if (page >= payload.pagination.pages) break;
    page++;
  }
  if (seenResources.size !== expectedTotal) throw new Error("DiscussionBridge publication feed did not produce its complete unique census.");
  return summary;
}

function nativePublication(record, siteOrigin, config) {
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
  if (source?.status === "withdrawn") return { resourceId: id, slug: match[1], topicId: record.topic_id, edition: sourceEdition(source.edition), withdrawn: true };
  if (source?.status !== undefined && source.status !== "active") throw new Error("Hugo publication source status is invalid.");
  const base = serviceBase(config.serverUrl);
  if (!source || typeof source !== "object" || source.platform !== "discourse" || source.origin !== base.origin || source.topic_id !== record.topic_id || source.post_number !== 1 || !Number.isSafeInteger(source.post_id) || source.post_id < 1 || !Number.isSafeInteger(source.post_version) || source.post_version < 1 || source.revision !== `post:${source.post_id}:version:${source.post_version}`) throw new Error("Hugo publication source is invalid.");
  const identity = presentationIdentity(record, config.serverUrl, "Hugo publication");
  const updatedAt = sourceTime(source.updated_at, "update");
  const authorName = bounded(source.author?.name, 200, "Hugo publication author");
  const profile = new URL(bounded(source.author?.profile_url, 2048, "Hugo publication author URL"));
  if (profile.origin !== base.origin || profile.search || profile.hash) throw new Error("Hugo publication author URL is invalid.");
  const createdAt = source.created_at === undefined || source.created_at === null ? undefined : sourceTime(source.created_at, "creation");
  const edition = source.edition === undefined || source.edition === null ? undefined : sourceEdition(source.edition);
  const forumName = source.forum_name === undefined || source.forum_name === null ? (config.forumName === undefined ? base.origin : bounded(config.forumName, 200, "Hugo configured forum name")) : bounded(source.forum_name, 200, "Hugo publication forum name");
  const presentationMode = bindings[0].presentation_mode;
  if (presentationMode !== undefined && presentationMode !== null && !["simple", "full", "interactive"].includes(presentationMode)) throw new Error("Hugo publication presentation mode is invalid.");
  return { resourceId: id, slug: match[1], title: bounded(record.title, 1024, "Hugo publication title"), revision: source.revision, edition, createdAt, updatedAt, forumName, presentationMode, authorName, topicId: record.topic_id, topicUrl: identity.topic_url };
}

function sourceTime(value, label) { const time = bounded(value, 64, `Hugo publication ${label} time`); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(time) || !Number.isFinite(Date.parse(time))) throw new Error(`Hugo publication ${label} time is invalid.`); return time; }
function sourceEdition(value) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("Hugo publication source edition is invalid."); return value; }

export async function prepare({ manifestPath, outputPath, statePath = path.join(path.dirname(outputPath), ".discussionbridge-hugo-publication-state.json"), config, fetchImpl = fetch, dependencies = {} }) {
  return withOperationalStateLock(
    statePath,
    () => prepareUnlocked({ manifestPath, outputPath, statePath, config, fetchImpl, dependencies }),
    dependencies.lockOptions,
  );
}

async function prepareUnlocked({ manifestPath, outputPath, statePath, config, fetchImpl, dependencies }) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const pages = preflight(manifest, config);
  const operationalState = await readOperationalState(statePath);
  let priorOutput = {};
  try { priorOutput = JSON.parse(await readFile(outputPath, "utf8")); } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  resolveManifestIdentities(pages, operationalState, priorOutput);
  const output = {};
  const stagedAttempts = [];
  let withdrawalStateChanged = false;
  for (const page of pages) {
    if (page.mode === "simple" && page.topic_id) output[page.key] = await retrieveSimple(page, config, fetchImpl);
    if (page.mode === "to_discourse") {
      const operation = beginAttempt(operationalState, { externalId: page.external_id, canonicalUrl: page.canonical_url, pageKey: page.key });
      if (page.source_publication) {
        const revision = page.source_publication.revision;
        page.source_publication.previous_revision = operation.requestedSourceRevision === revision ? operation.requestedPreviousRevision ?? null : operation.acceptedSourceRevision ?? null;
        operation.requestedSourceRevision = revision; operation.requestedPreviousRevision = page.source_publication.previous_revision;
      }
      await writeOperationalState(statePath, operationalState);
      try {
        output[page.key] = await resolvePage(page, config, fetchImpl, operation.correlationId);
        if ((operation.resourceId && operation.resourceId !== output[page.key].resource_id) || (operation.topicId && operation.topicId !== output[page.key].topic_id)) throw new Error(`Hugo page ${page.key} returned a different native resource/topic identity; reconciliation is required.`);
      } catch (error) {
        failAttempt(operation, error, classifyFailure(error));
        await writeOperationalState(statePath, operationalState);
        throw error;
      }
      stageAttemptResult(operation, output[page.key]);
      await writeOperationalState(statePath, operationalState);
      stagedAttempts.push({ operation, result: output[page.key] });
      await dependencies.afterResultStaged?.(page.key);
    }
    if (page.mode === "from_discourse") {
      output[page.key] = await retrieveRecord(page, config, fetchImpl, priorOutput?.[page.key]);
      if (output[page.key].source_status === "withdrawn") {
        const prior = priorOutput?.[page.key];
        if (prior?.resource_id === page.resource_id && prior.forum_origin === output[page.key].forum_origin && Number.isSafeInteger(prior.topic_id)) {
          operationalState.withdrawalRecovery ??= {};
          operationalState.withdrawalRecovery[page.resource_id] = { resourceId: page.resource_id, canonicalUrl: page.canonical_url, topicId: prior.topic_id, forumOrigin: prior.forum_origin, priorSourceEdition: prior.source_edition, presentationMode: prior.presentation_mode, withdrawalEdition: output[page.key].source_edition, publicWithdrawalVerified: false };
          withdrawalStateChanged = true;
        }
      }
    }
  }
  try {
    if (withdrawalStateChanged) await writeOperationalState(statePath, operationalState);
    await (dependencies.atomicWrite ?? atomicWrite)(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    for (const { operation } of stagedAttempts) failAttempt(operation, error, { retryable: true, reconciliationRequired: true });
    await writeOperationalState(statePath, operationalState);
    throw error;
  }
  for (const { operation, result } of stagedAttempts) completeAttempt(operation, result);
  if (stagedAttempts.length > 0) await writeOperationalState(statePath, operationalState);
  return { pages: pages.length, records: Object.keys(output).length };
}

function resolveManifestIdentities(pages, state, priorOutput) {
  const byPage = new Map(); const byResource = new Map(); const byTopic = new Map();
  const add = (index, key, operation) => {
    if (key === undefined) return;
    const values = index.get(key) ?? []; values.push(operation); index.set(key, values);
  };
  for (const operation of Object.values(state.operations)) {
    add(byPage, operation.pageKey, operation);
    add(byResource, operation.resourceId, operation);
    add(byTopic, operation.topicId, operation);
  }
  const externalIds = new Set(); const resources = new Set(); const topics = new Set();
  for (const page of pages) {
    if (page.mode !== "to_discourse") continue;
    const priorResource = priorOutput?.[page.key]?.resource_id;
    const existing = new Set([...(byPage.get(page.key) ?? []), ...(priorResource ? byResource.get(priorResource) ?? [] : [])]);
    const operation = existing.values().next().value;
    if (existing.size > 1 || (operation && page.explicit_external_id && operation.externalId !== page.external_id)) throw new Error(`Hugo page ${page.key} has an ambiguous immutable identity.`);
    page.external_id = operation?.externalId ?? page.external_id;
    const bound = state.operations[page.external_id];
    if (bound && bound.canonicalUrl !== page.canonical_url) throw new Error("Hugo operational state contains a canonical identity collision.");
    if (externalIds.has(page.external_id)) throw new Error(`Hugo page ${page.key} has a duplicate external identity.`);
    externalIds.add(page.external_id);
    for (const [value, index, selected] of [[bound?.resourceId, byResource, resources], [bound?.topicId, byTopic, topics]]) {
      if (value === undefined) continue;
      if ((index.get(value)?.length ?? 0) > 1 || selected.has(value)) throw new Error(`Hugo page ${page.key} has an ambiguous native resource/topic identity.`);
      selected.add(value);
    }
  }
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
  const keys = new Set(); const urls = new Set(); const externalIds = new Set();
  const pages = manifest.pages.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Page ${index + 1} is invalid.`);
    const key = bounded(raw.key, 100, "page key");
    if (!KEY.test(key) || keys.has(key)) throw new Error(`Duplicate or invalid page key: ${key}.`);
    keys.add(key);
    const mode = raw.mode;
    if (!MODES.has(mode)) throw new Error(`Page ${key} has an unsupported mode.`);
    const canonical = new URL(bounded(raw.canonical_url, 2048, `${key} canonical URL`));
    if (canonical.protocol !== "https:" || canonical.origin !== origin.origin || canonical.username || canonical.password || canonical.search || canonical.hash) {
      throw new Error(`Page ${key} canonical URL is outside the Hugo site origin.`);
    }
    if (urls.has(canonical.href)) throw new Error(`Duplicate canonical URL: ${canonical.href}.`);
    urls.add(canonical.href);
    const title = bounded(raw.title, 1024, `${key} title`);
    const page = { key, mode, canonical_url: canonical.href, title };
    if (mode === "simple" && raw.topic_id !== undefined) {
      if (!Number.isSafeInteger(raw.topic_id) || raw.topic_id <= 0) throw new Error(`Page ${key} has an invalid topic ID.`);
      page.topic_id = raw.topic_id;
    }
    if (mode === "to_discourse") {
      if (raw.published !== undefined && raw.published !== true) throw new Error(`Hugo page ${key} is not eligible for publication.`);
      if (raw.native_publication === true) throw new Error(`Hugo page ${key} is a source-owned From publication, not an original To source.`);
      page.full_content_html = cleanSourceHtml(boundedText(raw.content_html, Number.MAX_SAFE_INTEGER, `${key} content HTML`));
      page.content_html = outboundBody(page.full_content_html, canonical.href);
      page.explicit_external_id = raw.external_id !== undefined;
      page.external_id = page.explicit_external_id ? bounded(raw.external_id, 255, `${key} external identity`) : `hugo-page:${createHash("sha256").update(canonical.href).digest("hex")}`;
      if (page.explicit_external_id) {
        if (externalIds.has(page.external_id)) throw new Error(`Hugo page ${key} has a duplicate external identity.`);
        externalIds.add(page.external_id);
      }
      page.source_authors = validateAuthors(raw.source_authors, origin.origin);
      page.primary_source_author_id = raw.primary_source_author_id;
      if (page.primary_source_author_id !== undefined && !page.source_authors.some((author) => author.id === page.primary_source_author_id)) throw new Error(`Hugo page ${key} has an unmapped primary source author.`);
      page.source_publication = sourcePublication(page, raw.source_created_at, raw.source_updated_at);
      if (Buffer.byteLength(page.full_content_html) > 49152 && !page.source_publication) throw new Error(`Hugo page ${key} needs source dates before a full-content excerpt can be delivered.`);
      // Check the complete envelope before any page is sent. Reserve the longest
      // possible CAS operand; actual source bytes/digest remain unchanged.
      const validationPage = { ...page, ...(page.source_publication ? { source_publication: { ...page.source_publication, previous_revision: "a".repeat(64) } } : {}) };
      publicationRequest(validationPage, config, "11111111-1111-4111-8111-111111111111");
      page.content_html = validationPage.content_html;
      if (page.source_publication) page.source_publication.excerpted = validationPage.source_publication.excerpted;
    }
    if (mode === "from_discourse") {
      page.resource_id = resourceId(raw.resource_id);
      if (raw.source_edition !== undefined && raw.source_edition !== null) page.source_edition = sourceEdition(raw.source_edition);
      if (raw.topic_id !== undefined) { if (!Number.isSafeInteger(raw.topic_id) || raw.topic_id < 1) throw new Error(`Page ${key} has an invalid native topic identity.`); page.topic_id = raw.topic_id; }
      if (raw.presentation_mode !== undefined && raw.presentation_mode !== null) {
        if (!["simple", "full", "interactive"].includes(raw.presentation_mode)) throw new Error(`Page ${key} has an invalid presentation mode.`);
        page.presentation_mode = raw.presentation_mode;
      }
    }
    return page;
  });
  return pages.sort((a, b) => a.key.localeCompare(b.key, "en"));
}

async function retrieveSimple(page, config, fetchImpl) {
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

function simpleMarkup(replies, topicUrl, truncated, poweredBy, wordmark) {
  const initial = replies.slice(0, 5).join(""); const rest = replies.slice(5);
  const more = rest.length ? `<details class="discussionbridge-simple__more"><summary><span class="discussionbridge-simple__more-closed">Show ${rest.length} more ${rest.length === 1 ? "comment" : "comments"}</span><span class="discussionbridge-simple__more-open">Show fewer comments</span></summary>${rest.join("")}</details>` : "";
  const limit = truncated ? `<p class="discussionbridge-simple__limit">Showing the first 50 comments. <a href="${escapeHtml(topicUrl)}" rel="nofollow noopener noreferrer">View the complete source discussion</a>.</p>` : "";
  const attribution = `<div data-discussionbridge-attributions><a class="discussionbridge-powered-by" data-discussionbridge-powered-by href="https://www.discourse.org/powered-by" aria-label="Powered by Discourse" rel="nofollow noopener noreferrer"${poweredBy ? "" : " hidden"}><span>Powered by</span><span class="discussionbridge-powered-by__wordmark">${wordmark}</span></a></div>`;
  const styles = '<style>.discussionbridge-powered-by{display:flex;align-items:center;justify-content:center;gap:.45rem;margin:.8rem auto 0;color:inherit;font-size:.8rem;text-decoration:none;opacity:.72}.discussionbridge-powered-by[hidden]{display:none}.discussionbridge-powered-by__wordmark{display:inline-flex;width:6.4rem;padding:.12rem .28rem;border-radius:.2rem;background:#fff}.discussionbridge-powered-by__wordmark svg{display:block;width:100%;height:auto}</style>';
  return `<div class="discussionbridge-simple__header"><h2>Comments</h2><a href="${escapeHtml(topicUrl)}" rel="nofollow noopener noreferrer">Open discussion</a></div>${replies.length ? initial + more : '<p class="discussionbridge-simple__empty">No comments yet.</p>'}${limit}${attribution}${styles}`;
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }

async function resolvePage(page, config, fetchImpl, correlationId = randomUUID()) {
  const body = publicationRequest(page, config, correlationId);
  const response = await request(config, "/discussion-bridge/v1/bridge-records/resolve.json", { method: "POST", body: JSON.stringify(body) }, fetchImpl);
  const payload = await boundedJson(response, config.maxResponseBytes);
  if (response.status === 409 || payload.outcome === "reconciliation_required") throw new Error(`Hugo page ${page.key} requires reconciliation (${response.status}).`);
  if (!response.ok || !["created", "resolved"].includes(payload.outcome) || payload.core_fallback !== false || payload.direction !== "to_discourse") {
    throw new Error(`Hugo page ${page.key} was rejected (${response.status}).`);
  }
  if (page.source_publication && (payload.source_revision !== page.source_publication.revision || !["created", "adopted", "updated", "unchanged"].includes(payload.source_publication_outcome))) throw new Error(`Hugo page ${page.key} returned an invalid source publication receipt.`);
  return { outcome: payload.outcome, ...presentationIdentity(payload, config.serverUrl, page.key), ...(payload.source_revision ? { source_revision: payload.source_revision } : {}) };
}

function publicationRequest(page, config, correlationId) {
  const body = { bridge_record: {
    direction: "to_discourse", external_id: page.external_id, canonical_url: page.canonical_url,
    title: page.title, content_html: page.content_html, published: true,
    adapter_id: "hugo-discussion-bridge", adapter_version: PRODUCT_VERSION,
    correlation_id: correlationId, ...(config.lane ? { lane: config.lane } : {}),
    ...(page.source_publication ? { source_publication: page.source_publication } : {}),
    ...(page.source_authors?.length ? { source_authors: page.source_authors, primary_source_author_id: page.primary_source_author_id } : {})
  }};
  let budget = 49152;
  while (Buffer.byteLength(JSON.stringify(body)) > 65536) {
    if (!page.source_publication) throw new Error(`Hugo page ${page.key} needs source dates before an envelope-sized excerpt can be delivered.`);
    budget = Math.floor(budget * 0.85);
    const excerpt = outboundBody(page.full_content_html, page.canonical_url, budget, true);
    page.content_html = body.bridge_record.content_html = excerpt;
    page.source_publication.excerpted = body.bridge_record.source_publication.excerpted = true;
  }
  return body;
}

function classifyFailure(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const reconciliationRequired = message.includes("reconciliation") || message.includes("identity collision");
  const explicitlyRejected = message.includes("was rejected") && !/\((408|429|5\d\d)\)/u.test(message);
  return { retryable: !explicitlyRejected && !reconciliationRequired, reconciliationRequired };
}

async function retrieveRecord(page, config, fetchImpl, cached, restart = 0) {
  const response = await request(config, `/discussion-bridge/v1/bridge-records/${encodeURIComponent(page.resource_id)}.json?publication_contract=${PUBLICATION_CONTRACT}`, { method: "GET" }, fetchImpl);
  const payload = await boundedJson(response, 2 * 1024 * 1024);
  const record = payload.bridge_record;
  if (response.ok && record?.source?.status === "withdrawn" && resourceId(record.resource_id) === page.resource_id && record.direction === "from_discourse") {
    if (!Number.isSafeInteger(record.topic_id) || record.topic_id < 1 || (page.topic_id && page.topic_id !== record.topic_id) || (cached?.topic_id && cached.topic_id !== record.topic_id)) throw new Error("Hugo withdrawn source native topic identity is inconsistent.");
    return { resource_id: page.resource_id, topic_id: record.topic_id, source_edition: sourceEdition(record.source.edition), source_status: "withdrawn", title: "Source publication withdrawn", content_html: "", forum_origin: serviceBase(config.serverUrl).origin };
  }
  if (!response.ok || !record || record.direction !== "from_discourse" || record.state !== "healthy" || resourceId(record.resource_id) !== page.resource_id) {
    throw new Error(`Hugo From Discourse record ${page.key} is unavailable.`);
  }
  const identity = presentationIdentity(record, config.serverUrl, page.key);
  if ((page.topic_id && page.topic_id !== identity.topic_id) || (cached?.resource_id === record.resource_id && cached.topic_id && cached.topic_id !== identity.topic_id)) throw new Error("Hugo source resource returned a different native topic identity.");
  if (record.source?.edition !== undefined && record.source.edition !== null) sourceEdition(record.source.edition);
  if (page.source_edition && record.source?.edition !== page.source_edition) throw new Error(`Hugo From Discourse record ${page.key} changed edition; synchronize and rebuild its manifest.`);
  let hydrated;
  try {
    hydrated = await hydratePublication(record, async (pathname) => {
      const chunk = await request(config, pathname, { method: "GET" }, fetchImpl);
      return { ok: chunk.ok, status: chunk.status, payload: chunk.status === 409 ? null : await boundedJson(chunk, 65_536) };
    }, cached?.resource_id === record.resource_id && cached.forum_origin === identity.forum_origin ? cached : undefined);
  } catch (error) {
    if (error instanceof SourceChanged && restart < 2) return retrieveRecord(page, config, fetchImpl, cached, restart + 1);
    throw error;
  }
  const sourceHtml = record.source?.content ? hydrated : boundedText(hydrated, 65_536, `${page.key} record HTML`);
  const content = sanitizeHtml(sourceHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
    allowedAttributes: { a: ["href", "title", "rel"], img: ["src", "alt", "title", "width", "height"], code: ["class"], pre: ["class"], span: ["class"], div: ["class"] },
    allowedClasses: { span: ["math"], div: ["math"] },
    allowedSchemes: ["https"], allowProtocolRelative: false
  });
  if (!content.trim()) throw new Error(`Hugo From Discourse record ${page.key} sanitized to empty content.`);
  const presentationMode = page.presentation_mode ?? "interactive";
  const simple = presentationMode === "simple" ? await retrieveSimple({ key: page.key, topic_id: identity.topic_id }, config, fetchImpl) : undefined;
  const forumName = record.source?.forum_name === undefined || record.source?.forum_name === null ? (config.forumName ?? identity.forum_origin) : bounded(record.source.forum_name, 200, "Hugo publication forum name");
  return { ...identity, title: bounded(record.title, 1024, `${page.key} record title`), content_html: content, source_edition: record.source?.edition, content_sha256: record.source?.content?.sha256, sanitized_content_sha256: createHash("sha256").update(content).digest("hex"), forum_name: forumName, presentation_mode: presentationMode, ...(simple ? { simple_html: simple.simple_html } : {}) };
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
  if (topic.origin !== base.origin || topic.username || topic.password || topic.search || topic.hash || !new RegExp(`^/t/(?:[^/]+/)?${topicId}/?$`).test(topic.pathname)) throw new Error(`${key} returned an inconsistent topic URL.`);
  return { resource_id: id, topic_id: topicId, topic_url: topic.href, forum_origin: base.origin };
}

function validateConfig(config) {
  serviceBase(config.serverUrl);
  if (config.nativeShortcode !== undefined && (typeof config.nativeShortcode !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(config.nativeShortcode))) throw new Error("Hugo native shortcode choice is invalid.");
  if (!CONNECTION.test(config.connectionId)) throw new Error("DiscussionBridge connection ID is invalid.");
  if (typeof config.connectionSecret !== "string" || enc.encode(config.connectionSecret).byteLength < 32 || enc.encode(config.connectionSecret).byteLength > 256 || /[\u0000-\u001f\u007f]/u.test(config.connectionSecret)) throw new Error("DiscussionBridge connection secret is invalid.");
  config.timeoutMs ??= 15_000; config.maxResponseBytes ??= 65_536;
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 600_000) throw new Error("DiscussionBridge timeout is invalid.");
  if (!Number.isSafeInteger(config.maxResponseBytes) || config.maxResponseBytes < 1 || config.maxResponseBytes > 1_048_576) throw new Error("DiscussionBridge response bound is invalid.");
  if (config.lane !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(config.lane)) throw new Error("DiscussionBridge lane is invalid.");
}

function serviceBase(value) { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("DiscussionBridge server URL must be HTTPS."); url.pathname = "/"; return url; }
function resourceId(value) { if (typeof value !== "string" || !UUID.test(value)) throw new Error("DiscussionBridge resource ID is invalid."); return value.toLowerCase(); }
function bounded(value, max, label) { if (typeof value !== "string" || !value.trim() || enc.encode(value).byteLength > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} is invalid.`); return value.trim(); }
function boundedText(value, max, label) { if (typeof value !== "string" || !value.trim() || enc.encode(value).byteLength > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error(`${label} is invalid.`); return value.trim(); }
function validateAuthors(value, origin) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error("Hugo source authors are invalid.");
  const authors = value.map((author) => {
    const result = { id: bounded(author?.id, 255, "author ID"), name: bounded(author?.name, 200, "author name") };
    if (author?.profile_url !== undefined && author.profile_url !== null) { const url = new URL(bounded(author.profile_url, 2048, "author profile URL")); if (url.origin !== origin || url.username || url.password || url.search || url.hash) throw new Error("Hugo author profile URL is outside the native site."); result.profile_url = url.href; }
    return result;
  });
  if (new Set(authors.map(({ id }) => id)).size !== authors.length) throw new Error("Hugo source authors contain a duplicate identity.");
  return authors;
}
function cleanSourceHtml(value) { const withoutPresentation = value.replace(/<section[^>]+class="discussionbridge-presentation"[\s\S]*?<\/section>/giu, ""); const clean = sanitizeHtml(withoutPresentation, { allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2"]), allowedAttributes: { a: ["href", "title"], img: ["src", "alt", "title", "width", "height"], code: ["class"], pre: ["class"], span: ["class"], div: ["class"] }, allowedClasses: { span: ["math"], div: ["math"] }, allowedSchemes: ["https"], allowProtocolRelative: false }); if (!clean.trim()) throw new Error("Hugo source content is empty after sanitization."); return clean; }
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
async function atomicWrite(file, contents) { const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`); let handle; try { handle = await open(temp, "wx"); await handle.writeFile(contents, "utf8"); await handle.sync(); await handle.close(); handle = undefined; await rename(temp, file); } catch (error) { await handle?.close().catch(() => {}); await rm(temp, { force: true }).catch(() => {}); throw error; } }
