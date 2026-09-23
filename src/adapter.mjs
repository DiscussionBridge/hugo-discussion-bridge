import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import sanitizeHtml from "sanitize-html";
import { PRODUCT_VERSION } from "./version.mjs";
import { beginAttempt, completeAttempt, failAttempt, readOperationalState, stageAttemptResult, withOperationalStateLock, writeOperationalState } from "./operational-state.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONNECTION = /^dbc_[a-f0-9]{24}$/;
const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODES = new Set(["simple", "full", "interactive", "to_discourse", "from_discourse"]);
const enc = new TextEncoder();
const BRANDING_CACHE_MS = 10 * 60 * 1000;
const brandingCache = new Map();
class PublicationMigrationRequired extends Error {}

export async function syncNativePublications({ contentDir, siteUrl, config, fetchImpl = fetch }) {
  validateConfig(config);
  const site = new URL(siteUrl);
  if (site.protocol !== "https:" || site.username || site.password || site.pathname !== "/" || site.search || site.hash) throw new Error("Hugo site URL must be an HTTPS origin.");
  let existingPublications;
  const summary = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  let page = 1;
  let snapshot; let expectedPages; let expectedTotal;
  const seenResources = new Set();
  for (;;) {
    const query = new URLSearchParams({ page: String(page) });
    if (snapshot) query.set("snapshot", snapshot);
    const response = await request(config, `/discussion-bridge/v1/bridge-records.json?${query}`, { method: "GET" }, fetchImpl);
    const payload = await boundedJson(response, Math.min(config.maxResponseBytes * 4, 262_144));
    if (!response.ok || !Array.isArray(payload.bridge_records) || !payload.pagination || typeof payload.pagination !== "object") throw new Error("DiscussionBridge publication feed is invalid.");
    if (payload.pagination.page !== page || !Number.isSafeInteger(payload.pagination.pages) || payload.pagination.pages < 1 || payload.pagination.pages > 10_000 || !Number.isSafeInteger(payload.pagination.total) || payload.pagination.total < 0 || typeof payload.pagination.snapshot !== "string" || !payload.pagination.snapshot || payload.pagination.snapshot.length > 8_192) throw new Error("DiscussionBridge publication pagination is invalid.");
    if (page === 1) {
      snapshot = payload.pagination.snapshot; expectedPages = payload.pagination.pages; expectedTotal = payload.pagination.total;
    } else if (payload.pagination.snapshot !== snapshot || payload.pagination.pages !== expectedPages || payload.pagination.total !== expectedTotal) {
      throw new Error("DiscussionBridge publication feed changed during synchronization.");
    }
    if (!existingPublications && payload.bridge_records.some((record) => Array.isArray(record?.bindings) && record.bindings.some((binding) => binding?.native_materialization === true))) {
      existingPublications = await indexNativePublications(contentDir);
    }
    for (const record of payload.bridge_records) {
      const feedResourceId = resourceId(record?.resource_id);
      if (seenResources.has(feedResourceId)) throw new Error("DiscussionBridge publication feed contains a duplicate resource identity.");
      seenResources.add(feedResourceId);
      try {
        const item = nativePublication(record, site.origin, config.serverUrl);
        if (!item) { summary.skipped++; continue; }
        existingPublications ??= await indexNativePublications(contentDir);
        const file = path.join(contentDir, `${item.route}.md`);
        const previousFile = existingPublications.get(item.resourceId);
        if (previousFile && previousFile !== path.resolve(file)) throw new PublicationMigrationRequired("Hugo publication URL change requires an explicit migration and redirect.");
        const publicationSummary = `Published with DiscussionBridge from the Repeal OBBBA Forum.`;
        const output = `+++\ntitle = ${JSON.stringify(item.title)}\ndescription = ${JSON.stringify(publicationSummary)}\nsummary = ${JSON.stringify(publicationSummary)}\ndate = ${JSON.stringify(item.updatedAt)}\ndiscussionbridge_mode = "from_discourse"\ndiscussionbridge_resource_id = "${item.resourceId}"\ndiscussionbridge_native_publication = true\ndiscussionbridge_source_author = ${JSON.stringify(item.authorName)}\ndiscussionbridge_source_revision = "${item.revision}"\ndiscussionbridge_adapter_version = "${PRODUCT_VERSION}"\ndiscussionbridge_topic_id = ${item.topicId}\n+++\n\n{{< discussionbridge mode="from_discourse" >}}\n`;
        let prior = null;
        try { prior = await readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (prior === output) { summary.unchanged++; continue; }
        if (prior && !prior.includes(`discussionbridge_resource_id = "${item.resourceId}"`)) throw new Error("Hugo publication identity collision.");
        await mkdir(path.dirname(file), { recursive: true });
        await atomicWrite(file, output);
        existingPublications.set(item.resourceId, path.resolve(file));
        summary[prior ? "updated" : "created"]++;
      } catch (error) {
        if (error instanceof PublicationMigrationRequired) throw error;
        summary.failed++;
      }
    }
    if (page >= payload.pagination.pages) break;
    page++;
  }
  if (seenResources.size !== expectedTotal) throw new Error("DiscussionBridge publication feed did not produce its complete unique census.");
  return summary;
}

async function indexNativePublications(contentDir) {
  const root = path.resolve(contentDir);
  const files = new Map();
  const pending = [root];
  let inspected = 0;
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT" && directory === root) return files; throw error; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Hugo publication content contains a symlink; identity cannot be checked safely.");
      if (entry.isDirectory()) { pending.push(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (++inspected > 100_000) throw new Error("Hugo publication content exceeds the bounded identity census.");
      const handle = await open(file, "r");
      const header = Buffer.alloc(2048);
      let bytesRead;
      try { ({ bytesRead } = await handle.read(header, 0, header.length, 0)); }
      finally { await handle.close(); }
      const text = header.toString("utf8", 0, bytesRead);
      const opening = text.match(/^\+\+\+\r?\n/u);
      if (!opening) continue;
      const remainder = text.slice(opening[0].length);
      const closing = remainder.search(/\r?\n\+\+\+\r?\n/u);
      if (closing < 0) continue;
      const frontmatter = remainder.slice(0, closing);
      if (!/^discussionbridge_native_publication = true\r?$/mu.test(frontmatter)) continue;
      const match = frontmatter.match(/^discussionbridge_resource_id = "([0-9a-f-]{36})"\r?$/imu);
      if (!match || !UUID.test(match[1])) throw new Error("Hugo native publication identity is missing or invalid.");
      const id = match[1].toLowerCase();
      if (files.has(id)) throw new Error("Hugo native publication resource identity is duplicated across files.");
      files.set(id, path.resolve(file));
    }
  }
  return files;
}

