import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connection } from "../test-support/cms-fixture.mjs";

const component = process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT ? path.resolve(process.env.DISCUSSIONBRIDGE_TEST_PACKAGE_ROOT) : fileURLToPath(new URL("..", import.meta.url));
const { prepareNativeSource, prepareNativeToSource, preserveSourceCapture, readSourceCapture } = await import(pathToFileURL(path.join(component, "src/source-preparation.mjs")));
const { toRecord } = await import(pathToFileURL(path.join(component, "src/to-source.mjs")));
const { projectSourceMoveRecord } = await import(pathToFileURL(path.join(component, "src/source-move-intent.mjs")));
const { readOperationalState, writeOperationalState, SOURCE_STATE_IDENTITY } = await import(pathToFileURL(path.join(component, "src/operational-state.mjs")));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex"), articleUrl = "https://source.example/articles/entry/?original=1";

test("plain and image-only sources retain content; copied targets use the captured article URL under existing safety", () => {
  for (const prepare of [(html) => prepareNativeToSource(html, articleUrl), (html) => prepareNativeSource(html, undefined, articleUrl)]) {
    assert.deepEqual(prepare("plain unformatted source 😀"), { html: "plain unformatted source 😀", losses: [] });
    const image = prepare('<img src="../media/image.png" alt="A photo">');
    assert.equal(image.losses.length, 0); assert.match(image.html, /src="https:\/\/source\.example\/articles\/media\/image\.png"/u);
    const result = prepare('<a href="?page=2&amp;filter=one#part">Query</a><a href="#section">Fragment</a><img src="/images/source.png">');
    assert.equal(result.losses.length, 0);
    assert.match(result.html, /href="https:\/\/source\.example\/articles\/entry\/\?page=2&amp;filter=one#part"/u);
    assert.match(result.html, /href="https:\/\/source\.example\/articles\/entry\/\?original=1#section"/u);
    assert.match(result.html, /src="https:\/\/source\.example\/images\/source\.png"/u);
    for (const unsupported of ['<img src="http://media.example/image.png">', '<img src="//media.example/image.png">']) {
      const observed = prepare(unsupported); assert.equal(observed.losses[0].attribute, "src"); assert.ok(!observed.html.includes('src="'));
    }
    assert.equal(prepare('<script>unsafe()</script>').losses[0].kind, "native_script");
  }
});

test("actual removed functional markup is specific; displayed code/comments/data are not executable-function observations", () => {
  const interactive = '<p>Keep context</p><a href="child/" onclick="nativeAction()">Act</a><script>function nativeAction(){document.querySelector("a").textContent="Done"}</script>';
  const prepared = prepareNativeToSource(interactive, articleUrl);
  assert.equal(prepared.losses.filter((entry) => entry.kind === "native_event_handler" && entry.attribute === "onclick").length, 1);
  assert.equal(prepared.losses.filter((entry) => entry.kind === "native_script").length, 1);
  assert.ok(prepared.html.includes("Keep context")); assert.ok(!prepared.html.includes("onclick"));
  const displayed = '<pre><code>&lt;script&gt;shown()&lt;/script&gt; onclick="shown()"</code></pre><!-- <script>commentOnly()</script> -->';
  const code = prepareNativeToSource(displayed, articleUrl); assert.equal(code.losses.length, 0);
  assert.ok(code.html.includes("&lt;script&gt;shown()&lt;/script&gt;"));
  const data = prepareNativeToSource('<p>Context</p><script type="application/json">{"value":true}</script>', articleUrl);
  assert.equal(data.losses.some((entry) => ["native_script", "native_event_handler"].includes(entry.kind)), false);
  assert.equal(data.losses[0].kind, "source_data_script"); // Removed data, not a claim that it executed.
  const existingSupported = prepareNativeToSource('<p><a href="child/">Ordinary link</a><img src="image.png"></p><pre><code>shown()</code></pre>', articleUrl);
  assert.equal(existingSupported.losses.length, 0);
  // Isolated faithful native component seam: observing a supported renderer's
  // unchanged function does not manufacture a loss or enable a product recipe.
  const absoluteInteractive = interactive.replace('href="child/"', 'href="https://source.example/articles/entry/child/"');
  assert.equal(prepareNativeSource(absoluteInteractive, (html) => html, articleUrl).losses.length, 0);
});

test("original bytes and captured base are immutable; the complete prepared article precedes excerpt and canonical-only projection", async (t) => {
  const base = path.join(component, ".tmp", "preparation-tests"); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "capture-"));
  t.after(async () => { assert.equal(path.dirname(root), base); await rm(root, { recursive: true, force: true }); });
  const original = Buffer.from('<p><a href="../original-target/">Source target</a>' + "Complete source 😀 ".repeat(8000) + '</p><img src="image.png">');
  const source = { source_id: "native-source", source_revision: "native-revision", content_sha256: hash(original), content_bytes: original.length };
  const captured = await preserveSourceCapture(root, source, original, articleUrl), descriptor = await readFile(path.join(root, captured.capture_descriptor));
  assert.deepEqual(await readSourceCapture(root, captured), original); assert.equal(captured.source_article_url, articleUrl);
  assert.deepEqual(await preserveSourceCapture(root, source, original, articleUrl), captured);
  const prepared = prepareNativeToSource(original.toString(), captured.source_article_url); assert.equal(prepared.losses.length, 0);
  const record = toRecord({ full_content_html: prepared.html, external_id: "native-source", canonical_url: articleUrl, title: "Native source",
    to_created_at: null, to_updated_at: null, source_authors: [] }, connection(), { correlationId: randomUUID() });
  assert.equal(record.representation.kind, "generated_excerpt"); assert.equal(record.source_content_sha256, hash(prepared.html));
  assert.equal(record.source_content_bytes, Buffer.byteLength(prepared.html)); assert.notEqual(record.source_content_sha256, source.content_sha256);
  const before = structuredClone(record), moved = projectSourceMoveRecord(record, "https://source.example/changed/", randomUUID(), null);
  assert.deepEqual(record, before); assert.equal(moved.source_content_sha256, record.source_content_sha256);
  assert.equal(moved.representation.article_content_sha256, record.representation.article_content_sha256);
  assert.deepEqual(await readFile(path.join(root, captured.capture_descriptor)), descriptor); assert.deepEqual(await readSourceCapture(root, captured), original);
  await writeFile(path.join(root, captured.capture_descriptor), "changed"); await assert.rejects(readSourceCapture(root, captured), /descriptor changed/u);
});

test("new V4 ledger identity is separate from retained creation provenance; missing identity is not backfilled", async (t) => {
  const base = path.join(component, ".tmp", "preparation-tests"); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "state-"));
  t.after(async () => { assert.equal(path.dirname(root), base); await rm(root, { recursive: true, force: true }); });
  const file = path.join(root, "source-state.json"), state = await readOperationalState(file);
  assert.deepEqual(state.wireIdentity, SOURCE_STATE_IDENTITY); const provenance = structuredClone(state.candidate);
  await writeOperationalState(file, state); const before = await readFile(file);
  const restored = await readOperationalState(file); assert.deepEqual({ ...restored.candidate }, provenance); assert.deepEqual(await readFile(file), before);
  const absent = JSON.parse(before); delete absent.wireIdentity; const absentBytes = Buffer.from(JSON.stringify(absent)); await writeFile(file, absentBytes);
  await assert.rejects(readOperationalState(file), { code: "native_state_identity_unavailable" }); assert.deepEqual(await readFile(file), absentBytes);
});
