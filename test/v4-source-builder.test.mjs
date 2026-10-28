import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { toRecord } from "../src/to-source.mjs";
import { projectSourceMoveRecord } from "../src/source-move-intent.mjs";
import { validateCms, validateGeneratedSelection, generatedReadMore } from "../src/protocol-v4/cms-runtime.mjs";
import { connection } from "../test-support/cms-fixture.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const page = (html) => ({ full_content_html: html, external_id: "source-native", canonical_url: "https://hugo.example/native/", title: "Native source",
  to_created_at: null, to_updated_at: null, source_authors: [{ id: "editor", name: "Editor" }] });
test("one V4 builder selects envelope-only excerpt with truthful complete source and exact owned suffix", () => {
  const complete = `<p>${'"'.repeat(35000)}</p>`; const record = toRecord(page(complete), connection(), { correlationId: randomUUID() });
  assert.ok(Buffer.byteLength(complete) <= 49152); assert.equal(record.representation.kind, "generated_excerpt");
  assert.ok(record.representation.selection_full_request_bytes > 65536);
  assert.equal(record.source_content_bytes, Buffer.byteLength(complete)); assert.equal(record.source_content_sha256, hash(complete));
  assert.ok(record.content_html.endsWith(generatedReadMore(record.canonical_url)));
  const prefix = Buffer.from(record.content_html).subarray(0, record.representation.article_content_bytes);
  assert.equal(hash(prefix), record.representation.article_content_sha256);
  assert.ok(Buffer.byteLength(JSON.stringify({ mutation_id: randomUUID(), bridge_record: record })) <= 65536);
  validateGeneratedSelection(record); validateCms("ToRecord", record);
});
test("V4 full and generated move projections retain article and identities; infeasible URL never truncates prefix", () => {
  const full = toRecord(page("<p>Complete native article</p>"), connection(), { correlationId: randomUUID() });
  const movedFull = projectSourceMoveRecord(full, "https://hugo.example/new-full/", randomUUID(), null);
  assert.equal(movedFull.content_html, full.content_html); assert.equal(movedFull.source_content_sha256, full.source_content_sha256);
  const excerpt = toRecord(page(`<p>${"Large native 😀 source ".repeat(8000)}</p>`), connection(), { correlationId: randomUUID() });
  const moved = projectSourceMoveRecord(excerpt, "https://hugo.example/new-excerpt/", randomUUID(), null);
  const prefix = excerpt.content_html.slice(0, -generatedReadMore(excerpt.canonical_url).length);
  assert.equal(moved.content_html, prefix + generatedReadMore(moved.canonical_url));
  assert.equal(moved.external_id, excerpt.external_id); assert.equal(moved.source_content_sha256, excerpt.source_content_sha256);
  assert.equal(moved.representation.article_content_sha256, excerpt.representation.article_content_sha256);
  assert.equal(moved.representation.selection_source_revision, excerpt.representation.selection_source_revision);
  assert.equal(moved.representation.selection_full_request_bytes, excerpt.representation.selection_full_request_bytes);
  validateGeneratedSelection(moved, moved);
  assert.throws(() => projectSourceMoveRecord(excerpt, "https://hugo.example/" + "&".repeat(1700) + "/", randomUUID(), null), { code: "body_too_large" });
  assert.equal(excerpt.content_html, prefix + generatedReadMore(excerpt.canonical_url));
});
