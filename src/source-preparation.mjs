import { createHash, randomUUID } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import path from "node:path";
import sanitizeHtml from "sanitize-html";
import { sanitizePublicationHtml, cleanSourceHtml, copiedSourceTarget } from "./native-content.mjs";
import { validateCms } from "./protocol-v4/cms-runtime.mjs";
import { readRegular, durableDirectory, syncDirectory } from "./native-io.mjs";
import { nativeSemanticJson } from "./native-state.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Observation of actual removed meaningful nodes, not a media admission rule.
// Escaped code/comments are not HTML players, and tag presence alone is not loss.
function meaningfulPlayers(html) {
  const players = [], stack = [];
  sanitizeHtml(html, { allowedTags: [], allowedAttributes: {},
    onOpenTag(tag, attributes) {
      const parent = stack.findLast((entry) => ["video", "audio"].includes(entry.tag));
      const playable = ["video", "audio", "iframe", "embed", "object"].includes(tag);
      const relevant = ["src", "data", "poster", "type", "controls", "autoplay", "loop", "muted", "preload", "width", "height"];
      const entry = { tag, hasSource: playable && [attributes.src, attributes.data, attributes.poster].some((value) => typeof value === "string" && value.trim()),
        attributes: Object.fromEntries(Object.entries(attributes).filter(([key]) => relevant.includes(key))), sources: [] };
      if (tag === "source" && parent && typeof attributes.src === "string" && attributes.src.trim()) { parent.hasSource = true; parent.sources.push({ src: attributes.src, ...(attributes.type === undefined ? {} : { type: attributes.type }) }); }
      if (playable) players.push(entry); stack.push(entry);
    },
    onCloseTag(tag) { const index = stack.findLastIndex((entry) => entry.tag === tag); if (index >= 0) stack.splice(index); }
  });
  return players.filter((item) => item.hasSource).map(({ tag, attributes, sources }) => ({ tag, identity: sha(nativeSemanticJson({ tag, attributes, sources })) }));
}
function copiedTargets(html, sourceArticleUrl) {
  const targets = [];
  sanitizeHtml(html, { allowedTags: [], allowedAttributes: {}, onOpenTag(tag, attributes) {
    const attribute = tag === "a" ? "href" : tag === "img" ? "src" : null;
    if (attribute !== null && typeof attributes[attribute] === "string") targets.push({ tag, attribute, target: copiedSourceTarget(attributes[attribute], sourceArticleUrl) });
  } });
  return targets;
}
function parsedFunctions(html) {
  const functions = [], scripts = [], stack = [];
  // Observation only. This parser output is discarded and never authorizes
  // native execution or modifies the actual sanitizer's allowed content.
  sanitizeHtml(html, { allowedTags: [], allowedAttributes: {}, nonTextTags: [],
    onOpenTag(tag, attributes) {
      const script = tag === "script" ? { tag, type: (attributes.type ?? "").trim().toLowerCase(), source: attributes.src ?? "", body: "" } : null;
      stack.push({ tag, script }); if (script !== null) scripts.push(script);
      for (const [attribute, value] of Object.entries(attributes)) if (/^on[a-z]+$/u.test(attribute) && value.trim()) functions.push({
        kind: "native_event_handler", tag, attribute, identity: sha(nativeSemanticJson({ tag, attribute, value }))
      });
    },
    textFilter(text) { const script = stack.findLast((entry) => entry.script !== null)?.script; if (script) script.body += text; return text; },
    onCloseTag(tag) { const index = stack.findLastIndex((entry) => entry.tag === tag); if (index >= 0) stack.splice(index); }
  });
  for (const script of scripts) if (script.source.trim() || script.body.trim()) {
    const executable = ["", "module", "text/javascript", "application/javascript"].includes(script.type);
    const kind = executable ? "native_script" : ["application/json", "application/ld+json"].includes(script.type) ? "source_data_script" : "source_script_element";
    functions.push({ kind, tag: "script", type: script.type,
      identity: sha(nativeSemanticJson(script)) });
  }
  return functions;
}

const controls = new Set(["form", "input", "button", "select", "textarea", "option", "optgroup", "fieldset", "legend", "label", "details", "summary"]);
const controlText = new Set(["button", "textarea", "option", "legend", "label", "summary"]);
const opaqueFacilities = new Set(["style", "svg", "canvas"]);
const semanticAttributes = {
  ol: ["start", "reversed", "type"], li: ["value"],
  td: ["id", "colspan", "rowspan", "headers"], th: ["id", "colspan", "rowspan", "scope", "headers"],
  col: ["span"], colgroup: ["span"], time: ["datetime"],
  img: ["srcset", "sizes"], iframe: ["srcdoc"],
};
const safeName = (value) => String(value).replace(/[^a-zA-Z0-9_:.-]/gu, "_").slice(0, 64);

