import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { HUGO_TO_SOURCE_PROFILE, verifyToSourcePublic } from "../src/to-source-proof.mjs";
import { nativeSemanticJson } from "../src/native-state.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const move = "11111111-1111-4111-8111-111111111111", resource = "22222222-2222-4222-8222-222222222222";
const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
function fixture({ articleAttributes = "", titleAttributes = "", bodyWrapper, body = '<p>Résumé 😀 <a href="https://native.example/old/child/">Child</a></p>' } = {}) {
  const complete = Buffer.from(body), source = "source-one", revision = "native-first";
  const descriptor = { schema_version: "db-hugo-source-capture-1", source_id: source, source_revision: revision,
    source_article_url: "https://native.example/old/", content_sha256: sha(complete), content_bytes: complete.length,
    source_snapshot: `source-snapshots/${sha(source)}/${sha(revision)}-${sha(complete)}.html` };
  const birth = { ...descriptor, capture_descriptor: `source-captures/${sha(nativeSemanticJson(descriptor))}.json` };
  const blob = (name) => ({ path: `source-moves/${move}/${name}.html`, bytes: complete.length, sha256: sha(complete) });
  const receipt = { schema_version: "db-hugo-to-source-receipt-1", verification_profile: HUGO_TO_SOURCE_PROFILE,
    binding: { connection_id: "dbc_0123456789abcdef01234567", forum_origin: "https://forum.example", site_root: path.resolve("never-created-site"),
      content_root: path.resolve("never-created-site/content"), scope_revision: "scope-1", lane: "default" },
    resource_id: resource, topic_id: "53", external_id: source, native_id: "article.md", canonical_url: "https://native.example/new/", source_revision: "moved-edition",
    source_file_sha256: sha("synthetic native file"), source_content_sha256: sha(complete), source_content_bytes: complete.length,
    title: "Synthetic article", source_authors: [], source_created_at: null, source_updated_at: null,
    capture: { birth, native_before: blob("before"), native_after: blob("after"), prepared: blob("prepared") },
    native_inputs_sha256: sha("selected native inputs"), public_data_sha256: sha("public data"), move_id: move, proof_nonce: Buffer.alloc(32, 7).toString("base64url") };
  const attributes = { profile: HUGO_TO_SOURCE_PROFILE, "resource-id": resource, "topic-id": receipt.topic_id, "external-id": source,
    "native-id": receipt.native_id, "canonical-url": receipt.canonical_url, "source-revision": receipt.source_revision,
    "source-file-sha256": receipt.source_file_sha256, "source-content-sha256": receipt.source_content_sha256,
    "source-authors-sha256": sha(nativeSemanticJson([])), title: receipt.title, "move-id": move, "proof-nonce": receipt.proof_nonce };
  let articleBody = `<!--discussionbridge-to-source-article-start-->${body}<!--discussionbridge-to-source-article-end-->`;
  if (bodyWrapper) articleBody = bodyWrapper(articleBody);
  const frame = `<!--discussionbridge-to-source-start:${resource}--><article ${Object.entries(attributes).map(([name, value]) => `data-discussionbridge-to-${name}="${escape(value)}"`).join(" ")} ${articleAttributes}><h1 ${titleAttributes}>Synthetic article</h1>${articleBody}</article><!--discussionbridge-to-source-end:${resource}-->`;
  const page = (html) => Buffer.from(`<html><body>${html}</body></html>`);
  const expectedHtml = page(" ".repeat(3000) + frame);
  const verify = (html = page(frame), media = "text/html; charset=UTF-8") => verifyToSourcePublic({ receipt, completeArticle: complete, expectedHtml,
    publicFetch: async (url, options) => {
      assert.equal(url.href, receipt.canonical_url); assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
      assert.deepEqual(Object.keys(options.headers).sort(), ["Accept", "Accept-Encoding"]);
      return new Response(html, { headers: { "content-type": media } });
    } });
  return { receipt, frame, page, expectedHtml, verify };
}

