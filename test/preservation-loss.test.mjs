import test from "node:test";
import assert from "node:assert/strict";
import { prepareNativeSource, prepareNativeToSource } from "../src/source-preparation.mjs";

const base = "https://source.example/articles/entry/";
const directions = {
  To: (html) => prepareNativeToSource(html, base),
  From: (html) => prepareNativeSource(html, undefined, base),
};
const lost = {
  pointer: '<p onpointerdown="SECRET_CALLBACK()">Choose</p>',
  wheel: '<p onwheel="SECRET_CALLBACK()">Zoom</p>',
  animation: '<p onanimationend="SECRET_CALLBACK()">Finish</p>',
  form: '<form action="https://source.example/search"><input name="q"><button>Search</button></form><p>Context</p>',
  srcdoc: '<iframe srcdoc="&lt;p&gt;SECRET_CONTENT&lt;/p&gt;"></iframe><p>Context</p>',
  stylesheet: '<style>.answer::before{content:"SECRET_CONTENT"}</style><p class="answer"> status</p>',
  inline_layout: '<p style="white-space:pre">A     B</p>',
  responsive_image: '<img src="base.png" srcset="required.png 2x" sizes="100vw" alt="Image">',
  vector: '<svg viewBox="0 0 10 10"><text x="1" y="5">SECRET_CONTENT</text></svg><p>Context</p>',
  canvas: '<canvas width="200" height="100">SECRET_CONTENT</canvas><p>Context</p>',
};

for (const [direction, prepare] of Object.entries(directions)) {
  for (const [name, input] of Object.entries(lost)) {
    test(`${direction} reports actual ${name} loss before claiming a prepared article`, () => {
      const result = prepare(input);
      assert.ok(result.losses.length > 0, `${name} was changed without a specific limitation`);
      assert.ok(result.losses.every((loss) => loss.tag && loss.removed_count > 0));
      assert.doesNotMatch(JSON.stringify(result.losses), /SECRET_CALLBACK|SECRET_CONTENT/);
    });
  }
  test(`${direction} retains native numbering and table semantics`, () => {
    const result = prepare('<ol start="5" reversed type="A"><li value="9">Nine</li></ol><table><tr><th colspan="2" scope="col">Header</th></tr></table>');
    assert.deepEqual(result.losses, []);
    assert.match(result.html, /<ol[^>]*start="5"/);
    assert.match(result.html, /<ol[^>]*reversed/);
    assert.match(result.html, /<ol[^>]*type="A"/);
    assert.match(result.html, /<li value="9">/);
    assert.match(result.html, /<th[^>]*colspan="2"/);
    assert.match(result.html, /<th[^>]*scope="col"/);
  });
  test(`${direction} keeps ordinary text, captured references and displayed code`, () => {
    const result = prepare('Plain 😀<a href="../reference">Reference</a><img src="/image.png" alt="Image"><pre><code>&lt;script&gt;shown()&lt;/script&gt;</code></pre><!-- onwheel="comment()" -->');
    assert.deepEqual(result.losses, []);
    assert.match(result.html, /href="https:\/\/source.example\/articles\/reference"/);
    assert.match(result.html, /src="https:\/\/source.example\/image.png"/);
    assert.match(result.html, /&lt;script&gt;shown\(\)&lt;\/script&gt;/);
  });
  test(`${direction} keeps the target of an explicit table header association`, () => {
    const result = prepare('<table><tr><th id="item" scope="col">Item</th><td headers="item">Value</td></tr></table>');
    assert.deepEqual(result.losses, []);
    assert.match(result.html, /<th[^>]*id="item"/);
    assert.match(result.html, /<td[^>]*headers="item"/);
  });
}

test("an actually faithful renderer is not refused by an admission blacklist", () => {
  for (const html of Object.values(lost)) {
    const absolute = html.replaceAll('src="base.png"', 'src="https://source.example/base.png"');
    assert.deepEqual(prepareNativeSource(absolute, (value) => value, base).losses, []);
  }
});

test("a known handler is still diagnosed without exposing its program", () => {
  const result = prepareNativeToSource('<p onclick="SECRET_CALLBACK()">Choose</p>', base);
  assert.ok(result.losses.some((loss) => loss.attribute === "onclick"));
  assert.doesNotMatch(JSON.stringify(result.losses), /SECRET_CALLBACK/);
});

const chroma = (body, extra = "") => `<div class="highlight"><pre style="color:#f8f8f2;background-color:#272822;tab-size:4;-webkit-text-size-adjust:none;${extra}"><code class="language-html" data-lang="html"><span style="display:flex;"><span style="color:#f92672">${body}</span></span></code></pre></div>`;
test("verified native Chroma decoration normalizes while exact displayed code and language remain", () => {
  const result = prepareNativeToSource(chroma('&lt;script&gt;shown()&lt;/script&gt;\n'), base);
  assert.deepEqual(result.losses, []);
  assert.match(result.html, /class="language-html"/);
  assert.match(result.html, /&lt;script&gt;shown\(\)&lt;\/script&gt;/);
});
test("native code normalization cannot hide additional CSS or a changed tab layout", () => {
  for (const html of [chroma('shown()', 'white-space:normal;'), chroma('A\tB')]) {
    assert.ok(prepareNativeToSource(html, base).losses.some((loss) => loss.kind === "native_inline_style_removed_or_changed"));
  }
});
test("code decoration equivalence requires unchanged displayed code and language", () => {
  const original = chroma('shown()');
  for (const replacement of ['<pre><code class="language-html">changed()</code></pre>', '<pre><code class="language-js">shown()</code></pre>']) {
    assert.ok(prepareNativeSource(original, () => replacement, base).losses.some((loss) => loss.kind === "native_inline_style_removed_or_changed"));
  }
});
