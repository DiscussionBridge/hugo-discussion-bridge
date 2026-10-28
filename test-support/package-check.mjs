import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = fileURLToPath(new URL("..", import.meta.url));
const [packageRoot, archive, report] = process.argv.slice(2).map((value) => path.resolve(value));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const entries = [];
async function walk(relative = "") {
  for (const name of await readdir(path.join(packageRoot, relative))) {
    const child = path.join(relative, name), stat = await lstat(path.join(packageRoot, child)); assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) { assert.equal(["node_modules", "test", "test-support", ".git", ".tmp", ".artifacts"].includes(name), false); await walk(child); }
    else {
      assert.equal(stat.isFile(), true); const bytes = await readFile(path.join(packageRoot, child));
      assert.deepEqual(bytes, await readFile(path.join(source, child)), `Packaged source differs: ${child}`);
      entries.push({ path: child.split(path.sep).join("/"), bytes: bytes.length, sha256: sha(bytes) });
    }
  }
}
await walk(); entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
assert.equal(entries.length, 40); assert.ok(entries.some((entry) => entry.path === "src/cli.mjs"));
for (const [name, bytes, digest] of [
  ["cms-schema.json", 92721, "a737ffb6d58dd36d0eb3148e86f32c5c0d3a2b2873e1951e211362d40f0a18a1"],
  ["cms-runtime.mjs", 30268, "36835d22431595ed14b2bd8c4883875faf36240e912bbe5be3ef82249e5b04ae"]]) {
  const entry = entries.find((entry) => entry.path === `src/protocol-v4/${name}`); assert.equal(entry.bytes, bytes); assert.equal(entry.sha256, digest);
}
const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"))); assert.equal(pkg.version, "0.4.0-alpha.1"); assert.equal(pkg.bin["discussionbridge-hugo"], "src/cli.mjs");
const { runCli } = await import(pathToFileURL(path.join(packageRoot, "src", "cli.mjs")));
let stdout = "", stderr = ""; const io = { stdout: { write: (value) => { stdout += value; } }, stderr: { write: (value) => { stderr += value; } } };
assert.equal(await runCli(["version"], io), 0); assert.deepEqual(JSON.parse(stdout), { version: "0.4.0-alpha.1", wire_version: "v4", candidate_id: "discussionbridge-v4-core-20261014-r1", release_version: null });
assert.equal(stderr, "");
const bytes = await readFile(archive), result = { archive: { path: archive, bytes: bytes.length, sha256: sha(bytes) },
  package_entries: entries.length, packaged_source_tree_sha256: sha(JSON.stringify(entries)), entries,
  checks: { unchanged_packaged_bytes: true, private_pair_pins: true, current_cli_tuple: true, excluded_tool_cache_reports: true } };
await writeFile(report, JSON.stringify(result, null, 2) + "\n");
process.stdout.write(JSON.stringify({ ...result, entries: undefined }) + "\n");
