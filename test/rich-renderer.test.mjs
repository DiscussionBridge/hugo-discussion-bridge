import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the maintained selected renderer preserves diagrams and renders cooked, block and inline mathematics", async () => {
  const source = await readFile(new URL("../src/browser-rich-content.mjs", import.meta.url), "utf8");
  assert.deepEqual([...source.matchAll(/^import .*? from "([^"]+)";/gmu)].map((match) => match[1]), ["mermaid", "katex", "katex/dist/katex.min.css"]);
  const math = { tagName: "DIV", textContent: "x^2", querySelector: () => null };
  const paragraph = { textContent: "[math]y^2[/math]", replaceChildren() { this.textContent = ""; } };
  const inline = { textContent: "Before $z^2$ after", parentElement: { closest: () => null }, replaceWith(fragment) { this.replacement = fragment; } };
  const skipped = { textContent: "$do_not_render$", parentElement: { closest: () => ({}) } };
  const diagram = { textContent: "graph TD; A-->B;", parentElement: { replaceWith(container) { this.replacement = container; } } };
  const calls = [], styles = [], diagrams = [];
  const root = { querySelectorAll(selector) { return selector === ".math" ? [math] : selector === "p" ? [paragraph] : [diagram]; } };
  const document = { readyState: "loading", head: { append(value) { styles.push(value); } }, addEventListener() {}, createElement(tag) { return { tagName: tag.toUpperCase() }; }, createDocumentFragment() { return { children: [], append(value) { this.children.push(value); } }; }, createTreeWalker() { const nodes = [inline, skipped]; let index = -1; return { nextNode() { index++; this.currentNode = nodes[index]; return index < nodes.length; } }; } };
  const mermaid = { initialize(options) { assert.equal(options.securityLevel, "strict"); }, async run(options) { diagrams.push(...options.nodes); } };
  const katex = { render(expression, element, options) { calls.push({ expression, element, options }); } };
  const executable = source.replace(/^import .*?;\r?\n/gmu, "").replace(/^export .*?;\r?$/gmu, "");
  const render = new Function("mermaid", "katex", "mathStyles", "document", "NodeFilter", `${executable}; return render;`)(mermaid, katex, ".katex{font-family:KaTeX_Main}", document, { SHOW_TEXT: 4 });
  await render(root);
  assert.deepEqual(calls.map(({ expression }) => expression), ["x^2", "y^2", "z^2"]); assert.equal(calls.every(({ options }) => options.trust === false), true);
  assert.equal(calls[0].options.displayMode, true); assert.equal(calls[1].options.displayMode, true);
  assert.equal(diagrams[0].textContent, "graph TD; A-->B;");
  assert.equal(inline.replacement.children[0], "Before "); assert.equal(inline.replacement.children[2], " after"); assert.match(styles[0].textContent, /KaTeX_Main/u);
  const bundle = await readFile(new URL("../dist/discussionbridge-rich-content.js", import.meta.url), "utf8"); assert.ok(/data:(?:font\/|application\/.*?font)/u.test(bundle), "selected math fonts are embedded"); assert.equal(/url\(["']?fonts\//u.test(bundle), false);
});
