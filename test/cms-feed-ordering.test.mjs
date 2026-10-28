import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCmsClient } from "../src/cms-client.mjs";
import { withCmsContinuation } from "../src/cms-continuation.mjs";
import { cmsConfig, connection, json } from "../test-support/cms-fixture.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const uuid = index => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const event = (index, sequence, sourceId = "source-a") => ({
  event_type: "publication", event_id: uuid(index), event_sequence: sequence,
  source: { source_id: sourceId, source_revision: `revision-${sequence}`, topic_id: "53",
    topic_url: "https://forum.example/t/source/53", title: `Source ${sourceId}`,
    content_sha256: sha("x"), content_bytes: 1, source_created_at: null, source_updated_at: null, source_authors: [] },
});
const feed = (stream, items, checkpoint, next = null) => ({ stream, items, next_cursor: next, checkpoint_cursor: checkpoint });

async function fixture(t) {
  const parent = path.resolve(os.tmpdir()), prefix = "discussionbridge-hugo-feed-ordering-";
  const root = await mkdtemp(path.join(parent, prefix));
  const allocated = await lstat(root, { bigint: true });
  assert.ok(allocated.isDirectory() && !allocated.isSymbolicLink() && allocated.ino > 0n);
  t.after(async () => {
    const target = path.resolve(root);
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith(prefix));
    const current = await lstat(target, { bigint: true });
    assert.ok(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.dev, allocated.dev); assert.equal(current.ino, allocated.ino);
    await rm(target, { recursive: true, force: true });
  });
  const privateRoot = path.join(root, "private"), nativeRoot = path.join(root, "site"), publicRoot = path.join(root, "public");
  for (const directory of [privateRoot, nativeRoot, publicRoot]) await mkdir(directory);
  const pending = [];
  const client = createCmsClient(cmsConfig, { fetchImpl: async address => {
    const url = new URL(address);
    assert.equal(url.origin, cmsConfig.serverUrl);
    assert.equal(url.pathname, "/discussion-bridge/v4/sources.json");
    assert.ok(pending.length, "unexpected source request");
    const { value, cursor } = pending.shift();
    assert.equal(url.searchParams.get("stream"), value.stream);
    assert.equal(url.searchParams.get("cursor"), cursor);
    return json(value);
  } });
  return {
    async drain(value, cursor = null) {
      pending.push({ value, cursor });
      return withCmsContinuation({ privateRoot, nativeRoot, publicRoots: [publicRoot], client, connection: connection() },
        continuation => continuation.drainSources({ maximumPages: 1 }));
    },
    raw: () => readFile(path.join(privateRoot, "continuation.json"), "utf8"),
    state: async () => JSON.parse(await readFile(path.join(privateRoot, "continuation.json"), "utf8")),
    savedEvent: async index => JSON.parse(await readFile(path.join(privateRoot, "events", `${uuid(index)}.json`), "utf8")),
    current: async sourceId => JSON.parse(await readFile(path.join(privateRoot, "current", `${sha(sourceId)}.json`), "utf8")),
  };
}

test("actual Hugo continuation accepts descending initial sequences and increasing changes across durable reloads", async t => {
  const f = await fixture(t);
  await f.drain(feed("initial", [event(1, "20", "source-a")], null, "initial_2"));
  assert.equal((await f.state()).checkpoint_cursor, null);
  await f.drain(feed("initial", [event(2, "10", "source-b")], "cp_initial"), "initial_2");
  assert.equal((await f.state()).stream, "changes");
  await f.drain(feed("changes", [event(3, "21"), event(4, "22", "source-b")], "cp_22", "changes_2"), "cp_initial");
  assert.equal((await f.state()).last_sequence, "22");
  assert.equal((await f.state()).next_cursor, "changes_2");
  await f.drain(feed("changes", [event(5, "23")], "cp_23"), "changes_2");
  assert.equal((await f.state()).checkpoint_cursor, "cp_23");
  assert.equal((await f.current("source-a")).event_sequence, "23");
  assert.equal((await f.current("source-b")).event_sequence, "22");
});

