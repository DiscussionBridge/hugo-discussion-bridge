import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hydratePublication } from "../src/publication-content.mjs";
import { prepare } from "../src/adapter.mjs";
import { readOperationalState } from "../src/operational-state.mjs";

const id = "11111111-1111-4111-8111-111111111111"; const edition = "a".repeat(64);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function source(bytes) { return { resource_id: id, direction: "from_discourse", state: "healthy", title: "Large source", topic_id: 53, topic_url: "https://forum.example/t/source/53", content_html: null, source: { edition, content: { bytes: bytes.length, sha256: hash(bytes), path: `/discussion-bridge/v1/bridge-records/${id}/content.json`, chunk_bytes: 32768 } } }; }
function chunk(record, bytes, offset) { const selected = bytes.subarray(offset, offset + 32768); const next = offset + selected.length; return { resource_id: id, edition, offset, total_bytes: bytes.length, content_sha256: record.source.content.sha256, chunk_base64: selected.toString("base64"), next_offset: next === bytes.length ? null : next }; }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("large UTF8 source transfers validate each chunk and final bytes without a universal publication cap", async () => {
  const bytes = Buffer.from(`<h2>Large source</h2><p>${"é".repeat(400000)}</p>`); const record = source(bytes); let count = 0;
  const html = await hydratePublication(record, async (pathname) => { const offset = Number(new URL(pathname, "https://forum.example").searchParams.get("offset")); count++; return { ok: true, status: 200, payload: chunk(record, bytes, offset) }; });
  assert.equal(html, bytes.toString("utf8")); assert.equal(count, Math.ceil(bytes.length / 32768));
});

test("wrong identity, offsets, digest and cross-source paths are rejected before content use", async () => {
  const bytes = Buffer.from("<p>Source body.</p>"); const record = source(bytes);
  for (const corrupt of [{ resource_id: "22222222-2222-4222-8222-222222222222" }, { offset: 1 }, { next_offset: 0 }, { chunk_base64: Buffer.from("wrong body").toString("base64") }]) {
    await assert.rejects(hydratePublication(record, async () => ({ ok: true, status: 200, payload: { ...chunk(record, bytes, 0), ...corrupt } })), /chunk|digest/u);
  }
  const bad = structuredClone(record); bad.source.content.path = "https://other.example/content";
  await assert.rejects(hydratePublication(bad, async () => { throw Error("must not fetch"); }), /descriptor/u);
});

test("unchanged source editions reuse validated sanitized data and bounded source changes terminate", async (context) => {
  const base = fileURLToPath(new URL("../.tmp/content-transfer-tests/", import.meta.url)); await mkdir(base, { recursive: true }); const dir = await mkdtemp(path.join(base, "body-"));
  context.after(async () => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(base)); await rm(dir, { recursive: true, force: true }); });
  const bytes = Buffer.from(`<p>${"large ".repeat(20000)}</p><script>unsafe()</script>`); const record = source(bytes);
  const manifestPath = path.join(dir, "manifest.json"); const outputPath = path.join(dir, "data.json");
  await writeFile(manifestPath, JSON.stringify({ site_origin: "https://hugo.example", pages: [{ key: "source", mode: "from_discourse", canonical_url: "https://hugo.example/source/", title: "Source", resource_id: id }] }));
  let chunks = 0; let metadata = 0;
  const fetchImpl = async (address, options) => { const url = new URL(address); assert.equal(url.origin, "https://forum.example"); assert.equal(options.headers["X-DiscussionBridge-Secret"], "s".repeat(48)); if (url.pathname.endsWith("content.json")) { chunks++; return json(chunk(record, bytes, Number(url.searchParams.get("offset")))); } metadata++; assert.equal(url.searchParams.get("publication_contract"), "0.3.0-alpha.1"); return json({ bridge_record: record }); };
  const options = { manifestPath, outputPath, config: { serverUrl: "https://forum.example", connectionId: "dbc_0123456789abcdef01234567", connectionSecret: "s".repeat(48) }, fetchImpl };
  await prepare(options); const firstChunks = chunks; assert.ok(firstChunks > 1);
  assert.doesNotMatch(await readFile(outputPath, "utf8"), /unsafe\(\)|ssssss/u);
  await prepare(options); assert.equal(metadata, 2); assert.equal(chunks, firstChunks);
  await rm(outputPath); let restarts = 0;
  await assert.rejects(prepare({ ...options, fetchImpl: async (address) => { if (new URL(address).pathname.endsWith("content.json")) { restarts++; return json({}, 409); } return json({ bridge_record: record }); } }), /source changed/u);
  assert.equal(restarts, 3); await assert.rejects(readFile(outputPath), { code: "ENOENT" });
});

test("withdrawal removes renderable body and retains bounded private identity metadata only", async (context) => {
  const base = fileURLToPath(new URL("../.tmp/content-transfer-tests/", import.meta.url)); await mkdir(base, { recursive: true }); const dir = await mkdtemp(path.join(base, "withdraw-"));
  context.after(async () => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(base)); await rm(dir, { recursive: true, force: true }); });
  const manifestPath = path.join(dir, "manifest.json"); const outputPath = path.join(dir, "data.json"); const statePath = path.join(dir, ".discussionbridge", "state.json");
  await writeFile(manifestPath, JSON.stringify({ site_origin: "https://hugo.example", pages: [{ key: "source", mode: "from_discourse", canonical_url: "https://hugo.example/source/", title: "Source", resource_id: id }] }));
  await writeFile(outputPath, JSON.stringify({ source: { resource_id: id, topic_id: 53, forum_origin: "https://forum.example", content_html: "<p>Previously public source body.</p>", source_edition: edition, presentation_mode: "full" } }));
  const withdrawn = { resource_id: id, direction: "from_discourse", state: "healthy", topic_id: 53, title: "Source publication withdrawn", source: { status: "withdrawn", edition: "f".repeat(64) }, content_html: null };
  await prepare({ manifestPath, outputPath, statePath, config: { serverUrl: "https://forum.example", connectionId: "dbc_0123456789abcdef01234567", connectionSecret: "s".repeat(48) }, fetchImpl: async () => json({ bridge_record: withdrawn }) });
  const output = await readFile(outputPath, "utf8"); assert.doesNotMatch(output, /Previously public/u);
  const state = await readOperationalState(statePath);
  assert.equal(state.withdrawalRecovery[id].publicWithdrawalVerified, false);
  assert.equal(state.withdrawalRecovery[id].priorSourceEdition, edition);
  assert.doesNotMatch(JSON.stringify(state), /Previously public|content_html|ssssss/u);
});