for (const [name, wrap] of Object.entries({
  template: (s) => `<template>${s}</template>`, hidden: (s) => `<div hidden>${s}</div>`,
  hiddenFalse: (s) => `<div hidden="false">${s}</div>`, inert: (s) => `<div inert>${s}</div>`,
  displayNone: (s) => `<div style="display:none">${s}</div>`, visibilityHidden: (s) => `<div style="visibility:hidden">${s}</div>`,
  noscript: (s) => `<noscript>${s}</noscript>`, textarea: (s) => `<textarea>${s}</textarea>`,
  scriptData: (s) => `<script type="application/json">${s}</script>`, styleData: (s) => `<style>${s}</style>`,
  titleData: (s) => `<title>${s}</title>`, xmpData: (s) => `<xmp>${s}</xmp>`,
  iframeFallback: (s) => `<iframe>${s}</iframe>`, noembed: (s) => `<noembed>${s}</noembed>`,
  noframes: (s) => `<noframes>${s}</noframes>`, plaintext: (s) => `<plaintext>${s}</plaintext>`,
})) test(`public proof rejects ${name} context around otherwise exact article`, async () => {
  const f = fixture(); await assert.rejects(f.verify(f.page(wrap(f.frame))), { code: "public_verification_failed" });
});

for (const options of [{ articleAttributes: "hidden" }, { titleAttributes: "hidden" }, { bodyWrapper: (s) => `<div inert>${s}</div>` }]) {
  test(`expected native output cannot qualify an inactive owned boundary ${Object.keys(options)[0]}`, async () => {
    await assert.rejects(fixture(options).verify(), { code: "public_verification_failed" });
  });
}
test("fake markers in script data cannot borrow a different active article", async () => {
  const f = fixture();
  await assert.rejects(f.verify(f.page(`<script>${f.frame}</script><article data-discussionbridge-to-resource-id="${resource}">Wrong source</article>`)), { code: "public_verification_failed" });
});
test("ordinary whole Unicode article and displayed markup remain valid", async () => {
  const f = fixture(); assert.equal((await f.verify()).source_content_sha256, f.receipt.source_content_sha256);
  await fixture({ body: '<pre><code>&lt;template hidden&gt;shown code&lt;/template&gt;</code></pre>' }).verify();
});
test("ordinary surrounding Unicode and source-owned disclosures/templates stay supported", async () => {
  const f = fixture(); await f.verify(f.page(`Navigation 😀 ${f.frame}`));
  await fixture({ body: '<p>Visible context</p><details><summary>More</summary><p>Details</p></details><template><p>Native component content</p></template>' }).verify();
});
test("ordinary inline style values and visible overrides stay supported", async () => {
  for (const style of ['--hint: "x;display:none;y";color:blue', 'display:none;display:block', 'display:none;display:block!important', 'di/**/splay:none;color:blue', 'constructor:ignored;color:blue', '__proto__:ignored;visibility:visible']) {
    await fixture({ articleAttributes: `style='${style}'` }).verify();
  }
});
test("public proof rejects commented hiding and important hiding declarations", async () => {
  for (const style of ['display:/**/none', 'display:none!important;display:block']) {
    await assert.rejects(fixture({ articleAttributes: `style="${style}"` }).verify(), { code: "public_verification_failed" });
  }
});
test("whole body and nonce mismatches remain refused", async () => {
  const f = fixture();
  for (const html of [f.frame.replace("Résumé", "Wrong"), f.frame.replace(f.receipt.proof_nonce, "X".repeat(43))]) {
    await assert.rejects(f.verify(f.page(html)), { code: "public_verification_failed" });
  }
});
for (const media of ["text/html", "TEXT/HTML", "text/html; charset=UTF-8", 'text/html; charset="utf-8"',
  "text/html; profile=source; charset=UTF-8", 'text/html; note="charset=ISO-8859-1; opaque"; charset=UTF-8']) {
  test(`public proof keeps supported HTML metadata ${media}`, async () => { await fixture().verify(undefined, media); });
}
for (const media of ["text/htmlx", "text/plain", "application/json", "text/html, text/plain", "text/html; charset=ISO-8859-1",
  "text/html; charset=UTF-16", "text/html; charset=UTF-8; charset=UTF-8", "text/html; charset=UTF-8; charset=ISO-8859-1",
  "text/html; charset=", "text/html; charset", 'text/html; charset="UTF-8', "text/html; charset=UTF-8, text/plain"]) {
  test(`public proof rejects conflicting or ambiguous HTML metadata ${media}`, async () => {
    await assert.rejects(fixture().verify(undefined, media), { code: "public_verification_failed" });
  });
}