// Hugo's established Chroma conversion removes decorative spans/styles but
// keeps the displayed code and language. Prove that identity first; a class
// name alone cannot excuse a changed code block or additional meaningful CSS.
function codeBlocks(html) {
  const blocks = [], stack = [];
  sanitizeHtml(html, { allowedTags: [], allowedAttributes: {}, nonTextTags: [],
    onOpenTag(tag, attributes) {
      const classes = (attributes.class ?? "").split(/\s+/u);
      const block = tag === "pre" ? { index: blocks.length, text: "", language: null,
        chroma: classes.includes("chroma") || stack.some((entry) => entry.highlight) } : null;
      if (block) blocks.push(block);
      const current = block ?? stack.findLast((entry) => entry.block)?.block;
      const language = tag === "code" ? classes.find((name) => /^language-[a-zA-Z0-9_+.-]+$/u.test(name))?.slice(9) : null;
      if (current && tag === "code" && language && (!attributes["data-lang"] || attributes["data-lang"] === language)) current.language = language;
      stack.push({ tag, block, highlight: tag === "div" && classes.includes("highlight"), code: tag === "code" ? current : null });
    },
    textFilter(text) { const current = stack.findLast((entry) => entry.code)?.code; if (current) current.text += text; return text; },
    onCloseTag(tag) { const index = stack.findLastIndex((entry) => entry.tag === tag); if (index >= 0) stack.splice(index); },
  });
  return blocks.filter((block) => block.language).map((block) => ({ ...block, identity: sha(nativeSemanticJson({ text: block.text, language: block.language })) }));
}
function verifiedCodeDecoration(html, rendered) {
  const after = new Map(), verified = new Map();
  for (const item of codeBlocks(rendered)) after.set(item.identity, (after.get(item.identity) ?? 0) + 1);
  for (const item of codeBlocks(html)) {
    const remaining = after.get(item.identity) ?? 0;
    if (item.chroma && remaining) { verified.set(item.index, !item.text.includes("\t")); after.set(item.identity, remaining - 1); }
  }
  return verified;
}
function knownCodeDecoration(tag, style, noTabs) {
  if (!["pre", "span"].includes(tag)) return false;
  return style.split(";").map((value) => value.trim()).filter(Boolean).every((value) =>
    /^(?:background-color|color)\s*:\s*#[0-9a-f]{3,8}$/iu.test(value)
    || tag === "span" && /^display\s*:\s*flex$/iu.test(value)
    || tag === "pre" && /^-webkit-text-size-adjust\s*:\s*none$/iu.test(value)
    || tag === "pre" && noTabs && /^(?:-moz-tab-size|-o-tab-size|tab-size)\s*:\s*4$/iu.test(value));
}

