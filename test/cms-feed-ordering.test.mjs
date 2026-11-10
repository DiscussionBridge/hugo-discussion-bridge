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
    assert.ok(pending.length, "unexpected source request");
    const { value, cursor = null, stream = value.stream, route = "sources", status = 200 } = pending.shift();
    assert.equal(url.pathname, `/discussion-bridge/v4/${route}.json`);
    assert.equal(url.searchParams.get("stream"), stream ?? null);
    assert.equal(url.searchParams.get("cursor"), cursor);
    return json(value, status);
  } });
  const run = action => withCmsContinuation({ privateRoot, nativeRoot, publicRoots: [publicRoot], client, connection: connection() }, action);
  return {
    async drain(value, cursor = null) {
      pending.push({ value, cursor });
      return run(continuation => continuation.drainSources({ maximumPages: 1 }));
    },
    async poll(requests, maximumPages = 1) {
      pending.push(...requests);
      const result = await run(async continuation => {
        const result = await continuation.drainSources({ maximumPages });
        const events = []; for await (const item of continuation.currentEvents()) events.push(item);
        return { ...result, events };
      });
      assert.equal(pending.length, 0, "expected receiver requests were not consumed");
      return result;
    },
    mapping: (sourceId, value) => run(continuation => continuation.mapping(sourceId, value)),
    raw: () => readFile(path.join(privateRoot, "continuation.json"), "utf8"),
    state: async () => JSON.parse(await readFile(path.join(privateRoot, "continuation.json"), "utf8")),
    savedEvent: async index => JSON.parse(await readFile(path.join(privateRoot, "events", `${uuid(index)}.json`), "utf8")),
    current: async sourceId => JSON.parse(await readFile(path.join(privateRoot, "current", `${sha(sourceId)}.json`), "utf8")),
  };
}

const rejected = code => ({ outcome: "rejected", code, retryable: false, retry_after_seconds: null, correlation_id: uuid(100), core_fallback: false });
const existingMapping = (source_id = "source-a") => ({
  mapping_id: uuid(101), resource_id: uuid(102), connection_id: cmsConfig.connectionId, source_id,
  external_id: "external-a", canonical_url: "https://hugo.example/existing/", mapping_revision: "mapping-1",
  destination_native_id: "content/existing.md", retired_url_count: 0, mapping_state: "active", presentation_mode: "interactive",
  desired_source_revision: "revision-10", synchronized_source_revision: "revision-10", publicly_verified_source_revision: "revision-10",
  destination_native_revision: "native-1", source_created_at: null, source_updated_at: null,
  synchronized_at: "2026-10-14T12:00:00.000Z", publicly_verified_at: "2026-10-14T12:00:00.000Z",
});

test("Hugo recovers a validated 410 across runs, preserves owned mapping and replaces only the current source view", async t => {
  const f = await fixture(t), original = event(1, "10"), mapping = existingMapping();
  await f.drain(feed("initial", [original], "old"));
  await f.mapping("source-a", mapping);
  await f.drain(feed("changes", [event(2, "11", "stale-unmapped")], "old_11"), "old");
  const first = event(3, "14", "source-b"), second = event(4, "13", "source-c");
  const stopped = await f.poll([
    { value: rejected("cursor_expired"), stream: "changes", cursor: "old_11", status: 410 },
    { value: feed("initial", [first], null, "fresh_2") },
  ], 2);
  assert.deepEqual(stopped, { complete: false, pages: 2, events: [] });
  const recovery = await f.state();
  assert.equal(recovery.next_cursor, "fresh_2");
  assert.ok(recovery.recovery_projection);
  assert.deepEqual(await f.current("source-a"), original);
  const inventory = { route: "mappings", value: { items: [mapping], next_cursor: null } };
  await assert.rejects(f.poll([
    { value: feed("initial", [second], "fresh"), cursor: "fresh_2" },
    { ...inventory, value: { ...inventory.value, items: [{ ...mapping, canonical_url: "https://hugo.example/other/" }] } },
  ]), /receiver mapping inventory needs reconciliation/);
  assert.deepEqual(await f.state(), recovery, "failed reconciliation cannot activate the fresh checkpoint");
  const finished = await f.poll([{ value: feed("initial", [second], "fresh"), cursor: "fresh_2" }, inventory]);
  assert.deepEqual(finished.events.map(item => item.source.source_id).sort(), ["source-b", "source-c"]);
  assert.equal((await f.state()).checkpoint_cursor, "fresh");
  assert.deepEqual({ ...await f.mapping("source-a") }, mapping, "absence from snapshot is not a withdrawal");
  assert.deepEqual(await f.savedEvent(1), original);
  const changed = await f.poll([{ value: feed("changes", [event(5, "15", "source-b")], "fresh_15"), cursor: "fresh" }]);
  assert.deepEqual(changed.events.map(item => item.event_sequence).sort(), ["13", "15"]);
});

test("Hugo does not rewind on cursor scope change", async t => {
  const f = await fixture(t);
  await f.drain(feed("initial", [event(1, "10")], "old"));
  const before = await f.raw();
  await assert.rejects(f.poll([{ value: rejected("cursor_scope_changed"), stream: "changes", cursor: "old", status: 409 }]), { code: "cursor_scope_changed" });
  assert.equal(await f.raw(), before);
});

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
