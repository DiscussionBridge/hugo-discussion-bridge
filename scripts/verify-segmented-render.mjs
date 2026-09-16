import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const requestedPages = Number.parseInt(process.argv[2] ?? "1000", 10);
if (!Number.isSafeInteger(requestedPages) || requestedPages < 1 || requestedPages > 10_000) {
  throw new Error("Page count must be an integer from 1 through 10000.");
}

const root = await mkdtemp(path.join(os.tmpdir(), "discussionbridge-hugo-segment-"));
try {
  await Promise.all([
    mkdir(path.join(root, "content"), { recursive: true }),
    mkdir(path.join(root, "layouts", "_default"), { recursive: true }),
  ]);
  await writeFile(path.join(root, "hugo.yaml"), configuration(), "utf8");
  await writeFile(path.join(root, "layouts", "index.html"), "{{ .Title }}\n", "utf8");
  await writeFile(path.join(root, "layouts", "_default", "single.html"), "{{ .Title }}\n{{ .Content }}\n", "utf8");
  await writeFile(path.join(root, "layouts", "index.discussionbridge.json"), manifestTemplate(), "utf8");

  const writes = [];
  for (let index = 1; index <= requestedPages; index += 1) {
    writes.push(writeFile(
      path.join(root, "content", `page-${index}.md`),
      `---\ntitle: Page ${index}\ndiscussionbridge_mode: simple\n---\n\nFixture content ${index}.\n`,
      "utf8",
    ));
  }
  await Promise.all(writes);

  const full = runHugo(root, ["--destination", "public-full"]);
  const segmented = runHugo(root, [
    "--destination",
    "public-segmented",
    "--renderSegments",
    "discussionbridge-manifest",
  ]);
  const fullFiles = await files(path.join(root, "public-full"));
  const segmentedFiles = await files(path.join(root, "public-segmented"));
  const fullHtml = fullFiles.filter((file) => file.endsWith(".html"));

  if (fullHtml.length !== requestedPages + 1) {
    throw new Error(`Full Hugo build emitted ${fullHtml.length} HTML files; expected ${requestedPages + 1}.`);
  }
  if (!fullFiles.includes("discussionbridge-manifest.json")) {
    throw new Error("Full Hugo build omitted discussionbridge-manifest.json.");
  }
  if (segmentedFiles.length !== 1 || segmentedFiles[0] !== "discussionbridge-manifest.json") {
    throw new Error(`Segmented manifest build emitted unexpected files: ${segmentedFiles.join(", ")}`);
  }

  process.stdout.write(`${JSON.stringify({
    pages: requestedPages,
    full: { elapsed_ms: full.elapsedMs, files: fullFiles.length, html_files: fullHtml.length },
    manifest_segment: { elapsed_ms: segmented.elapsedMs, files: segmentedFiles.length },
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

function runHugo(source, args) {
  const startedAt = performance.now();
  const result = spawnSync("hugo", ["--source", source, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Hugo failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return { elapsedMs: Math.round(performance.now() - startedAt) };
}

async function files(directory) {
  const found = [];
  async function visit(current, prefix = "") {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(current, entry.name), relative);
      else found.push(relative);
    }
  }
  await visit(directory);
  return found.sort();
}

function configuration() {
  return `baseURL: https://example.com/
title: DiscussionBridge Hugo performance fixture
disableKinds:
  - RSS
  - sitemap
  - taxonomy
  - term
mediaTypes:
  application/vnd.discussionbridge+json:
    suffixes:
      - json
outputFormats:
  discussionbridge:
    mediaType: application/vnd.discussionbridge+json
    baseName: discussionbridge-manifest
    isPlainText: true
    notAlternative: true
outputs:
  home:
    - html
    - discussionbridge
segments:
  discussionbridge-manifest:
    includes:
      - kind: home
        output: discussionbridge
`;
}

function manifestTemplate() {
  return `{{- $pages := slice -}}
{{- range site.RegularPages -}}
  {{- $current := . -}}
  {{- with $current.Params.discussionbridge_mode -}}
    {{- $pages = $pages | append (dict "key" $current.File.ContentBaseName "mode" . "canonical_url" $current.Permalink "title" $current.Title) -}}
  {{- end -}}
{{- end -}}
{{- dict "site_origin" site.BaseURL "pages" $pages | jsonify -}}
`;
}
