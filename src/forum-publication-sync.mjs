import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import sanitizeHtml from "sanitize-html";
import { PRODUCT_VERSION } from "./version.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REVISION = /^[a-f0-9]{64}$/u;
const LEASE = /^[a-f0-9]{64}$/u;

export function hugoPlatformCatalog(rawSections = []) {
  const sections = publicationSections(rawSections);
  return {
    schema_version: 1,
    platform: "hugo",
    containers: [{ id: "topics", label: "Topics", kind: "section", path: "/topics/", taxonomy_ids: sections.length ? ["section"] : [] }],
    taxonomies: sections.length ? [{
      id: "section", label: "Sections", kind: "taxonomy",
      terms: sections.map(({ id, label, path: sectionPath }) => ({ id, label, kind: "term", path: sectionPath })),
    }] : [],
    authors: [{ id: "hugo:service", label: "Hugo build service", kind: "author" }],
    service_author_id: "hugo:service",
    presentation_modes: ["simple", "full", "fullInteractive", "native"],
    capabilities: { updates: true, unpublish: true, drafts: true },
    limits: { content_bytes: 49_152, title_bytes: 255, slug_bytes: 191 },
    inventory: { authors_complete: true, terms_complete: true, authors_observed: 1, terms_observed: sections.length },
  };
}

function bounded(value, maximum, label) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`Invalid ${label}`);
  return value.trim();
}

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function sameSource(summary, detail) {
  return ["topic_id", "topic_url", "title", "source_revision", "content_bytes", "source_created_at", "source_updated_at", "category", "tags", "author", "publication", "publication_revision", "destination"]
    .every((key) => same(summary?.[key] ?? null, detail?.[key] ?? null));
}

function sourceHtml(value) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 49_152) throw new Error("Invalid source content");
  const clean = sanitizeHtml(value, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2"]),
    allowedAttributes: { a: ["href", "title", "rel"], img: ["src", "alt", "title", "width", "height"], code: ["class"], pre: ["class"], span: ["class"], div: ["class"] },
    allowedSchemes: ["https"], allowProtocolRelative: false,
  });
  if (!clean.trim()) throw new Error("Source content is empty after sanitization");
  return clean;
}

function slug(value, topicId) {
  const result = value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 160);
  return `${result || "forum-topic"}-${topicId}`;
}

function safeSite(value) {
  const site = new URL(value);
  if (site.protocol !== "https:" || site.username || site.password || site.pathname !== "/" || site.search || site.hash) throw new Error("Hugo site URL must be an HTTPS origin");
  return site;
}

function publicationPlan(item, detail, siteUrl, serverUrl, rawSections = []) {
  if (!item || !detail || !sameSource(item, detail)) throw new Error("Source topic changed during synchronization");
  const topicId = item.topic_id;
  if (!Number.isSafeInteger(topicId) || topicId <= 0) throw new Error("Invalid source topic identity");
  const sourceRevision = bounded(item.source_revision, 255, "source revision");
  const publicationRevision = bounded(item.publication_revision, 64, "publication revision");
  if (!REVISION.test(publicationRevision)) throw new Error("Invalid publication revision");
  const destination = item.destination;
  if (!destination || destination.state !== "ready" || !REVISION.test(destination.mapping_revision ?? "") || destination.destination_container_id !== "topics") {
    throw new Error("Hugo destination is not ready");
  }
  const terms = Array.isArray(destination.destination_terms) ? destination.destination_terms : [];
  if (terms.length > 1) throw new Error("Hugo destination has multiple native sections");
  const section = terms.length ? publicationSections(rawSections).find(({ id }) =>
    terms[0]?.destination_taxonomy_id === "section" && terms[0]?.destination_term_id === id
  ) : undefined;
  if (terms.length && !section) throw new Error("Hugo destination section is invalid");
  const site = safeSite(siteUrl);
  const forum = new URL(serverUrl);
  const topicUrl = new URL(bounded(item.topic_url, 2048, "source topic URL"));
  if (topicUrl.origin !== forum.origin || topicUrl.search || topicUrl.hash) throw new Error("Invalid source topic URL");
  const title = bounded(item.title, 255, "source title");
  const publication = item.publication && typeof item.publication === "object" ? item.publication : {};
  let canonicalUrl;
  if (publication.canonical_url) {
    canonicalUrl = new URL(publication.canonical_url);
    if (canonicalUrl.origin !== site.origin || canonicalUrl.search || canonicalUrl.hash || !/^\/topics\/[a-z0-9][a-z0-9/-]*\/$/u.test(canonicalUrl.pathname)) throw new Error("Hugo publication URL changed or is invalid");
  } else {
    const route = destination.slug_policy === "topic_id" ? `forum-topic-${topicId}` : slug(title, topicId);
    canonicalUrl = new URL(`topics/${route}/`, site);
  }
  const createdAt = bounded(item.source_created_at, 64, "source creation time");
  const updatedAt = bounded(item.source_updated_at, 64, "source update time");
  for (const [label, value] of [["creation", createdAt], ["update", updatedAt]]) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new Error(`Invalid source ${label} time`);
    }
  }
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error("Source update precedes creation");
  return {
    topicId, title, sourceRevision, publicationRevision, mappingRevision: destination.mapping_revision,
    destination, publication, topicUrl: topicUrl.href, canonicalUrl: canonicalUrl.href,
    route: canonicalUrl.pathname.slice(1, -1), externalId: `hugo:topic:${topicId}`,
    author: bounded(item.author?.name, 200, "source author"), html: sourceHtml(detail.content_html),
    createdAt, updatedAt, section,
  };
}

