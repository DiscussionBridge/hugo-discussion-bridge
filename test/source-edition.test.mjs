import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepare, preflight, syncNativePublications } from "../src/adapter.mjs";

const base = fileURLToPath(new URL("../.tmp/source-edition-tests/", import.meta.url));
const config = { serverUrl: "https://forum.example", connectionId: "dbc_0123456789abcdef01234567", connectionSecret: "s".repeat(48), nativeShortcode: "discussionbridge" };
const id = "11111111-1111-4111-8111-111111111111";
function record() { return { resource_id: id, direction: "from_discourse", state: "healthy", title: "Original source", topic_id: 53, topic_url: `${config.serverUrl}/t/source/53`, content_html: "<p>Current source body.</p>", source: { platform: "discourse", origin: config.serverUrl, topic_id: 53, topic_url: `${config.serverUrl}/t/source/53`, post_id: 149, post_number: 1, post_version: 1, revision: "post:149:version:1", edition: "a".repeat(64), created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-12T00:00:00Z", forum_name: "Source Forum", author: { name: "Source Author", profile_url: `${config.serverUrl}/u/author` } }, bindings: [{ role: "presentation", state: "active", native_materialization: true, presentation_mode: "full", canonical_url: "https://hugo.example/discussionbridge/source/" }] }; }
const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
async function fixture(context) { await mkdir(base, { recursive: true }); const dir = await mkdtemp(path.join(base, "edition-")); context.after(async () => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(base)); await rm(dir, { recursive: true, force: true }); }); return dir; }

test("coherent editions update managed native metadata and retain body and explicit presentation", async (context) => {
  const dir = await fixture(context); const source = record();
  const options = { contentDir: dir, siteUrl: "https://hugo.example", config: { ...config }, fetchImpl: async () => json({ bridge_records: [source], pagination: { page: 1, pages: 1, total: 1, snapshot: "same" } }) };
  assert.equal((await syncNativePublications(options)).created, 1);
  // Existing owned publications retain their established rendering path on an
  // upgrade without a newly added creation selector.
  options.config.nativeShortcode = undefined;
  const file = path.join(dir, "discussionbridge", "source.md");
  let content = await readFile(file, "utf8");
  assert.match(content, /date = "2026-01-01T00:00:00Z"/u);
  assert.match(content, /lastmod = "2026-10-12T00:00:00Z"/u);
  content = content.replace('discussionbridge_presentation_mode = "full"', 'discussionbridge_presentation_mode = "simple"').replace("\n+++\n", '\noperator_property = "retain"\n[custom]\nvalue = "also retain"\n+++\n') + "\nOperator body outside the source presentation.\n";
  await writeFile(file, content);
  source.title = "Edited title with unchanged post version";
  source.source.edition = "b".repeat(64); source.source.updated_at = "2026-10-12T01:00:00Z";
  source.source.forum_name = "Renamed Source Forum";
  assert.equal((await syncNativePublications(options)).updated, 1);
  const updated = await readFile(file, "utf8");
  assert.match(updated, /title = "Edited title with unchanged post version"/u);
  assert.match(updated, /lastmod = "2026-10-12T01:00:00Z"/u);
  assert.match(updated, /discussionbridge_presentation_mode = "simple"/u);
  assert.match(updated, /Renamed Source Forum/u);
  assert.match(updated, /operator_property = "retain"\n\[custom\]\nvalue = "also retain"/u);
  assert.ok(updated.endsWith("Operator body outside the source presentation.\n"));
  assert.equal((await syncNativePublications(options)).unchanged, 1);
  const edited = updated.replace('title = "Edited title with unchanged post version"', 'title = "Locally edited managed title"');
  await writeFile(file, edited); source.source.edition = "c".repeat(64);
  const attention = await syncNativePublications(options);
  assert.equal(attention.failed, 1); assert.match(attention.errors[0].reason, /title.*edited locally/u);
  assert.equal(await readFile(file, "utf8"), edited);
});

test("a changed detail edition cannot be combined with older native metadata", async (context) => {
  const dir = await fixture(context);
  const manifestPath = path.join(dir, "manifest.json"); const outputPath = path.join(dir, "data.json");
  const manifest = { site_origin: "https://hugo.example", pages: [{ key: "source", mode: "from_discourse", canonical_url: "https://hugo.example/discussionbridge/source/", title: "Original", resource_id: id, source_edition: "a".repeat(64) }] };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const source = record(); source.source.edition = "b".repeat(64);
  await assert.rejects(prepare({ manifestPath, outputPath, config: { ...config }, fetchImpl: async () => json({ bridge_record: source }) }), /changed edition/u);
  await assert.rejects(readFile(outputPath), { code: "ENOENT" });
  manifest.pages[0].source_edition = "A".repeat(64);
  assert.throws(() => preflight(manifest, { ...config }), /source edition/u);
});

test("explicit withdrawal and restoration keep exact native ownership and operator selection", async (context) => {
  const dir = await fixture(context); let source = record();
  const options = { contentDir: dir, siteUrl: "https://hugo.example", config: { ...config }, fetchImpl: async () => json({ bridge_records: [source], pagination: { page: 1, pages: 1, total: 1, snapshot: "one" } }) };
  await syncNativePublications(options);
  const file = path.join(dir, "discussionbridge", "source.md");
  const selected = (await readFile(file, "utf8")).replace('discussionbridge_presentation_mode = "full"', 'discussionbridge_presentation_mode = "simple"') + "\nOperator-owned recovery body.\n";
  await writeFile(file, selected);
  const active = structuredClone(source);
  source = { ...source, title: "Source publication withdrawn", content_html: null, source: { status: "withdrawn", reason: "source_unavailable", edition: "d".repeat(64) } };
  assert.equal((await syncNativePublications(options)).withdrawn, 1);
  const withdrawn = await readFile(file, "utf8");
  assert.match(withdrawn, /draft = true/u); assert.match(withdrawn, /title = "Source publication withdrawn"/u);
  assert.match(withdrawn, /discussionbridge_presentation_mode = "simple"/u);
  assert.ok(withdrawn.endsWith("Operator-owned recovery body.\n"));
  source = active; source.title = "Restored source"; source.source.edition = "e".repeat(64);
  assert.equal((await syncNativePublications(options)).updated, 1);
  const restored = await readFile(file, "utf8");
  assert.match(restored, /draft = false/u); assert.match(restored, /title = "Restored source"/u);
  assert.match(restored, /discussionbridge_presentation_mode = "simple"/u);
  assert.ok(restored.endsWith("Operator-owned recovery body.\n"));
});

test("native binding URL drift cannot create a second page or erase an existing identity", async (context) => {
  const dir = await fixture(context), source = record();
  const options = { contentDir: dir, siteUrl: "https://hugo.example", config: { ...config }, fetchImpl: async () => json({ bridge_records: [source], pagination: { page: 1, pages: 1, total: 1, snapshot: "one" } }) };
  assert.equal((await syncNativePublications(options)).created, 1); const file = path.join(dir, "discussionbridge", "source.md"), before = await readFile(file, "utf8");
  source.bindings[0].canonical_url = "https://hugo.example/discussionbridge/moved/";
  const result = await syncNativePublications(options); assert.equal(result.failed, 1); assert.match(result.errors[0].reason, /binding location changed/u); assert.equal(await readFile(file, "utf8"), before); await assert.rejects(readFile(path.join(dir, "discussionbridge", "moved.md")), { code: "ENOENT" });
});