async function pathExists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

const MIGRATION_JOURNAL = ".discussionbridge-publication-url-migration.json";

async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function durableRename(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(source, destination);
  await syncDirectory(path.dirname(destination));
  if (path.dirname(source) !== path.dirname(destination)) await syncDirectory(path.dirname(source));
}

async function removeDurable(file) {
  await rm(file, { force: true });
  await syncDirectory(path.dirname(file));
}

async function readMigrationJournal(file) {
  try {
    const status = await lstat(file);
    if (!status.isFile() || status.isSymbolicLink() || status.size > 8_192) throw new Error("Hugo publication migration journal is invalid.");
    const journal = JSON.parse(await readFile(file, "utf8"));
    if (!journal || typeof journal !== "object" || Array.isArray(journal) || journal.version !== 1 ||
        !["prepared", "redirected", "moved"].includes(journal.phase) || !UUID.test(journal.resourceId) ||
        ["oldUrl", "newUrl", "sourceFile", "destinationFile", "redirectsFile", "redirectRule"].some((key) => typeof journal[key] !== "string")) {
      throw new Error("Hugo publication migration journal is invalid.");
    }
    return journal;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function migrationCheckpoint(phase, journalFile) {
  if (process.env.NODE_ENV !== "test" || process.env.DISCUSSIONBRIDGE_TEST_MIGRATION_PAUSE !== phase) return;
  process.stdout.write(`${JSON.stringify({ phase, journalFile })}\n`);
  await new Promise(() => {});
}

function redirectPlan(redirects, oldPath, newPath) {
  const lines = redirects.split(/\r?\n/u);
  const activeRules = lines.map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  const rule = `${oldPath} ${newPath} 301`;
  const oldRules = activeRules.filter((line) => line.split(/\s+/u)[0] === oldPath);
  const destinationRules = activeRules.filter((line) => line.split(/\s+/u)[0] === newPath);
  const exactRule = oldRules.length === 1 && oldRules[0] === rule;
  const inverseRule = destinationRules.length === 1 &&
    [`${newPath} ${oldPath} 301`, `${newPath} ${oldPath} 308`].includes(destinationRules[0])
    ? destinationRules[0] : null;
  if (oldRules.length && !exactRule) throw new Error("Hugo publication redirect source conflicts with an existing rule.");
  if (destinationRules.length && !inverseRule) throw new Error("Hugo publication destination has a conflicting redirect.");
  if (activeRules.length - (inverseRule ? 1 : 0) - (exactRule ? 1 : 0) >= 2_000) throw new Error("Hugo publication redirect manifest exceeds Cloudflare limits.");
  if (rule.length > 1_000) throw new Error("Hugo publication redirect exceeds Cloudflare limits.");
  const remaining = lines.filter((line) => line.trim() !== inverseRule && line.trim() !== (exactRule ? rule : "")).join("\n");
  const contents = `${remaining.trimEnd()}${remaining.trim() ? "\n" : ""}${rule}\n`;
  return { rule, contents, exactRule };
}

export async function migrateNativePublication({ contentDir, siteUrl, resourceId: id, oldUrl, newUrl, redirectsFile }) {
  const site = new URL(siteUrl);
  if (site.protocol !== "https:" || site.username || site.password || site.pathname !== "/" || site.search || site.hash) throw new Error("Hugo site URL must be an HTTPS origin.");
  const idValue = resourceId(id);
  if (path.basename(redirectsFile) !== "_redirects") throw new Error("Hugo migration requires a Cloudflare _redirects file.");
  const oldDestination = new URL(oldUrl);
  const newDestination = new URL(newUrl);
  const routePattern = /^\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*\/$/u;
  for (const url of [oldDestination, newDestination]) {
    if (url.origin !== site.origin || url.username || url.password || url.search || url.hash || !routePattern.test(url.pathname)) throw new Error("Invalid Hugo publication URL migration path.");
  }
  if (oldDestination.href === newDestination.href) throw new Error("Hugo publication URLs must differ.");
  const root = path.resolve(contentDir);
  await mkdir(root, { recursive: true });
  const testLock = process.env.NODE_ENV === "test";
  const release = await lock(root, { realpath: true, stale: testLock ? 2_000 : 30_000, update: testLock ? 1_000 : 10_000, retries: { retries: 20, factor: 1.2, minTimeout: 50, maxTimeout: 250 } });
  try {
  const destinationRoute = newDestination.pathname.slice(1, -1);
  const destinationFile = path.resolve(root, `${destinationRoute}.md`);
  const sourceRoute = oldDestination.pathname.slice(1, -1);
  const expectedSourceFile = path.resolve(root, `${sourceRoute}.md`);
  const alternates = [destinationFile, path.resolve(root, `${destinationRoute}.markdown`), path.resolve(root, `${destinationRoute}.html`), path.resolve(root, destinationRoute, "_index.md"), path.resolve(root, destinationRoute, "index.md")];
  const redirectPath = path.resolve(redirectsFile);
  const journalFile = path.join(root, MIGRATION_JOURNAL);
  const redirectRule = `${oldDestination.pathname} ${newDestination.pathname} 301`;
  const expectedJournal = { version: 1, resourceId: idValue, oldUrl: oldDestination.href, newUrl: newDestination.href, sourceFile: path.relative(root, expectedSourceFile), destinationFile: path.relative(root, destinationFile), redirectsFile: redirectPath, redirectRule };
  let journal = await readMigrationJournal(journalFile);
  if (journal && Object.entries(expectedJournal).some(([key, value]) => journal[key] !== value)) throw new Error("A different Hugo publication URL migration requires recovery first.");
  const files = await indexNativePublications(root);
  const currentFile = files.get(idValue);
  if (!currentFile) throw new Error("Hugo publication resource does not have exactly one native source file.");
  const currentRoute = path.relative(root, currentFile).split(path.sep).join("/").replace(/\.md$/u, "");
  const currentUrl = `${site.origin}/${currentRoute}/`;
  if (currentUrl !== oldDestination.href && currentFile !== destinationFile) throw new Error("Hugo publication old URL does not match its native source file.");
  if (currentFile === expectedSourceFile && (await Promise.all(alternates.map(pathExists))).some(Boolean)) throw new Error("Hugo publication destination already has content.");
  let redirects = "";
  try {
    const status = await lstat(redirectPath);
    if (!status.isFile() || status.isSymbolicLink() || status.size > 100_000) throw new Error("Hugo redirect manifest is not a bounded regular file.");
    redirects = await readFile(redirectPath, "utf8");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  let plan = redirectPlan(redirects, oldDestination.pathname, newDestination.pathname);
  if (currentFile === destinationFile && plan.exactRule && !journal) {
    return { resourceId: idValue, oldUrl: oldDestination.href, newUrl: newDestination.href, sourceFile: expectedSourceFile, destinationFile, redirectRule: plan.rule, outcome: "already_current" };
  }
  if (!journal) {
    journal = { ...expectedJournal, phase: "prepared" };
    await atomicWrite(journalFile, `${JSON.stringify(journal, null, 2)}\n`);
    await migrationCheckpoint("prepared", journalFile);
  }
  if (!plan.exactRule) {
    await atomicWrite(redirectPath, plan.contents);
    redirects = plan.contents;
    plan = redirectPlan(redirects, oldDestination.pathname, newDestination.pathname);
  }
  if (journal.phase === "prepared") {
    journal.phase = "redirected";
    await atomicWrite(journalFile, `${JSON.stringify(journal, null, 2)}\n`);
    await migrationCheckpoint("redirected", journalFile);
  }
  if (currentFile === expectedSourceFile) await durableRename(expectedSourceFile, destinationFile);
  else if (currentFile !== destinationFile) throw new Error("Hugo publication migration state is inconsistent.");
  if (journal.phase !== "moved") {
    journal.phase = "moved";
    await atomicWrite(journalFile, `${JSON.stringify(journal, null, 2)}\n`);
    await migrationCheckpoint("moved", journalFile);
  }
  const finalFiles = await indexNativePublications(root);
  if (finalFiles.get(idValue) !== destinationFile || !plan.exactRule) throw new Error("Hugo publication migration could not be verified.");
  await removeDurable(journalFile);
  return { resourceId: idValue, oldUrl: oldDestination.href, newUrl: newDestination.href, sourceFile: expectedSourceFile, destinationFile, redirectRule: plan.rule, outcome: "migrated" };
  } finally {
    await release();
  }
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
  const route = destination.pathname.endsWith("/") ? destination.pathname.slice(1, -1) : "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/u.test(route)) throw new Error("Hugo publication path is invalid.");
  const source = record.source;
  const base = serviceBase(serverUrl);
  if (!source || typeof source !== "object" || source.platform !== "discourse" || source.origin !== base.origin || source.topic_id !== record.topic_id || source.post_number !== 1 || !Number.isSafeInteger(source.post_id) || source.post_id < 1 || !Number.isSafeInteger(source.post_version) || source.post_version < 1 || source.revision !== `post:${source.post_id}:version:${source.post_version}`) throw new Error("Hugo publication source is invalid.");
  const identity = presentationIdentity(record, serverUrl, "Hugo publication");
  const updatedAt = bounded(source.updated_at, 64, "Hugo publication update time");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(updatedAt) || !Number.isFinite(Date.parse(updatedAt))) throw new Error("Hugo publication update time is invalid.");
  const authorName = bounded(source.author?.name, 200, "Hugo publication author");
  const profile = new URL(bounded(source.author?.profile_url, 2048, "Hugo publication author URL"));
  if (profile.origin !== base.origin || profile.search || profile.hash) throw new Error("Hugo publication author URL is invalid.");
  return { resourceId: id, route, title: bounded(record.title, 1024, "Hugo publication title"), revision: source.revision, updatedAt, authorName, topicId: record.topic_id, topicUrl: identity.topic_url };
}

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
  const output = {};
  const stagedAttempts = [];
  for (const page of pages) {
    if (page.mode === "simple" && page.topic_id) output[page.key] = await retrieveSimple(page, config, fetchImpl);
    if (page.mode === "to_discourse") {
      const prior = operationalState.operations[page.external_id];
      if (prior && prior.canonicalUrl !== page.canonical_url) {
        try {
          await attestSourceUrlMove(page, prior, config, fetchImpl);
        } catch (error) {
          const failed = beginAttempt(operationalState, { externalId: page.external_id, canonicalUrl: prior.canonicalUrl });
          failAttempt(failed, error, classifyFailure(error));
          await writeOperationalState(statePath, operationalState);
          throw error;
        }
        prior.canonicalUrl = page.canonical_url;
      }
      const operation = beginAttempt(operationalState, { externalId: page.external_id, canonicalUrl: page.canonical_url });
      await writeOperationalState(statePath, operationalState);
      try {
        output[page.key] = await resolvePage(page, config, fetchImpl, operation.correlationId);
        if ((prior?.resourceId && output[page.key].resource_id !== prior.resourceId) ||
            (prior?.topicId && output[page.key].topic_id !== prior.topicId)) {
          throw new Error("Hugo publication identity changed during an exact retry.");
        }
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
    if (page.mode === "from_discourse") output[page.key] = await retrieveRecord(page, config, fetchImpl);
  }
  try {
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

async function attestSourceUrlMove(page, prior, config, fetchImpl) {
  if (!prior.resourceId || !prior.topicId) {
    throw new Error("Hugo source URL changed without a recorded receiver identity; reconcile before building.");
  }
  const response = await request(config, `/discussion-bridge/v1/bridge-records/${encodeURIComponent(prior.resourceId)}.json`, { method: "GET" }, fetchImpl);
  const payload = await boundedJson(response, config.maxResponseBytes);
  const record = payload.bridge_record;
  if (!response.ok || !record || record.direction !== "to_discourse" || record.state !== "healthy" ||
      record.resource_id !== prior.resourceId || record.topic_id !== prior.topicId) {
    throw new Error("Hugo source URL move is not attested by the existing Bridge Record.");
  }
  presentationIdentity(record, config.serverUrl, page.key);
  const bindings = Array.isArray(record.bindings) ? record.bindings.filter((binding) =>
    binding && binding.role === "source" && binding.state === "active") : [];
  if (bindings.length !== 1 || bindings[0].external_id !== page.external_id ||
      bindings[0].canonical_url !== page.canonical_url) {
    throw new Error("Hugo source URL move lacks an exact verified receiver transition.");
  }
  const latest = bindings[0].url_migration;
  if (latest?.old_url === prior.canonicalUrl && latest?.new_url === page.canonical_url &&
      [301, 308].includes(latest?.redirect_status)) return;
  await attestSourceUrlChain(page, prior, config, fetchImpl);
}

async function attestSourceUrlChain(page, prior, config, fetchImpl) {
  const query = new URLSearchParams({ from_url: prior.canonicalUrl, to_url: page.canonical_url });
  const response = await request(config,
    `/discussion-bridge/v1/bridge-records/${encodeURIComponent(prior.resourceId)}/source-url-proof.json?${query}`,
    { method: "GET" }, fetchImpl);
  const payload = await boundedJson(response, config.maxResponseBytes);
  const proof = payload.source_url_proof;
  if (!response.ok || !proof || proof.resource_id !== prior.resourceId || proof.topic_id !== prior.topicId ||
      proof.external_id !== page.external_id || proof.from_url !== prior.canonicalUrl ||
      proof.to_url !== page.canonical_url || proof.verified !== true ||
      !Number.isSafeInteger(proof.transition_count) ||
      proof.transition_count < 2 || proof.transition_count > 20) {
    throw new Error("Hugo source URL move lacks a complete receiver history.");
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
    const mode = raw.mode === "fullInteractive" ? "interactive" : raw.mode;
    if (!MODES.has(mode)) throw new Error(`Page ${key} has an unsupported mode.`);
    const canonical = new URL(bounded(raw.canonical_url, 2048, `${key} canonical URL`));
    if (canonical.protocol !== "https:" || canonical.origin !== origin.origin || canonical.search || canonical.hash) {
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
      page.content_html = cleanSourceHtml(boundedText(raw.content_html, 49_152, `${key} content HTML`));
      if (typeof raw.external_id !== "string" || !/^hugo-page:[0-9a-f]{64}$/.test(raw.external_id)) {
        throw new Error(`Page ${key} requires a persisted Hugo external ID.`);
      }
      if (externalIds.has(raw.external_id)) throw new Error(`Duplicate Hugo external ID: ${raw.external_id}.`);
      externalIds.add(raw.external_id);
      page.external_id = raw.external_id;
      page.source_authors = validateAuthors(raw.source_authors);
      page.primary_source_author_id = raw.primary_source_author_id;
    }
    if (mode === "from_discourse") page.resource_id = resourceId(raw.resource_id);
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
  const limit = truncated ? `<p class="discussionbridge-simple__limit">Showing the first 50 comments. <a href="${escapeHtml(topicUrl)}" rel="nofollow noopener noreferrer">View the complete discussion on the forum</a>.</p>` : "";
  const attribution = `<div data-discussionbridge-attributions><a class="discussionbridge-powered-by" data-discussionbridge-powered-by href="https://www.discourse.org/powered-by" aria-label="Powered by Discourse" rel="nofollow noopener noreferrer"${poweredBy ? "" : " hidden"}><span>Powered by</span><span class="discussionbridge-powered-by__wordmark">${wordmark}</span></a></div>`;
  const styles = '<style>.discussionbridge-powered-by{display:flex;align-items:center;justify-content:center;gap:.45rem;margin:.8rem auto 0;color:inherit;font-size:.8rem;text-decoration:none;opacity:.72}.discussionbridge-powered-by[hidden]{display:none}.discussionbridge-powered-by__wordmark{display:inline-flex;width:6.4rem;padding:.12rem .28rem;border-radius:.2rem;background:#fff}.discussionbridge-powered-by__wordmark svg{display:block;width:100%;height:auto}</style>';
  return `<div class="discussionbridge-simple__header"><h2>Comments</h2><a href="${escapeHtml(topicUrl)}" rel="nofollow noopener noreferrer">Open discussion</a></div>${replies.length ? initial + more : '<p class="discussionbridge-simple__empty">No comments yet.</p>'}${limit}${attribution}${styles}`;
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }

async function resolvePage(page, config, fetchImpl, correlationId = randomUUID()) {
  const body = { bridge_record: {
    direction: "to_discourse", external_id: page.external_id, canonical_url: page.canonical_url,
    title: page.title, content_html: page.content_html, published: true,
    adapter_id: "hugo-discussion-bridge", adapter_version: PRODUCT_VERSION,
    correlation_id: correlationId, ...(config.lane ? { lane: config.lane } : {}),
    ...(page.source_authors?.length ? { source_authors: page.source_authors, primary_source_author_id: page.primary_source_author_id } : {})
  }};
  const response = await request(config, "/discussion-bridge/v1/bridge-records/resolve.json", { method: "POST", body: JSON.stringify(body) }, fetchImpl);
  const payload = await boundedJson(response, config.maxResponseBytes);
  if (!response.ok || !["created", "resolved"].includes(payload.outcome) || payload.core_fallback !== false || payload.direction !== "to_discourse") {
    throw new Error(`Hugo page ${page.key} was rejected (${response.status}).`);
  }
  return { outcome: payload.outcome, ...presentationIdentity(payload, config.serverUrl, page.key) };
}

function classifyFailure(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const reconciliationRequired = message.includes("reconciliation") || message.includes("identity collision") ||
    message.includes("identity changed") || message.includes("source url move lacks") ||
    message.includes("source url move is not attested") ||
    message.includes("source url changed without");
  const explicitlyRejected = message.includes("was rejected") && !/\((408|429|5\d\d)\)/u.test(message);
  return { retryable: !explicitlyRejected && !reconciliationRequired, reconciliationRequired };
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
function validateAuthors(value) { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 20) throw new Error("Hugo source authors are invalid."); return value.map((a) => ({ id: bounded(a?.id, 255, "author ID"), name: bounded(a?.name, 200, "author name") })); }
function cleanSourceHtml(value) { const withoutPresentation = value.replace(/<section[^>]+class="discussionbridge-presentation"[\s\S]*?<\/section>/giu, ""); const clean = sanitizeHtml(withoutPresentation, { allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2"]), allowedAttributes: { a: ["href", "title"], img: ["src", "alt", "title", "width", "height"], code: ["class"], pre: ["class"] }, allowedSchemes: ["https"], allowProtocolRelative: false }); if (!clean.trim()) throw new Error("Hugo source content is empty after sanitization."); return clean; }
async function boundedJson(response, maximum) { const declared = Number(response.headers.get("content-length")); if (Number.isFinite(declared) && declared > maximum) throw new Error("DiscussionBridge response is too large."); const type = response.headers.get("content-type") ?? ""; if (!/^application\/json\b/i.test(type)) throw new Error("DiscussionBridge response is not JSON."); const text = await response.text(); if (enc.encode(text).byteLength > maximum) throw new Error("DiscussionBridge response is too large."); const value = JSON.parse(text); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DiscussionBridge response JSON is invalid."); return value; }
async function atomicWrite(file, contents) { const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`); let handle; try { await mkdir(path.dirname(file), { recursive: true }); handle = await open(temp, "wx"); await handle.writeFile(contents, "utf8"); await handle.sync(); await handle.close(); handle = undefined; await rename(temp, file); await syncDirectory(path.dirname(file)); } catch (error) { await handle?.close().catch(() => {}); await rm(temp, { force: true }).catch(() => {}); throw error; } }