function content(plan, resourceId) {
  const section = plan.section ? `discussionbridge_section = ${JSON.stringify(plan.section.id)}\n` : "";
  return `+++\ntitle = ${JSON.stringify(plan.title)}\ndate = ${JSON.stringify(plan.createdAt)}\nlastmod = ${JSON.stringify(plan.updatedAt)}\nurl = ${JSON.stringify(new URL(plan.canonicalUrl).pathname)}\n${section}discussionbridge_native_publication = true\ndiscussionbridge_resource_id = ${JSON.stringify(resourceId)}\ndiscussionbridge_topic_id = ${plan.topicId}\ndiscussionbridge_publication_revision = ${JSON.stringify(plan.publicationRevision)}\ndiscussionbridge_source_revision = ${JSON.stringify(plan.sourceRevision)}\ndiscussionbridge_source_author = ${JSON.stringify(plan.author)}\ndiscussionbridge_adapter_version = ${JSON.stringify(PRODUCT_VERSION)}\n+++\n\n<div class="discussionbridge-native-publication">${plan.html}</div>\n\n<hr>\n\n**Published from [The Bridge](${plan.topicUrl}) by ${plan.author}.**\n`;
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(value, "utf8"); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, file);
  } catch (error) { await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); throw error; }
}

async function readState(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value?.schema_version !== 1 || !value.publications || typeof value.publications !== "object") throw new Error("Hugo forum-publication state is invalid");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { schema_version: 1, publications: {} };
    throw error;
  }
}

