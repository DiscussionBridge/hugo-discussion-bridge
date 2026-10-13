import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepare, preflight } from "../src/adapter.mjs";
import { readOperationalState } from "../src/operational-state.mjs";

const base = fileURLToPath(new URL("../.tmp/source-publication-tests/", import.meta.url));
const config = { serverUrl: "https://forum.example", connectionId: "dbc_0123456789abcdef01234567", connectionSecret: "s".repeat(48) };
const id = "11111111-1111-4111-8111-111111111111";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const page = () => ({ key: "native", mode: "to_discourse", canonical_url: "https://hugo.example/native/", title: "Native source", published: true, content_html: "<p>Original native body.</p>", source_created_at: "2026-01-01T00:00:00Z", source_updated_at: "2026-10-12T00:00:00Z" });
const manifest = (value) => ({ site_origin: "https://hugo.example", pages: [value] });
async function fixture(context, source = page()) {
  await mkdir(base, { recursive: true }); const dir = await mkdtemp(path.join(base, "publication-"));
  context.after(async () => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(base)); await rm(dir, { recursive: true, force: true }); });
  const manifestPath = path.join(dir, "manifest.json"), outputPath = path.join(dir, "records.json"), statePath = path.join(dir, "state.json");
  await writeFile(manifestPath, JSON.stringify(manifest(source)));
  return { dir, manifestPath, outputPath, statePath, config: { ...config } };
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function receipt(request, extra = {}) { return json({ outcome: "resolved", core_fallback: false, direction: "to_discourse", resource_id: id, topic_id: 53, topic_url: `${config.serverUrl}/t/native/53`, source_revision: request.source_publication.revision, source_publication_outcome: "updated", ...extra }); }

test("oversized To source retains full native HTML evidence and delivers a valid bounded excerpt", () => {
  const native = page(); native.content_html = `<h2>Title</h2><p>${"😀 &amp; useful source ".repeat(10000)}</p>`;
  const before = structuredClone(native);
  const [prepared] = preflight(manifest(native), { ...config });
  assert.deepEqual(native, before);
  assert.equal(prepared.full_content_html, native.content_html);
  assert.equal(prepared.source_publication.content_sha256, digest(native.content_html));
  assert.equal(prepared.source_publication.content_bytes, Buffer.byteLength(native.content_html));
  assert.equal(prepared.source_publication.excerpted, true);
  assert.ok(Buffer.byteLength(prepared.content_html) <= 49152);
  assert.match(prepared.content_html, /href="https:\/\/hugo.example\/native\/"/u);
  assert.match(prepared.content_html, /Read more at the source/u);
  assert.doesNotMatch(prepared.content_html, /\uFFFD/u);
  assert.match(prepared.content_html, /😀 &amp; useful source/u);
  assert.doesNotMatch(prepared.content_html, /&amp;amp;/u);
  for (const bad of [{ source_updated_at: "2020-01-01T00:00:00Z" }, { source_created_at: undefined }, { source_updated_at: "2026-10-12T00:00:00" }]) assert.throws(() => preflight(manifest({ ...page(), ...bad }), { ...config }), /authoritative source/u);
  assert.throws(() => preflight(manifest({ ...native, source_created_at: undefined, source_updated_at: undefined }), { ...config }), /needs source dates/u);
});

test("the actual serialized To request fits its envelope even when portable HTML contains many quotes", async (context) => {
  const source = page(); source.content_html = `<p>${'"\\'.repeat(23000)}</p>`;
  assert.ok(Buffer.byteLength(source.content_html) < 49152);
  const options = await fixture(context, source);
  await prepare({ ...options, fetchImpl: async (_address, init) => {
    assert.ok(Buffer.byteLength(init.body) <= 65536);
    const request = JSON.parse(init.body).bridge_record;
    assert.equal(request.source_publication.content_sha256, digest(source.content_html));
    assert.equal(request.source_publication.excerpted, true);
    assert.match(request.content_html, /Read more at the source/u);
    return receipt(request);
  } });
  assert.equal(JSON.parse(await readFile(options.manifestPath, "utf8")).pages[0].content_html, source.content_html);
});