// Observe changes made by the actual chosen renderer. This is neither an
// admission policy nor permission to execute source code/CSS. The existing
// cleaner stays responsible for what it can safely render; unsupported losses
// retain the source and require a specific local limitation.
function parsedSemantics(html, sourceArticleUrl, verifiedCode = new Map()) {
  const observations = [], stack = [], opaque = []; let preIndex = 0;
  const add = (kind, tag, attribute, value) => observations.push({ kind, tag,
    ...(attribute === undefined ? {} : { attribute }), identity: sha(nativeSemanticJson({ kind, tag, attribute: attribute ?? null, value })) });
  sanitizeHtml(html, { allowedTags: [], allowedAttributes: {}, nonTextTags: [],
    onOpenTag(tag, attributes) {
      for (const entry of stack) if (entry.tokens) entry.tokens.push(["open", tag, attributes]);
      const codeIndex = tag === "pre" ? preIndex++ : stack.findLast((item) => item.codeIndex !== undefined)?.codeIndex;
      const entry = { tag, text: "", codeIndex, ...(opaqueFacilities.has(tag) ? { tokens: [["open", tag, attributes]] } : {}) };
      if (entry.tokens) opaque.push(entry);
      stack.push(entry);
      if (controls.has(tag)) {
        add("native_control_removed", tag, undefined, true);
        for (const [name, original] of Object.entries(attributes)) {
          const value = ["action", "formaction"].includes(name) ? copiedSourceTarget(original, sourceArticleUrl) : original;
          add("native_control_attribute_removed_or_changed", tag, name, value);
        }
      }
      if (attributes.style?.trim() && !(verifiedCode.has(codeIndex) && knownCodeDecoration(tag, attributes.style, verifiedCode.get(codeIndex)))) {
        add("native_inline_style_removed_or_changed", tag, "style", attributes.style);
      }
      for (const name of semanticAttributes[tag] ?? []) if (Object.hasOwn(attributes, name)) {
        add("native_semantic_attribute_removed_or_changed", tag, name, attributes[name]);
      }
      if (tag === "link" && (attributes.rel ?? "").toLowerCase().split(/\s+/u).includes("stylesheet")) {
        add("native_stylesheet_dependency_removed_or_changed", tag, "href",
          { ...attributes, ...(attributes.href === undefined ? {} : { href: copiedSourceTarget(attributes.href, sourceArticleUrl) }) });
      }
    },
    textFilter(text) {
      for (const entry of stack) {
        if (entry.tokens) entry.tokens.push(["text", text]);
        if (controlText.has(entry.tag)) entry.text += text;
      }
      return text;
    },
    onCloseTag(tag) {
      for (const entry of stack) if (entry.tokens) entry.tokens.push(["close", tag]);
      const index = stack.findLastIndex((entry) => entry.tag === tag);
      if (index >= 0) {
        for (const entry of stack.splice(index)) if (controlText.has(entry.tag) && entry.text) {
          add("native_control_content_removed_or_changed", entry.tag, undefined, entry.text);
        }
      }
    },
  });
  for (const entry of opaque) add("native_article_facility_removed_or_changed", entry.tag, undefined, entry.tokens);
  return observations;
}

function missingObservations(before, after) {
  const counts = new Map();
  for (const item of after) counts.set(item.identity, (counts.get(item.identity) ?? 0) + 1);
  return before.filter((item) => {
    const count = counts.get(item.identity) ?? 0;
    if (!count) return true;
    counts.set(item.identity, count - 1); return false;
  });
}