async function withState(file, action) {
  await mkdir(path.dirname(file), { recursive: true });
  try { await open(file, "wx").then((handle) => handle.close()); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const release = await lock(file, { realpath: false, retries: 0, stale: 15 * 60 * 1000, update: 5000 });
  try {
    let state;
    try { state = await readState(file); } catch (error) {
      if ((await readFile(file, "utf8")).trim() === "") state = { schema_version: 1, publications: {} }; else throw error;
    }
    const result = await action(state);
    await atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`);
    return result;
  } finally { await release(); }
}

function nextCursor(payload) {
  const pagination = payload?.pagination;
  if (!pagination || typeof pagination.complete !== "boolean") throw new Error("Invalid source pagination");
  if (pagination.complete) {
    if (pagination.next_cursor !== null && pagination.next_cursor !== undefined) throw new Error("Completed source feed returned a cursor");
    return null;
  }
  return bounded(pagination.next_cursor, 8192, "source cursor");
}

function validateResolve(response, plan) {
  if (!UUID.test(response?.resource_id ?? "") || !["created", "resolved"].includes(response?.outcome) || response.external_id !== plan.externalId || response.canonical_url !== plan.canonicalUrl || response.pending_publication_revision !== plan.publicationRevision || response.pending_mapping_revision !== plan.mappingRevision) throw new Error("Invalid Hugo resolve response");
  if (plan.publication.resource_id && plan.publication.resource_id !== response.resource_id) throw new Error("Hugo resource identity changed");
  return response.resource_id;
}

async function preparePublicationItem({ item, root, siteUrl, config, bridge, state, lease, sections }) {
  const detail = await bridge.sourceTopic(item.topic_id);
  if (detail?.eligible !== true || !detail.source_topic) throw new Error("Source topic is no longer eligible");
  const plan = publicationPlan(item, detail.source_topic, siteUrl, config.serverUrl, sections);
  const resolved = await bridge.resolveSourceTopic(plan.topicId, {
    source_revision: plan.sourceRevision, publication_revision: plan.publicationRevision,
    mapping_revision: plan.mappingRevision, destination: plan.destination,
    external_id: plan.externalId, canonical_url: plan.canonicalUrl,
    ...(config.lane ? { lane: config.lane } : {}), native_materialization: true,
  });
  const resourceId = validateResolve(resolved, plan);
  const file = path.resolve(root, `${plan.route}.md`);
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Hugo publication path escaped content root");
  const expected = content(plan, resourceId);
  let prior;
  try { prior = await readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const receiverCurrent = plan.publication.destination_state === "healthy" && plan.publication.acknowledged_publication_revision === plan.publicationRevision;
  const outcome = prior === undefined ? "created" : prior === expected && receiverCurrent ? "unchanged" : "updated";
  if (prior !== expected) await atomicWrite(file, expected);
  state.publications[String(plan.topicId)] = {
    topic_id: plan.topicId, resource_id: resourceId, external_id: plan.externalId,
    canonical_url: plan.canonicalUrl, file: path.relative(root, file), source_revision: plan.sourceRevision,
    publication_revision: plan.publicationRevision, mapping_revision: plan.mappingRevision,
    destination: plan.destination, outcome, state: outcome === "unchanged" ? "healthy" : "pending_publish",
    adapter_version: PRODUCT_VERSION,
    ...(lease ? { lease_token: lease.token, lease_expires_at: lease.expiresAt } : {}),
  };
  return { outcome, requiresBuild: prior !== expected };
}

function validateClaim(response) {
  const work = response?.publication_work;
  if (work === null) return null;
  if (!work || !Number.isSafeInteger(work.topic_id) || work.topic_id <= 0 ||
      !["publish", "unpublish"].includes(work.action) || !LEASE.test(work.lease_token ?? "") ||
      !REVISION.test(work.publication_revision ?? "") ||
      typeof work.lease_expires_at !== "string" || !Number.isFinite(Date.parse(work.lease_expires_at))) {
    throw new Error("Invalid publication work claim");
  }
  if (work.action === "unpublish" && !UUID.test(work.resource_id ?? "")) throw new Error("Invalid publication withdrawal claim");
  return work;
}

function failureCode(error) {
  const reason = typeof error?.reason === "string" ? error.reason : "hugo_prepare_failed";
  const code = reason.toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 64);
  return code || "hugo_prepare_failed";
}

function publicationSections(raw) {
  if (!Array.isArray(raw) || raw.length > 100) throw new Error("Invalid Hugo native section inventory");
  const sections = raw.map((item) => {
    const id = bounded(item?.id, 100, "section id");
    const label = bounded(item?.label, 255, "section label");
    const sectionPath = bounded(item?.path, 255, "section path");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) || sectionPath !== `/sections/${id}/`) throw new Error("Invalid Hugo native section");
    return { id, label, path: sectionPath };
  });
  if (new Set(sections.map(({ id }) => id)).size !== sections.length) throw new Error("Duplicate Hugo native section");
  return sections;
}

export async function prepareForumPublications({ contentDir, siteUrl, stateFile, config, bridge, sections = [] }) {
  const current = await bridge.platformCatalogStatus();
  const catalog = await bridge.updatePlatformCatalog(hugoPlatformCatalog(sections), current?.catalog_revision || undefined);
  if (catalog?.destination_mapping_state !== "current") throw new Error("Hugo destination mapping requires operator configuration");
  const root = path.resolve(contentDir);
  return withState(stateFile, async (state) => {
    const summary = { created: 0, updated: 0, unchanged: 0, held: 0, unpublished: 0, failed: 0, errors: [], requires_build: false };
    const seen = new Set();
    let cursor;
    do {
      const payload = await bridge.sourceTopics(cursor);
      if (!Array.isArray(payload?.source_topics)) throw new Error("Invalid source topic feed");
      for (const item of payload.source_topics) {
        if (!Number.isSafeInteger(item?.topic_id) || item.topic_id <= 0 || seen.has(item.topic_id)) throw new Error("Duplicate or invalid source topic identity");
        seen.add(item.topic_id);
        try {
          if (item.destination?.state !== "ready") {
            const local = state.publications[String(item.topic_id)];
            if (local?.resource_id && local.resource_id === item.publication?.resource_id && ["healthy", "pending_hold"].includes(local.state)) {
              await rm(path.resolve(root, local.file), { force: true });
              Object.assign(local, {
                publication_revision: bounded(item.publication_revision, 64, "publication revision"),
                mapping_revision: bounded(item.destination?.mapping_revision, 64, "mapping revision"),
                destination: item.destination, outcome: "held", state: "pending_hold",
              });
              summary.requires_build = true;
            }
            summary.held++;
            continue;
          }
          const { outcome, requiresBuild } = await preparePublicationItem({
            item, root, siteUrl, config, bridge, state, sections,
          });
          if (requiresBuild) summary.requires_build = true;
          summary[outcome]++;
        } catch (error) { summary.failed++; summary.errors.push({ topic_id: item.topic_id, reason: String(error?.message ?? error).slice(0, 240) }); }
      }
      cursor = nextCursor(payload);
    } while (cursor);

    const seenRevocations = new Set();
    cursor = undefined;
    do {
      const payload = await bridge.sourceRevocations(cursor);
      if (!Array.isArray(payload?.publication_revocations)) throw new Error("Invalid publication revocation feed");
      for (const item of payload.publication_revocations) {
        if (!UUID.test(item?.resource_id ?? "") || !Number.isSafeInteger(item?.topic_id) || item.topic_id <= 0 || !REVISION.test(item?.publication_revision ?? "") || seenRevocations.has(item.resource_id)) throw new Error("Duplicate or invalid publication revocation");
        seenRevocations.add(item.resource_id);
        try {
          const local = state.publications[String(item.topic_id)];
          if (!local || local.resource_id !== item.resource_id) throw new Error("Hugo publication for revocation is unavailable");
          await rm(path.resolve(root, local.file), { force: true });
          Object.assign(local, { publication_revision: item.publication_revision, outcome: "unpublished", state: "pending_unpublish" });
          summary.unpublished++; summary.requires_build = true;
        } catch (error) { summary.failed++; summary.errors.push({ resource_id: item.resource_id, reason: String(error?.message ?? error).slice(0, 240) }); }
      }
      cursor = nextCursor(payload);
    } while (cursor);
    return summary;
  });
}

export async function prepareQueuedForumPublications({ contentDir, siteUrl, stateFile, config, bridge, maximum = 20, sections = [] }) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 20) throw new Error("Invalid publication work limit");
  const catalog = await bridge.platformCatalogStatus();
  if (catalog?.destination_mapping_state !== "current") throw new Error("Hugo destination mapping requires operator configuration");
  const root = path.resolve(contentDir);
  return withState(stateFile, async (state) => {
    const summary = { claimed: 0, created: 0, updated: 0, held: 0, unpublished: 0, failed: 0, errors: [], requires_build: false, requires_finalize: false };
    const now = Date.now();
    for (const publication of Object.values(state.publications)) {
      if (!["pending_publish", "pending_hold", "pending_unpublish"].includes(publication.state) || !publication.lease_token) continue;
      if (Number.isFinite(Date.parse(publication.lease_expires_at)) && Date.parse(publication.lease_expires_at) > now) {
        summary.requires_finalize = true;
        return summary;
      }
      publication.state = "attention";
      delete publication.lease_token;
      delete publication.lease_expires_at;
    }

    for (let index = 0; index < maximum; index++) {
      const work = validateClaim(await bridge.claimPublicationWork(3600));
      if (work === null) break;
      summary.claimed++;
      try {
        if (work.action === "publish") {
          const detail = await bridge.sourceTopic(work.topic_id);
          const item = detail?.eligible === true && detail.source_topic ? detail.source_topic : null;
          if (!item || item.publication_revision !== work.publication_revision || item.source_revision !== work.source_revision) {
            throw new Error("Claimed source revision changed");
          }
          const { outcome, requiresBuild } = await preparePublicationItem({
            item, root, siteUrl, config, bridge, state, sections,
            lease: { token: work.lease_token, expiresAt: work.lease_expires_at },
          });
          summary[outcome]++;
          if (requiresBuild || outcome !== "unchanged") summary.requires_build = true;
        } else {
          const detail = await bridge.sourceRevocation(work.resource_id);
          const item = detail?.revoked === true ? detail.publication_revocation : null;
          if (!item || item.topic_id !== work.topic_id || item.publication_revision !== work.publication_revision) {
            throw new Error("Claimed publication withdrawal changed");
          }
          const local = state.publications[String(work.topic_id)];
          if (!local || local.resource_id !== work.resource_id) throw new Error("Hugo publication for withdrawal is unavailable");
          await rm(path.resolve(root, local.file), { force: true });
          Object.assign(local, {
            publication_revision: work.publication_revision,
            outcome: "unpublished",
            state: "pending_unpublish",
            lease_token: work.lease_token,
            lease_expires_at: work.lease_expires_at,
          });
          summary.unpublished++;
          summary.requires_build = true;
        }
        summary.requires_finalize = true;
        await atomicWrite(stateFile, `${JSON.stringify(state, null, 2)}\n`);
      } catch (error) {
        const detail = String(error?.message ?? error).replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 1000);
        try { await bridge.failPublicationWork(work.lease_token, failureCode(error), detail); }
        catch (reportError) { summary.errors.push({ topic_id: work.topic_id, reason: String(reportError?.message ?? reportError).slice(0, 240) }); }
        summary.failed++;
        summary.errors.push({ topic_id: work.topic_id, reason: detail.slice(0, 240) });
      }
    }
    return summary;
  });
}

async function publicHtml(url, fetchImplementation) {
  const response = await fetchImplementation(url, { redirect: "error", headers: { Accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
  if (response.url && response.url !== url) throw new Error("Hugo publication changed public URL");
  if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) throw new Error("Hugo publication is not publicly available");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 2 * 1024 * 1024) throw new Error("Hugo publication response is too large");
  const text = await response.text();
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("Hugo publication response is too large");
  return text;
}

function hasMeta(html, expectedName, expectedContent) {
  const tags = html.match(/<meta\b[^>]*>/giu) ?? [];
  return tags.some((tag) => {
    const attributes = {};
    const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
    for (const match of tag.matchAll(pattern)) {
      attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
    }
    return attributes.name === expectedName && attributes.content === expectedContent;
  });
}

export async function finalizeForumPublications({ stateFile, bridge, fetchImplementation = fetch }) {
  return withState(stateFile, async (state) => {
    const summary = { acknowledged: 0, unchanged: 0, failed: 0, errors: [] };
    for (const publication of Object.values(state.publications)) {
      if (publication.state === "healthy") { summary.unchanged++; continue; }
      if (!["pending_publish", "pending_hold", "pending_unpublish"].includes(publication.state)) continue;
      try {
        const removal = publication.state !== "pending_publish";
        if (removal) {
          const response = await fetchImplementation(publication.canonical_url, { redirect: "error", headers: { Accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
          if (response.status !== 404) throw new Error("Hugo publication remains publicly available after removal");
        } else {
          const html = await publicHtml(publication.canonical_url, fetchImplementation);
          if (!hasMeta(html, "discussionbridge-resource-id", publication.resource_id) ||
              !hasMeta(html, "discussionbridge-publication-revision", publication.publication_revision)) {
            throw new Error("Hugo public publication markers do not match pending identity");
          }
        }
        const acknowledgement = publication.state === "pending_unpublish"
          ? {
              publication_revision: publication.publication_revision,
              native_destination: { external_id: publication.external_id, canonical_url: publication.canonical_url },
              outcome: "unpublished",
              ...(publication.lease_token ? { lease_token: publication.lease_token } : {}),
            }
          : {
              source_revision: publication.source_revision,
              publication_revision: publication.publication_revision,
              mapping_revision: publication.mapping_revision,
              destination: publication.destination,
              native_destination: { external_id: publication.external_id, canonical_url: publication.canonical_url },
              outcome: publication.outcome,
              ...(publication.lease_token ? { lease_token: publication.lease_token } : {}),
            };
        const response = await bridge.acknowledgePublication(publication.resource_id, acknowledgement);
        const expectedState = removal ? "held" : "healthy";
        if (response?.resource_id !== publication.resource_id || response.destination_state !== expectedState || response.acknowledged_publication_revision !== publication.publication_revision) throw new Error("Invalid Hugo acknowledgement response");
        publication.state = removal ? "held" : "healthy";
        publication.acknowledged_at = new Date().toISOString();
        delete publication.lease_token;
        delete publication.lease_expires_at;
        summary.acknowledged++;
      } catch (error) { summary.failed++; summary.errors.push({ topic_id: publication.topic_id, reason: String(error?.message ?? error).slice(0, 240) }); }
    }
    return summary;
  });
}

export { publicationPlan };
