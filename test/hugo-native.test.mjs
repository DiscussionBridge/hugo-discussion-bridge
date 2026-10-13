import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { prepare, syncNativePublications } from "../src/adapter.mjs";

const execute = promisify(execFile);
const componentRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureBase = path.join(componentRoot, ".tmp", "native-hugo-tests");
const forum = "https://forum.example";
const site = "https://hugo.example";
const resource = "11111111-1111-4111-8111-111111111111";
const config = { serverUrl: forum, connectionId: "dbc_0123456789abcdef01234567", connectionSecret: "s".repeat(48), nativeShortcode: "discussionbridge" };

async function installedFixture(context, { richContent = false } = {}) {
  try { await execute("hugo", ["version"]); }
  catch (error) {
    if (error.code === "ENOENT") { context.skip("Native Hugo executable is required for package integration qualification"); return; }
    throw error;
  }
  await mkdir(fixtureBase, { recursive: true });
  const root = await mkdtemp(path.join(fixtureBase, "installed-"));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(fixtureBase));
  context.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(fixtureBase));
    await rm(root, { recursive: true, force: true });
  });
  const artifactDirectory = path.join(root, "artifact");
  const installed = path.join(root, "node_modules", "hugo-discussion-bridge");
  for (const directory of [artifactDirectory, installed, path.join(root, "content"), path.join(root, "data"), path.join(root, "layouts"), path.join(root, "static")]) await mkdir(directory, { recursive: true });
  const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  await access(npmCli);
  const packed = await execute(process.execPath, [npmCli, "pack", "--json", "--ignore-scripts", "--offline", "--cache", path.join(root, "npm-cache"), "--pack-destination", artifactDirectory], { cwd: componentRoot, maxBuffer: 2 * 1024 * 1024 });
  const inventory = JSON.parse(packed.stdout)[0];
  assert.equal(inventory.files.some(({ path: name }) => /^(?:test\/|test-support\/|\.tmp\/|src\/protocol-v2\/)/u.test(name)), false);
  for (const name of ["layouts/shortcodes/discussionbridge.html", "layouts/index.discussionbridge.json", "layouts/partials/discussionbridge-credit.html", "dist/discussionbridge-simple.js", "dist/discussionbridge-rich-content.js", "npm-shrinkwrap.json"]) assert.equal(inventory.files.some((entry) => entry.path === name), true, name);
  // This proves installed artifact layouts/assets and native Hugo behavior.
  // Dependency installation is a separate gate requiring registry metadata;
  // the local offline cache cannot currently qualify a cold npm installation.
  await execute("tar", ["-xf", path.join(artifactDirectory, inventory.filename), "-C", installed, "--strip-components=1"]);
  let mounts = await readFile(path.join(installed, "docs", "hugo-mounts.toml.example"), "utf8");
  if (richContent) {
    mounts = mounts.replace("discussionbridge_rich_content = false", "discussionbridge_rich_content = true");
    mounts += `\n${await readFile(path.join(installed, "docs", "hugo-rich-content.toml.example"), "utf8")}`;
  }
  await writeFile(path.join(root, "hugo.toml"), `baseURL = '${site}/'\ndisableKinds = ['taxonomy', 'term', 'rss', 'sitemap']\n${mounts}`);
  // This ordinary page layout knows nothing about DiscussionBridge. The packed
  // shortcode, partial, manifest and static assets resolve through npm mounts.
  await writeFile(path.join(root, "layouts", "page.html"), "<!doctype html><html><head><title>{{ .Title }}</title></head><body>{{ .Content }}</body></html>");
  await writeFile(path.join(root, "layouts", "home.html"), "<!doctype html><html><body>Home</body></html>");
  return { root, installed, build: (options = []) => execute("hugo", ["--source", root, "--cacheDir", path.join(root, "hugo-cache"), ...options], { maxBuffer: 2 * 1024 * 1024 }) };
}