export function prepareNativeSource(html, renderer = sanitizePublicationHtml, sourceArticleUrl) {
  if (sourceArticleUrl !== undefined) validateCms("Url", sourceArticleUrl);
  const before = meaningfulPlayers(html), counts = {}; let rendered;
  try { rendered = renderer(html, sourceArticleUrl); }
  catch (error) { if (error.message !== "Hugo source content is empty after sanitization.") throw error; rendered = ""; }
  for (const original of missingObservations(before, meaningfulPlayers(rendered))) counts[original.tag] = (counts[original.tag] ?? 0) + 1;
  const losses = Object.entries(counts).map(([tag, removed_count]) => ({ tag, removed_count }));
  const targets = copiedTargets(rendered);
  for (const original of copiedTargets(html, sourceArticleUrl)) {
    const match = targets.findIndex((item) => item.tag === original.tag && item.attribute === original.attribute && item.target === original.target);
    if (match >= 0) targets.splice(match, 1);
    else losses.push({ tag: original.tag, attribute: original.attribute, removed_count: 1 });
  }
  for (const original of missingObservations(parsedFunctions(html), parsedFunctions(rendered))) {
    const { identity, ...removed } = original;
    losses.push({ ...removed, tag: safeName(removed.tag),
      ...(removed.attribute === undefined ? {} : { attribute: safeName(removed.attribute) }),
      ...(removed.type === undefined ? {} : { type: safeName(removed.type) }), removed_count: 1 });
  }
  const codeDecoration = verifiedCodeDecoration(html, rendered);
  for (const original of missingObservations(parsedSemantics(html, sourceArticleUrl, codeDecoration), parsedSemantics(rendered))) {
    const { identity, ...removed } = original;
    losses.push({ ...removed, tag: safeName(removed.tag),
      ...(removed.attribute === undefined ? {} : { attribute: safeName(removed.attribute) }), removed_count: 1 });
  }
  // This observes unusable prepared output; it does not declare the source
  // absent/invalid or choose a new content-type/nonblank eligibility rule.
  if (!rendered.trim() && !losses.length) losses.push({ kind: "prepared_output_unavailable" });
  return { html: rendered, losses };
}
export function prepareNativeToSource(html, sourceArticleUrl) {
  const source = html.replace(/<section[^>]+class="discussionbridge-presentation"[\s\S]*?<\/section>/giu, "");
  return prepareNativeSource(source, cleanSourceHtml, sourceArticleUrl);
}
async function preserveImmutable(file, bytes) {
  await durableDirectory(path.dirname(file));
  const existing = await readRegular(file);
  if (existing !== null) { if (!existing.equals(bytes)) throw new Error("Hugo immutable source capture changed."); return; }
  const temp = `${file}.${randomUUID()}.tmp`; let handle;
  try {
    handle = await open(temp, "wx", 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    await link(temp, file); await syncDirectory(path.dirname(file));
  } finally { await handle?.close().catch(() => {}); await rm(temp, { force: true }); }
}
export async function preserveSourceSnapshot(privateRoot, source, bytes) {
  if (bytes.length !== source.content_bytes || sha(bytes) !== source.content_sha256) throw new Error("Hugo complete pinned source changed before preservation.");
  const relative = `source-snapshots/${sha(source.source_id)}/${sha(source.source_revision)}-${source.content_sha256}.html`;
  await preserveImmutable(path.join(privateRoot, ...relative.split("/")), bytes); return relative;
}
export function validateSourceCapture(capture) {
  const fields = ["schema_version", "source_id", "source_revision", "source_article_url", "content_sha256", "content_bytes", "source_snapshot", "capture_descriptor"];
  if (!capture || Object.keys(capture).length !== fields.length || fields.some((field) => !Object.hasOwn(capture, field)) || capture.schema_version !== "db-hugo-source-capture-1"
      || !/^source-snapshots\/[a-f0-9]{64}\/[a-f0-9]{64}-[a-f0-9]{64}\.html$/u.test(capture.source_snapshot)
      || !/^source-captures\/[a-f0-9]{64}\.json$/u.test(capture.capture_descriptor)) throw new Error("Hugo source capture needs reconciliation.");
  for (const [field, type] of [["source_id", "OpaqueId"], ["source_revision", "Revision"], ["source_article_url", "Url"], ["content_sha256", "Sha256"], ["content_bytes", "UInt"]]) validateCms(type, capture[field]);
  const { capture_descriptor, ...descriptor } = capture;
  if (capture_descriptor !== `source-captures/${sha(nativeSemanticJson(descriptor))}.json`) throw new Error("Hugo source capture identity changed.");
  return capture;
}
export async function preserveSourceCapture(privateRoot, source, bytes, sourceArticleUrl) {
  validateCms("Url", sourceArticleUrl);
  const sourceSnapshot = await preserveSourceSnapshot(privateRoot, source, bytes);
  const descriptor = { schema_version: "db-hugo-source-capture-1", source_id: source.source_id, source_revision: source.source_revision,
    source_article_url: sourceArticleUrl, content_sha256: source.content_sha256, content_bytes: source.content_bytes, source_snapshot: sourceSnapshot };
  const relative = `source-captures/${sha(nativeSemanticJson(descriptor))}.json`, capture = { ...descriptor, capture_descriptor: relative };
  validateSourceCapture(capture); await preserveImmutable(path.join(privateRoot, ...relative.split("/")), Buffer.from(nativeSemanticJson(descriptor) + "\n")); return capture;
}
export async function readSourceCapture(privateRoot, capture) {
  validateSourceCapture(capture); const { capture_descriptor, ...descriptor } = capture;
  const saved = await readRegular(path.join(privateRoot, ...capture_descriptor.split("/")));
  if (saved === null || !saved.equals(Buffer.from(nativeSemanticJson(descriptor) + "\n"))) throw new Error("Hugo captured source URL/descriptor changed.");
  const bytes = await readRegular(path.join(privateRoot, ...capture.source_snapshot.split("/")));
  if (bytes === null || bytes.length !== capture.content_bytes || sha(bytes) !== capture.content_sha256) throw new Error("Hugo captured native original changed.");
  return bytes;
}
export async function inspectPreservedSource(privateRoot, issue, renderer) {
  const relative = issue.source_snapshot;
  if (typeof relative !== "string" || !/^source-snapshots\/[a-f0-9]{64}\/[a-f0-9]{64}-[a-f0-9]{64}\.html$/u.test(relative)) throw new Error("Hugo pinned limitation source path needs reconciliation.");
  const bytes = await readRegular(path.join(privateRoot, ...relative.split("/")));
  if (bytes === null || bytes.length !== issue.source.content_bytes || sha(bytes) !== issue.source.content_sha256) throw new Error("Hugo pinned limitation source is unavailable or changed.");
  if (issue.source_capture !== undefined) await readSourceCapture(privateRoot, issue.source_capture);
  return prepareNativeSource(new TextDecoder("utf-8", { fatal: true }).decode(bytes), renderer, issue.source_capture?.source_article_url ?? issue.source.topic_url);
}
