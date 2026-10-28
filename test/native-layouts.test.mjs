import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
async function write(root, relative, value) { const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, value); }
async function runHugo(root, args) {
  const child = spawn("hugo", ["--source", root, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
  let output = "", failed = false;
  child.stdout.on("data", (chunk) => { output += chunk.toString(); }); child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  child.once("error", () => { failed = true; });
  const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, 60000);
  try { const code = await new Promise((resolve) => child.once("close", resolve)); assert.equal(failed ? -1 : code, 0, output); }
  finally { clearTimeout(timer); }
}

test("native publication and private all-content census use separate output surfaces", async () => {
  const fixtureRoot = path.join(repository, ".tmp"); const root = path.join(fixtureRoot, `layouts-${randomUUID()}`);
  try {
    await write(root, "hugo.toml", `baseURL="https://native.example/"\n[outputs]\nhome=["HTML","DiscussionBridge"]\n[outputFormats.DiscussionBridge]\nmediaType="application/json"\nbaseName="discussionbridge-manifest"\nisPlainText=true\n[outputFormats.DiscussionBridgeSourceLifecycle]\nmediaType="application/json"\nbaseName="discussionbridge-source-lifecycle"\nisPlainText=true\n[params]\ndiscussionbridge_forum_origin="https://forum.example"\n`);
    await write(root, "layouts/index.html", '{{ range site.RegularPages }}<a href="{{ .RelPermalink }}">{{ .Title }}</a>{{ end }}');
    await write(root, "layouts/_default/single.html", '<html><body>{{ .Content }}</body></html>');
    for (const relative of ["index.discussionbridge.json", "index.discussionbridgesourcelifecycle.json", "shortcodes/discussionbridge.html", "partials/discussionbridge-credit.html"]) {
      await mkdir(path.dirname(path.join(root, "layouts", relative)), { recursive: true }); await copyFile(path.join(repository, "layouts", relative), path.join(root, "layouts", relative));
    }
    await write(root, "content/visible.md", '+++\ntitle="Visible"\ndate=2026-09-01T10:00:00Z\nlastmod=2026-09-02T11:00:00Z\ndiscussionbridge_mode="to_discourse"\n+++\nActual source é 😀\n');
    await write(root, "content/draft.md", '+++\ntitle="Private draft"\ndraft=true\ndiscussionbridge_mode="to_discourse"\n+++\nSecret draft\n');
    await write(root, "content/future.md", '+++\ntitle="Future"\npublishDate=2030-01-01T00:00:00Z\ndiscussionbridge_mode="to_discourse"\n+++\nFuture body\n');
    await write(root, "content/expired.md", '+++\ntitle="Expired"\nexpiryDate=2020-01-01T00:00:00Z\ndiscussionbridge_mode="to_discourse"\n+++\nExpired body\n');
    await write(root, "content/received.md", '+++\ntitle="Received"\ndiscussionbridge_mode="from_discourse"\ndiscussionbridge_native_publication=true\n+++\nReceived owned source\n');
    await write(root, "content/simple.md", '+++\ntitle="Simple"\n+++\n{{< discussionbridge mode="simple" >}}\n');
    await write(root, "content/full.md", '+++\ntitle="Full"\ndiscussionbridge_topic_id=123\n+++\n{{< discussionbridge mode="full" >}}\n');
    await write(root, "content/interactive.md", '+++\ntitle="Interactive"\n+++\n{{< discussionbridge mode="interactive" >}}\n');
    await write(root, "data/discussionbridge.json", JSON.stringify({ interactive: { forum_origin: "https://forum.example", topic_id: "123", topic_url: "https://forum.example/t/123" } }));
    await runHugo(root, ["--destination", path.join(root, "ordinary-public")]);
    const ordinary = path.join(root, "ordinary-public"); const manifestBytes = await readFile(path.join(ordinary, "discussionbridge-manifest.json"));
    const manifest = JSON.parse(manifestBytes); assert.deepEqual(manifest.pages.map((page) => page.key), ["visible"]);
    assert.equal(manifest.pages[0].native_source_created_at, "2026-09-01T10:00:00.000Z");
    assert.equal(manifest.pages[0].native_source_updated_at, "2026-09-02T11:00:00.000Z");
    assert.ok(!Object.hasOwn(manifest.pages[0], "source_edition"));
    const publicFiles = await readdir(ordinary); assert.ok(!publicFiles.includes("draft") && !publicFiles.includes("future") && !publicFiles.includes("expired"));
    assert.ok(!publicFiles.includes("discussionbridge-source-lifecycle.json"));
    const missingSimple = await readFile(path.join(ordinary, "simple/index.html"), "utf8");
    assert.match(missingSimple, /data-discussionbridge-mode="simple"/u);
    assert.match(missingSimple, /class="discussionbridge-unavailable" role="status"/u);
    assert.doesNotMatch(missingSimple, /DiscourseEmbed|javascripts\/embed\.js|id="discourse-comments"/u);
    const full = await readFile(path.join(ordinary, "full/index.html"), "utf8");
    assert.match(full, /topicId:\s+123\b/u);
    assert.match(full, /javascripts\/embed\.js/u);
    assert.doesNotMatch(full, /fullApp/u);
    assert.match(await readFile(path.join(ordinary, "interactive/index.html"), "utf8"), /fullApp: true/);
    await write(root, "data/discussionbridge.json", JSON.stringify({
      simple: { forum_origin: "https://forum.example", topic_id: "123", topic_url: "https://forum.example/t/123", simple_html: "<p>Prepared Simple reply</p>" },
      interactive: { forum_origin: "https://forum.example", topic_id: "123", topic_url: "https://forum.example/t/123" },
    }));
    const prepared = path.join(root, "prepared-public");
    await runHugo(root, ["--destination", prepared]);
    const preparedSimple = await readFile(path.join(prepared, "simple/index.html"), "utf8");
    assert.match(preparedSimple, /data-discussionbridge-simple-live/u);
    assert.match(preparedSimple, /Prepared Simple reply/u);
    assert.match(preparedSimple, /discussionbridge\/simple\.js/u);
    assert.doesNotMatch(preparedSimple, /DiscourseEmbed|javascripts\/embed\.js|id="discourse-comments"|discussionbridge-unavailable/u);
    await write(root, "private-capture.toml", '[outputs]\nhome=["DiscussionBridgeSourceLifecycle"]\npage=[]\nsection=[]\ntaxonomy=[]\nterm=[]\n[segments.discussionbridge-source-lifecycle]\n[[segments.discussionbridge-source-lifecycle.includes]]\noutput="DiscussionBridgeSourceLifecycle"\n');
    const privateRoot = path.join(root, "private-census");
    await runHugo(root, ["--config", "hugo.toml,private-capture.toml", "--renderSegments", "discussionbridge-source-lifecycle", "--buildDrafts", "--buildFuture", "--buildExpired", "--destination", privateRoot]);
    const census = JSON.parse(await readFile(path.join(privateRoot, "discussionbridge-source-lifecycle.json")));
    assert.equal(census.sources.length, 8);
    for (const name of ["draft", "future", "expired"]) { const row = census.sources.find((source) => source.key === name); assert.equal(row.published, false); assert.equal(row.to_opted_in, true); assert.match(row.source_sha256, /^[a-f0-9]{64}$/u); }
    assert.deepEqual(await readdir(privateRoot), ["discussionbridge-source-lifecycle.json"]);
    assert.deepEqual(await readFile(path.join(ordinary, "discussionbridge-manifest.json")), manifestBytes);
  } finally {
    const relative = path.relative(fixtureRoot, root); assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  }
});