test("packed Hugo templates and assets build native Simple, Full, Interactive and authorized source publication", async (context) => {
  const fixture = await installedFixture(context, { richContent: true });
  if (!fixture) return;
  const { root, installed, build } = fixture;
  for (const [key, mode, topic, presentation] of [["simple", "simple", 42, "simple"], ["full", "full", 43, "full"], ["interactive", "to_discourse", undefined, "interactive"]]) {
    await writeFile(path.join(root, "content", `${key}.md`), `+++\ntitle = '${key}'\ndiscussionbridge_mode = '${mode}'\n${topic ? `discussionbridge_topic_id = ${topic}\n` : ""}+++\n\nLocal article.\n\n{{< discussionbridge mode="${presentation}" >}}\n`);
  }
  const source = {
    resource_id: resource, direction: "from_discourse", state: "healthy", title: "Imported source",
    topic_id: 53, topic_url: `${forum}/t/imported/53`,
    content_html: "<h2>Native source body</h2><p>Retained source content.</p><script>unsafe()</script>",
    source: { platform: "discourse", origin: forum, topic_id: 53, post_id: 149, post_number: 1, post_version: 1, revision: "post:149:version:1", updated_at: "2026-10-12T00:00:00Z", author: { name: "Source Editor", profile_url: `${forum}/u/editor` } },
    bindings: [{ role: "presentation", state: "active", canonical_url: `${site}/discussionbridge/imported/`, native_materialization: true }],
  };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (address, options) => {
    const url = new URL(address);
    assert.equal(url.origin, forum);
    if (url.pathname === "/discussion-bridge/v1/bridge-records.json") return json({ bridge_records: [source], pagination: { page: 1, pages: 1, total: 1, snapshot: "one" } });
    if (url.pathname === `/discussion-bridge/v1/bridge-records/${resource}.json`) return json({ bridge_record: source });
    if (url.pathname === "/discussion-bridge/v1/bridge-records/resolve.json") {
      assert.equal(options.method, "POST");
      return json({ outcome: "created", core_fallback: false, direction: "to_discourse", resource_id: "22222222-2222-4222-8222-222222222222", topic_id: 51, topic_url: `${forum}/t/local/51` }, 201);
    }
    if (url.pathname === "/t/42.json") return json({ slug: "simple", post_stream: { stream: [420, 421], posts: [{ id: 420, post_number: 1, topic_id: 42, username: "author", created_at: "2026-10-12T00:00:00Z", cooked: "<p>First post</p>" }, { id: 421, post_number: 2, topic_id: 42, username: "reader", created_at: "2026-10-12T01:00:00Z", cooked: "<p>Snapshot reply</p>" }] } });
    if (url.pathname === "/") return new Response(`<script id="data-preloaded">${JSON.stringify({ siteSettings: JSON.stringify({ enable_powered_by_discourse: false }) })}</script>`, { headers: { "content-type": "text/html" } });
    throw new Error(`Unexpected fixture endpoint: ${url.pathname}`);
  };
  assert.equal((await syncNativePublications({ contentDir: path.join(root, "content"), siteUrl: site, config: { ...config }, fetchImpl })).created, 1);
  await build(["--renderSegments", "discussionbridge-manifest"]);
  const manifestPath = path.join(root, "public", "discussionbridge-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.deepEqual(manifest.pages.map((page) => page.key).sort(), ["full", "imported", "interactive", "simple"]);
  const result = await prepare({ manifestPath, outputPath: path.join(root, "data", "discussionbridge.json"), statePath: path.join(root, ".discussionbridge", "state.json"), config: { ...config }, fetchImpl });
  assert.equal(result.records, 3);
  await build();
  const simple = await readFile(path.join(root, "public", "simple", "index.html"), "utf8");
  const full = await readFile(path.join(root, "public", "full", "index.html"), "utf8");
  const interactive = await readFile(path.join(root, "public", "interactive", "index.html"), "utf8");
  const imported = await readFile(path.join(root, "public", "discussionbridge", "imported", "index.html"), "utf8");
  assert.match(simple, /data-discussionbridge-simple-live/u);
  assert.match(simple, /Snapshot reply/u);
  assert.match(simple, /src="\/discussionbridge\/simple\.js"/u);
  assert.match(full, /topicId:\s*43/u);
  assert.doesNotMatch(full, /fullApp:/u);
  assert.match(interactive, /topicId:\s*51/u);
  assert.match(interactive, /fullApp:\s*true/u);
  assert.doesNotMatch(interactive, /discussion-bridge-source-presentation/u);
  assert.match(imported, /topicId:\s*53/u);
  assert.match(imported, /className:\s*"discussion-bridge-source-presentation"/u);
  assert.equal(imported.split("Native source body").length - 1, 1);
  assert.match(imported, /Source Editor/u);
  assert.doesNotMatch(imported, /unsafe\(\)/u);
  for (const html of [simple, full, interactive, imported]) {
    assert.match(html, /class="discussionbridge-presentation"/u);
    assert.match(html, /Connected by/u);
    assert.match(html, /src="\/discussionbridge\/rich-content\.js"/u);
    assert.doesNotMatch(html, new RegExp(config.connectionSecret, "u"));
  }
  for (const [bundle, target] of [["discussionbridge-simple.js", "simple.js"], ["discussionbridge-rich-content.js", "rich-content.js"]]) assert.deepEqual(await readFile(path.join(root, "public", "discussionbridge", target)), await readFile(path.join(installed, "dist", bundle)));
  await assert.rejects(access(path.join(root, "layouts", "shortcodes", "discussionbridge.html")), { code: "ENOENT" });
});

test("operator-selected templates, missing handlers, rich opt-out and native mode validation stay explicit", async (context) => {
  const fixture = await installedFixture(context);
  if (!fixture) return;
  const page = path.join(fixture.root, "content", "fallback.md");
  const configPath = path.join(fixture.root, "hugo.toml");
  const selectedConfig = await readFile(configPath, "utf8");
  await writeFile(configPath, `baseURL = '${site}/'\ndisableKinds = ['taxonomy', 'term', 'rss', 'sitemap']\n`);
  await writeFile(page, '+++\ntitle = "Opt out"\n+++\n\nOperator content.\n');
  await fixture.build();
  const optOut = await readFile(path.join(fixture.root, "public", "fallback", "index.html"), "utf8");
  assert.match(optOut, /Operator content/u);
  assert.doesNotMatch(optOut, /discussionbridge-presentation|discussionbridge\/.*\.js/u);
  await assert.rejects(access(path.join(fixture.root, "public", "discussionbridge", "simple.js")), { code: "ENOENT" });
  await writeFile(page, '+++\ntitle = "Needs handler"\n+++\n\n{{< discussionbridge mode="from_discourse" >}}\n');
  await assert.rejects(fixture.build(), (error) => /shortcode.*discussionbridge|discussionbridge.*shortcode/u.test(`${error.stdout}${error.stderr}`));
  await writeFile(configPath, selectedConfig);
  await writeFile(page, '+++\ntitle = "Fallback"\n+++\n\n{{< discussionbridge mode="simple" >}}\n');
  await fixture.build();
  const html = await readFile(path.join(fixture.root, "public", "fallback", "index.html"), "utf8");
  assert.match(html, /discourseEmbedUrl:/u);
  assert.doesNotMatch(html, /data-discussionbridge-simple-live/u);
  assert.doesNotMatch(html, /src="\/discussionbridge\/rich-content\.js"/u);
  await assert.rejects(access(path.join(fixture.root, "public", "discussionbridge", "rich-content.js")), { code: "ENOENT" });
  for (const mode of ["fullInteractive", "full_interactive", "unknown"]) {
    await writeFile(page, `+++\ntitle = "Rejected"\n+++\n\n{{< discussionbridge mode="${mode}" >}}\n`);
    await assert.rejects(fixture.build(), (error) => /DiscussionBridge mode .* is unsupported/u.test(`${error.stdout}${error.stderr}`));
  }
  const ownedHandler = path.join(fixture.root, "layouts", "shortcodes", "discussionbridge.html");
  await mkdir(path.dirname(ownedHandler), { recursive: true });
  const ownedTemplate = '<p class="operator-owned">Operator-selected presentation</p>';
  await writeFile(ownedHandler, ownedTemplate);
  await writeFile(page, '+++\ntitle = "Owned handler"\n+++\n\n{{< discussionbridge mode="from_discourse" >}}\n');
  await fixture.build();
  const owned = await readFile(path.join(fixture.root, "public", "fallback", "index.html"), "utf8");
  assert.match(owned, /Operator-selected presentation/u);
  assert.doesNotMatch(owned, /class="discussionbridge-presentation"/u);
  assert.equal(await readFile(ownedHandler, "utf8"), ownedTemplate);
});

test("no local native-handler selection or explicit decline creates no shortcode-dependent page or site integration", async (context) => {
  const fixture = await installedFixture(context);
  if (!fixture) return;
  await writeFile(path.join(fixture.root, "hugo.toml"), `baseURL = '${site}/'\ndisableKinds = ['taxonomy', 'term', 'rss', 'sitemap']\n`);
  await writeFile(path.join(fixture.root, "content", "ordinary.md"), '+++\ntitle = "Ordinary native page"\n+++\n\nOperator content without DiscussionBridge integration.\n');
  const record = { resource_id: resource, direction: "from_discourse", state: "healthy", topic_id: 53, topic_url: `${forum}/t/source/53`, title: "Unselected source", content_html: "<p>Source body</p>", source: { platform: "discourse", origin: forum, topic_id: 53, post_id: 149, post_number: 1, post_version: 1, revision: "post:149:version:1", updated_at: "2026-10-12T00:00:00Z", author: { name: "Source Editor", profile_url: `${forum}/u/editor` } }, bindings: [{ role: "presentation", state: "active", native_materialization: true, canonical_url: `${site}/discussionbridge/unselected/` }] };
  for (const choice of [undefined, "none"]) {
    const result = await syncNativePublications({ contentDir: path.join(fixture.root, "content"), siteUrl: site, config: { ...config, nativeShortcode: choice }, fetchImpl: async () => new Response(JSON.stringify({ bridge_records: [record], pagination: { page: 1, pages: 1, total: 1, snapshot: "one" } }), { headers: { "content-type": "application/json" } }) });
    assert.equal(result.created, 0); assert.equal(result.failed, 0); assert.equal(result.not_selected, 1);
    await assert.rejects(access(path.join(fixture.root, "content", "discussionbridge")), { code: "ENOENT" });
    await fixture.build(["--cleanDestinationDir"]);
    const html = await readFile(path.join(fixture.root, "public", "ordinary", "index.html"), "utf8");
    assert.match(html, /Operator content without DiscussionBridge integration/u); assert.doesNotMatch(html, /discussionbridge-presentation|discussionbridge\/.*\.js/u);
    await assert.rejects(access(path.join(fixture.root, "public", "discussionbridge")), { code: "ENOENT" });
  }
});

test("preview builds never admit draft, future or expired native pages into publication", async (context) => {
  const fixture = await installedFixture(context);
  if (!fixture) return;
  for (const [key, fields] of [["eligible", ""], ["draft", "draft = true\n"], ["future", 'publishDate = "2099-01-01T00:00:00Z"\n'], ["expired", 'expiryDate = "2000-01-01T00:00:00Z"\n']]) {
    await writeFile(path.join(fixture.root, "content", `${key}.md`), `+++\ntitle = "${key}"\ndiscussionbridge_mode = "to_discourse"\n${fields}+++\n\nNative ${key} content.\n`);
  }
  await fixture.build(["--buildDrafts", "--buildFuture", "--buildExpired", "--renderSegments", "discussionbridge-manifest"]);
  const manifestPath = path.join(fixture.root, "public", "discussionbridge-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.deepEqual(manifest.pages.map(({ key }) => key), ["eligible"]);
  const delivered = [];
  await prepare({ manifestPath, outputPath: path.join(fixture.root, "data", "discussionbridge.json"), statePath: path.join(fixture.root, ".discussionbridge", "state.json"), config: { ...config }, fetchImpl: async (_url, options) => {
    delivered.push(JSON.parse(options.body).bridge_record);
    return new Response(JSON.stringify({ outcome: "created", core_fallback: false, direction: "to_discourse", resource_id: resource, topic_id: 53, topic_url: `${forum}/t/eligible/53` }), { status: 201, headers: { "content-type": "application/json" } });
  } });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].title, "eligible");
});

