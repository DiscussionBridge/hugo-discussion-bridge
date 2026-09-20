import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { finalizeForumPublications, prepareForumPublications } from "../src/forum-publication-sync.mjs";

const resourceId = "11111111-1111-4111-8111-111111111111";
const publicationRevision = "a".repeat(64);
const mappingRevision = "b".repeat(64);

function sourceTopic() {
  return {
    topic_id: 53,
    topic_url: "https://bridge.example.com/t/forum-scale-publishing-canary/53",
    title: "Forum Scale Publishing Canary",
    source_revision: "post:99:version:2",
    content_bytes: 30,
    source_updated_at: "2026-09-20T17:00:00.000Z",
    category: { id: 6, name: "Forum Scale Canary" },
    tags: [],
    author: { id: 1, name: "Forum Author" },
    publication: {},
    publication_revision: publicationRevision,
    destination: {
      state: "ready", reasons: [], destination_container_id: "topics", destination_terms: [],
      destination_author_id: "hugo:service", authorship_policy: "service_author",
      presentation_mode: "native", slug_policy: "topic_id", mapping_revision: mappingRevision,
    },
  };
}

test("Hugo forum publication prepares, verifies live output, acknowledges, and retries unchanged", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-forum-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const item = sourceTopic();
  const detail = { ...item, content_html: "<h2>Forum source</h2><p>Published natively.</p>" };
  const acknowledgements = [];
  const bridge = {
    platformCatalogStatus: async () => ({ catalog_revision: null }),
    updatePlatformCatalog: async () => ({ destination_mapping_state: "current" }),
    sourceTopics: async () => ({ source_topics: [item], pagination: { complete: true, next_cursor: null } }),
    sourceRevocations: async () => ({ publication_revocations: [], pagination: { complete: true, next_cursor: null } }),
    sourceTopic: async () => ({ eligible: true, source_topic: detail }),
    resolveSourceTopic: async (_topicId, publication) => ({
      outcome: "created", resource_id: resourceId, external_id: publication.external_id,
      canonical_url: publication.canonical_url, pending_publication_revision: publicationRevision,
      pending_mapping_revision: mappingRevision,
    }),
    acknowledgePublication: async (id, acknowledgement) => {
      acknowledgements.push(acknowledgement);
      return { resource_id: id, destination_state: "healthy", acknowledged_publication_revision: publicationRevision };
    },
  };
  const options = {
    contentDir: path.join(root, "content"), siteUrl: "https://hugo.example.com/",
    stateFile: path.join(root, "state", "forum.json"),
    config: { serverUrl: "https://bridge.example.com", connectionId: "dbc_1234567890abcdef12345678", connectionSecret: "s".repeat(44), lane: "hugo-obbba" },
    bridge,
  };
  assert.deepEqual(await prepareForumPublications(options), {
    created: 1, updated: 0, unchanged: 0, held: 0, unpublished: 0, failed: 0, errors: [], requires_build: true,
  });
  const file = path.join(root, "content", "topics", "forum-topic-53.md");
  const generated = await readFile(file, "utf8");
  assert.match(generated, new RegExp(resourceId));
  assert.match(generated, new RegExp(publicationRevision));
  assert.doesNotMatch(generated, /dbc_123456|ssssssss/);

  const publicHtml = `<meta content="${resourceId}" name=discussionbridge-resource-id><meta name=discussionbridge-publication-revision content="${publicationRevision}">`;
  assert.deepEqual(await finalizeForumPublications({
    stateFile: options.stateFile, bridge,
    fetchImplementation: async (url) => new Response(publicHtml, { status: 200, headers: { "content-type": "text/html", "content-length": String(publicHtml.length) } }),
  }), { acknowledged: 1, unchanged: 0, failed: 0, errors: [] });
  assert.equal(acknowledgements.length, 1);
  assert.equal(acknowledgements[0].outcome, "created");

  item.publication = {
    resource_id: resourceId, destination_state: "healthy", acknowledged_publication_revision: publicationRevision,
    canonical_url: "https://hugo.example.com/topics/forum-topic-53/",
  };
  detail.publication = item.publication;
  assert.deepEqual(await prepareForumPublications(options), {
    created: 0, updated: 0, unchanged: 1, held: 0, unpublished: 0, failed: 0, errors: [], requires_build: false,
  });
});

test("Hugo forum publication removes a revoked page before sending a bounded acknowledgement", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-revoke-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const item = sourceTopic();
  const detail = { ...item, content_html: "<p>Published natively.</p>" };
  const acknowledgements = [];
  let revoked = false;
  const bridge = {
    platformCatalogStatus: async () => ({ catalog_revision: null }),
    updatePlatformCatalog: async () => ({ destination_mapping_state: "current" }),
    sourceTopics: async () => ({ source_topics: revoked ? [] : [item], pagination: { complete: true, next_cursor: null } }),
    sourceRevocations: async () => ({
      publication_revocations: revoked ? [{ resource_id: resourceId, topic_id: item.topic_id, publication_revision: "c".repeat(64) }] : [],
      pagination: { complete: true, next_cursor: null },
    }),
    sourceTopic: async () => ({ eligible: true, source_topic: detail }),
    resolveSourceTopic: async (_topicId, publication) => ({
      outcome: "created", resource_id: resourceId, external_id: publication.external_id,
      canonical_url: publication.canonical_url, pending_publication_revision: publicationRevision,
      pending_mapping_revision: mappingRevision,
    }),
    acknowledgePublication: async (id, acknowledgement) => {
      acknowledgements.push(acknowledgement);
      return { resource_id: id, destination_state: "held", acknowledged_publication_revision: acknowledgement.publication_revision };
    },
  };
  const options = {
    contentDir: path.join(root, "content"), siteUrl: "https://hugo.example.com/",
    stateFile: path.join(root, "state", "forum.json"),
    config: { serverUrl: "https://bridge.example.com", lane: "hugo-obbba" }, bridge,
  };
  await prepareForumPublications(options);
  revoked = true;
  const prepared = await prepareForumPublications(options);
  assert.equal(prepared.unpublished, 1);
  assert.equal(prepared.requires_build, true);
  await assert.rejects(readFile(path.join(root, "content", "topics", "forum-topic-53.md"), "utf8"), { code: "ENOENT" });

  const finalized = await finalizeForumPublications({
    stateFile: options.stateFile, bridge,
    fetchImplementation: async () => new Response("missing", { status: 404 }),
  });
  assert.deepEqual(finalized, { acknowledged: 1, unchanged: 0, failed: 0, errors: [] });
  assert.deepEqual(acknowledgements, [{
    publication_revision: "c".repeat(64),
    native_destination: { external_id: "hugo:topic:53", canonical_url: "https://hugo.example.com/topics/forum-topic-53/" },
    outcome: "unpublished",
  }]);
});
