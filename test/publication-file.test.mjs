import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { writeNativePublication } from "../src/publication-file.mjs";

const root = fileURLToPath(new URL("../.tmp/publication-file-tests/", import.meta.url));
const item = { resourceId: "11111111-1111-4111-8111-111111111111", topicId: 53, revision: "post:149:version:2" };
const generated = `+++\ntitle = "Source title"\ndiscussionbridge_native_publication = true\ndiscussionbridge_resource_id = "${item.resourceId}"\ndiscussionbridge_topic_id = 53\ndiscussionbridge_source_revision = "${item.revision}"\n+++\n\n{{< discussionbridge mode="from_discourse" >}}\n`;
async function fixture(context) {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, "owned-"));
  context.after(async () => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(root)); await rm(dir, { recursive: true, force: true }); });
  return path.join(dir, "publication.md");
}

test("existing empty, body-only markers and mismatched native identity never confer ownership", async (context) => {
  const file = await fixture(context);
  for (const prior of ["", `Operator body\ndiscussionbridge_resource_id = "${item.resourceId}"`, generated.replace("native_publication = true", "native_publication = false"), generated.replace("topic_id = 53", "topic_id = 999")]) {
    await writeFile(file, prior);
    await assert.rejects(writeNativePublication(file, generated, item), /front matter|identity collision/u);
    assert.equal(await readFile(file, "utf8"), prior);
  }
});

test("source revisions preserve native properties, selected modes, rich choice and complete body bytes", async (context) => {
  const file = await fixture(context);
  const prior = generated.replace(item.revision, "post:149:version:1").replace('title = "Source title"', 'title = "Operator title"\ndate = "2026-01-01"\ndiscussionbridge_mode = "full"\ndiscussionbridge_rich_content = true\ncustom_property = "unchanged"').replace('"post:149:version:1"', '"post:149:version:1" # retain this comment') + "\nOperator-owned body.\n";
  await writeFile(file, prior);
  assert.equal(await writeNativePublication(file, generated, item), "updated");
  assert.equal(await readFile(file, "utf8"), prior.replace("post:149:version:1", item.revision));
  assert.equal(await writeNativePublication(file, generated, item), "unchanged");
});

test("ownership-like assignments inside multiline operator text are not used or rewritten", async (context) => {
  const file = await fixture(context);
  const prior = generated.replace(item.revision, "post:149:version:1").replace('title = "Source title"', `notes = """\ndiscussionbridge_source_revision = "operator text"\n"""\ntitle = "Source title"`);
  await writeFile(file, prior);
  assert.equal(await writeNativePublication(file, generated, item), "updated");
  assert.equal(await readFile(file, "utf8"), prior.replace("post:149:version:1", item.revision));
});

test("concurrent first claims cannot replace the winning publication", async (context) => {
  const file = await fixture(context);
  const attempts = await Promise.allSettled([writeNativePublication(file, generated, item), writeNativePublication(file, generated.replace("Source title", "Other title"), item)]);
  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
  assert.match(await readFile(file, "utf8"), /title = "(?:Source|Other) title"/u);
});