test("installed source modes, continuing metadata and withdrawal rebuild preserve operator choices", async (context) => {
  const fixture = await installedFixture(context);
  if (!fixture) return;
  let sources = ["simple", "full", "interactive"].map((mode, index) => ({
    resource_id: `${index + 1}1111111-1111-4111-8111-111111111111`, direction: "from_discourse", state: "healthy", title: `Source ${mode}`,
    topic_id: 60 + index, topic_url: `${forum}/t/${mode}/${60 + index}`, content_html: `<h2>Native body ${mode}</h2><table><tr><th>Heading</th></tr><tr><td>Table value</td></tr></table><pre><code class="language-mermaid">graph TD; A--&gt;B;</code></pre>`,
    source: { platform: "discourse", origin: forum, topic_id: 60 + index, post_id: 200 + index, post_number: 1, post_version: 1, revision: `post:${200 + index}:version:1`, edition: String(index + 1).repeat(64), created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-12T00:00:00Z", forum_name: "Selected Source Forum", author: { name: "Source Editor", profile_url: `${forum}/u/editor` } },
    bindings: [{ role: "presentation", state: "active", canonical_url: `${site}/discussionbridge/${mode}/`, native_materialization: true, presentation_mode: mode }],
  }));
  const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const fetchImpl = async (address) => {
    const url = new URL(address);
    if (url.pathname === "/discussion-bridge/v1/bridge-records.json") return json({ bridge_records: sources, pagination: { page: 1, pages: 1, total: sources.length, snapshot: "one" } });
    if (url.pathname.startsWith("/discussion-bridge/v1/bridge-records/")) return json({ bridge_record: sources.find((source) => url.pathname.includes(source.resource_id)) });
    if (url.pathname === "/t/60.json") return json({ slug: "simple", post_stream: { stream: [200, 201], posts: [{ id: 200, post_number: 1 }, { id: 201, post_number: 2, username: "reader", created_at: "2026-10-12T01:00:00Z", cooked: "<p>Source reply snapshot</p>" }] } });
    if (url.pathname === "/") return new Response(`<script id="data-preloaded">${JSON.stringify({ siteSettings: JSON.stringify({ enable_powered_by_discourse: false }) })}</script>`, { headers: { "content-type": "text/html" } });
    throw new Error(`Unexpected source fixture endpoint ${url.pathname}`);
  };
  const sync = () => syncNativePublications({ contentDir: path.join(fixture.root, "content"), siteUrl: site, config: { ...config }, fetchImpl });
  const manifestPath = path.join(fixture.root, "public", "discussionbridge-manifest.json");
  const prepareSite = async () => {
    await fixture.build(["--renderSegments", "discussionbridge-manifest"]);
    await prepare({ manifestPath, outputPath: path.join(fixture.root, "data", "discussionbridge.json"), statePath: path.join(fixture.root, ".discussionbridge", "state.json"), config: { ...config }, fetchImpl });
    // Removal of withdrawn pages from deployment output is an explicit build
    // choice. A normal Hugo build alone does not remove old destination files.
    await fixture.build(["--cleanDestinationDir"]);
  };
  assert.equal((await sync()).created, 3); await prepareSite();
  for (const mode of ["simple", "full", "interactive"]) {
    const html = await readFile(path.join(fixture.root, "public", "discussionbridge", mode, "index.html"), "utf8");
    assert.equal(html.split(`Native body ${mode}`).length - 1, 1);
    assert.match(html, /Selected Source Forum/u); assert.match(html, /Table value/u); assert.match(html, /language-mermaid/u);
    assert.doesNotMatch(html, /rich-content\.js/u);
    if (mode === "simple") { assert.match(html, /Source reply snapshot/u); assert.match(html, /data-discussionbridge-simple-live/u); assert.doesNotMatch(html, /fullApp:/u); }
    if (mode === "full") { assert.match(html, /topicId:\s*61/u); assert.doesNotMatch(html, /fullApp:/u); }
    if (mode === "interactive") assert.match(html, /fullApp:\s*true[\s\S]*discussion-bridge-source-presentation/u);
  }
  const file = path.join(fixture.root, "content", "discussionbridge", "full.md");
  const chosen = (await readFile(file, "utf8")).replace('discussionbridge_presentation_mode = "full"', 'discussionbridge_presentation_mode = "interactive"') + "\nOperator-owned body.\n";
  await writeFile(file, chosen);
  sources[1].title = "Source renamed"; sources[1].topic_url = `${forum}/t/renamed/61`; sources[1].source.edition = "a".repeat(64); sources[1].source.updated_at = "2026-10-12T02:00:00Z";
  assert.equal((await sync()).updated, 1); await prepareSite();
  const changed = await readFile(path.join(fixture.root, "public", "discussionbridge", "full", "index.html"), "utf8");
  assert.match(changed, /<title>Source renamed<\/title>/u); assert.match(changed, /fullApp:\s*true/u); assert.match(changed, /Operator-owned body/u);
  const active = structuredClone(sources[1]);
  sources[1] = { ...sources[1], title: "Source publication withdrawn", content_html: null, source: { status: "withdrawn", reason: "source_unavailable", edition: "d".repeat(64) } };
  assert.equal((await sync()).withdrawn, 1);
  await prepareSite();
  await assert.rejects(access(path.join(fixture.root, "public", "discussionbridge", "full", "index.html")), { code: "ENOENT" });
  const data = await readFile(path.join(fixture.root, "data", "discussionbridge.json"), "utf8"); assert.doesNotMatch(data, /Native body full/u);
  await fixture.build(["--buildDrafts"]);
  const preview = await readFile(path.join(fixture.root, "public", "discussionbridge", "full", "index.html"), "utf8");
  assert.match(preview, /Source publication withdrawn/u); assert.doesNotMatch(preview, /Native body full|fullApp:/u);
  sources[1] = active; sources[1].source.edition = "e".repeat(64);
  assert.equal((await sync()).updated, 1); await prepareSite();
  const restored = await readFile(path.join(fixture.root, "public", "discussionbridge", "full", "index.html"), "utf8");
  assert.match(restored, /Native body full/u); assert.match(restored, /fullApp:\s*true/u); assert.match(restored, /Operator-owned body/u);
});