for (const [name, firstSequence, secondSequence, repairedSequence] of [
  ["equal", "12", "12", "13"], ["descending", "13", "12", "14"],
]) {
  test(`actual Hugo ${name} second event retains staged prefix but not checkpoint and restarts safely`, async t => {
    const f = await fixture(t);
    await f.drain(feed("initial", [event(1, "10")], "cp_10"));
    await f.drain(feed("changes", [event(2, "11")], "cp_11"), "cp_10");
    const before = await f.raw(), first = event(3, firstSequence);
    await assert.rejects(f.drain(feed("changes", [first, event(4, secondSequence, "source-b")], "bad_cp"), "cp_11"), /strictly increasing/);
    assert.equal(await f.raw(), before, "failed page must not advance last_sequence or either cursor");
    assert.deepEqual(await f.savedEvent(3), first, "existing continuation intentionally retains an immutable staged prefix");
    await assert.rejects(f.savedEvent(4), { code: "ENOENT" });
    await f.drain(feed("changes", [first, event(4, repairedSequence, "source-b")], "cp_repaired"), "cp_11");
    assert.equal((await f.state()).last_sequence, repairedSequence);
    assert.equal((await f.state()).checkpoint_cursor, "cp_repaired");
    assert.deepEqual(await f.savedEvent(3), first);
  });
}

for (const [name, sequence] of [["equal", "12"], ["descending", "11"]]) {
  test(`actual Hugo ${name} cross-page sequence rejects after durable reload`, async t => {
    const f = await fixture(t);
    await f.drain(feed("initial", [event(1, "10")], "cp_10"));
    await f.drain(feed("changes", [event(2, "12")], "cp_12"), "cp_10");
    const before = await f.raw();
    await assert.rejects(f.drain(feed("changes", [event(3, sequence, "source-b")], "bad_cp"), "cp_12"), /strictly increasing/);
    assert.equal(await f.raw(), before);
    await assert.rejects(f.savedEvent(3), { code: "ENOENT" });
    await f.drain(feed("changes", [event(4, "13", "source-b")], "cp_13"), "cp_12");
    assert.equal((await f.state()).last_sequence, "13");
  });
}

for (const [name, sequences] of [
  ["above Number.MAX_SAFE_INTEGER", ["9007199254740992", "9007199254740993", "9007199254740994"]],
  ["near signed64 maximum", ["9223372036854775805", "9223372036854775806", "9223372036854775807"]],
]) {
  test(`actual Hugo keeps adjacent decimal change sequences exact ${name}`, async t => {
    const f = await fixture(t);
    await f.drain(feed("initial", [event(1, sequences[0])], "cp_initial"));
    await f.drain(feed("changes", [event(2, sequences[1])], "cp_second"), "cp_initial");
    await f.drain(feed("changes", [event(3, sequences[2])], "cp_third"), "cp_second");
    assert.equal((await f.state()).last_sequence, sequences[2]);
    assert.equal((await f.current("source-a")).event_sequence, sequences[2]);
    const before = await f.raw();
    await assert.rejects(f.drain(feed("changes", [event(4, sequences[1], "source-b")], "bad_cp"), "cp_third"), /strictly increasing/);
    assert.equal(await f.raw(), before);
  });
}

test("actual Hugo rejects committed exact replay, changed reused event ID and duplicate sequence without advancing checkpoint", async t => {
  const f = await fixture(t), committed = event(2, "20");
  await f.drain(feed("initial", [event(1, "10")], "cp_10"));
  await f.drain(feed("changes", [committed], "cp_20"), "cp_10");
  const before = await f.raw();
  await assert.rejects(f.drain(feed("changes", [structuredClone(committed)], "bad_cp"), "cp_20"), /strictly increasing/);
  assert.equal(await f.raw(), before);
  const changed = event(2, "21"); changed.source.title = "Changed retained event";
  await assert.rejects(f.drain(feed("changes", [changed], "bad_cp"), "cp_20"), /immutable source\/event identity changed/);
  assert.equal(await f.raw(), before);
  assert.deepEqual(await f.savedEvent(2), committed);
  await assert.rejects(f.drain(feed("changes", [event(3, "20", "source-b")], "bad_cp"), "cp_20"), /strictly increasing/);
  assert.equal(await f.raw(), before);
});

test("actual Hugo client rejects a typed-invalid second event before creating an event file or advancing checkpoint", async t => {
  const f = await fixture(t);
  await f.drain(feed("initial", [event(1, "10")], "cp_10"));
  const before = await f.raw(), invalid = event(3, "13", "source-b"); invalid.source.content_bytes = 1.5;
  await assert.rejects(f.drain(feed("changes", [event(2, "12"), invalid], "bad_cp"), "cp_10"), error => error.code === "invalid_field");
  assert.equal(await f.raw(), before);
  await assert.rejects(f.savedEvent(2), { code: "ENOENT" });
  await f.drain(feed("changes", [event(2, "12"), event(3, "13", "source-b")], "cp_13"), "cp_10");
  assert.equal((await f.state()).checkpoint_cursor, "cp_13");
});