test("configured native authorship remains explicit and profile URLs are validated before requests", () => {
  const native = { ...page(), source_authors: [{ id: "native-editor", name: "Native Editor", profile_url: "https://hugo.example/authors/editor/" }], primary_source_author_id: "native-editor" };
  const [prepared] = preflight(manifest(native), { ...config });
  assert.deepEqual(prepared.source_authors, native.source_authors); assert.equal(prepared.primary_source_author_id, "native-editor");
  assert.throws(() => preflight(manifest({ ...native, primary_source_author_id: "other" }), { ...config }), /primary source author/u);
  assert.throws(() => preflight(manifest({ ...native, source_authors: [native.source_authors[0], native.source_authors[0]] }), { ...config }), /duplicate identity/u);
  assert.throws(() => preflight(manifest({ ...native, source_authors: [{ ...native.source_authors[0], profile_url: "https://other.example/editor/" }] }), { ...config }), /outside the native site/u);
});

test("To update uses the last accepted source revision, preserves identity and accepts native slug changes", async (context) => {
  const source = page(), options = await fixture(context, source), requests = [];
  const fetchImpl = async (_address, init) => { const request = JSON.parse(init.body).bridge_record; requests.push(request); return receipt(request, { topic_url: `${config.serverUrl}/t/${requests.length === 1 ? "old" : "renamed"}/53` }); };
  await prepare({ ...options, fetchImpl });
  source.title = "Renamed native source"; source.content_html = "<p>Edited native body.</p>"; source.source_updated_at = "2026-10-12T01:00:00Z";
  await writeFile(options.manifestPath, JSON.stringify(manifest(source)));
  await prepare({ ...options, fetchImpl }); await prepare({ ...options, fetchImpl });
  assert.equal(requests[0].source_publication.previous_revision, null);
  assert.equal(requests[1].source_publication.previous_revision, requests[0].source_publication.revision);
  assert.equal(requests[2].source_publication.revision, requests[1].source_publication.revision);
  assert.equal(requests[2].source_publication.previous_revision, requests[1].source_publication.previous_revision);
  assert.equal(requests[1].external_id, requests[0].external_id);
  assert.equal(requests[2].correlation_id, requests[0].correlation_id);
  const output = JSON.parse(await readFile(options.outputPath, "utf8")); assert.equal(output.native.topic_url, `${config.serverUrl}/t/renamed/53`);
  const state = await readOperationalState(options.statePath); assert.equal(Object.values(state.operations)[0].acceptedSourceRevision, requests[1].source_publication.revision);
  source.canonical_url = "https://hugo.example/moved/"; await writeFile(options.manifestPath, JSON.stringify(manifest(source)));
  await assert.rejects(prepare({ ...options, fetchImpl }), /canonical identity collision/u); assert.equal(requests.length, 3);
});

test("accepted To publication followed by local output failure retries the exact original CAS operand", async (context) => {
  const options = await fixture(context), requests = [];
  const fetchImpl = async (_address, init) => { const request = JSON.parse(init.body).bridge_record; requests.push(request); return receipt(request); };
  await assert.rejects(prepare({ ...options, fetchImpl, dependencies: { atomicWrite: async () => { throw new Error("Owned output failure"); } } }), /Owned output failure/u);
  await prepare({ ...options, fetchImpl });
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(requests[1].source_publication.previous_revision, null);
  const state = await readOperationalState(options.statePath); assert.equal(Object.values(state.operations)[0].outcome, "resolved");
});

test("CAS conflict or changed receiver identity cannot overwrite last successful platform output", async (context) => {
  const options = await fixture(context);
  const accepted = async (_address, init) => receipt(JSON.parse(init.body).bridge_record);
  await prepare({ ...options, fetchImpl: accepted }); const previous = await readFile(options.outputPath, "utf8");
  for (const fetchImpl of [async () => json({ outcome: "reconciliation_required" }, 409), async (_url, init) => receipt(JSON.parse(init.body).bridge_record, { topic_id: 54, topic_url: `${config.serverUrl}/t/other/54` }), async (_url, init) => receipt(JSON.parse(init.body).bridge_record, { resource_id: "22222222-2222-4222-8222-222222222222" }), async (_url, init) => receipt(JSON.parse(init.body).bridge_record, { topic_url: `${config.serverUrl}/t/other/54` }), async (_url, init) => receipt(JSON.parse(init.body).bridge_record, { source_revision: "f".repeat(64) })]) {
    await assert.rejects(prepare({ ...options, fetchImpl }), /reconciliation|identity|source publication receipt|presentation|topic URL/u);
    assert.equal(await readFile(options.outputPath, "utf8"), previous);
  }
});
