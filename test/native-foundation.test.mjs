import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { withCmsNativeLock } from "../src/native-lock.mjs";
import { fileFingerprint, nativePath } from "../src/native-io.mjs";
import { runCmsNativeCommand } from "../src/native-command.mjs";
import { cleanSourceHtml, completeSourceFingerprint, excerptArticle } from "../src/native-content.mjs";

async function fixture(action) {
  const fixtureRoot = path.resolve(".tmp");
  const root = path.join(fixtureRoot, `native-foundation-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  try { return await action(root); } finally {
    const relative = path.relative(fixtureRoot, root);
    assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  }
}

test("native writer excludes a second owner and releases on errors", async () => {
  await fixture(async (root) => {
    await assert.rejects(withCmsNativeLock(root, async (assertHeld) => {
      await assertHeld();
      await assert.rejects(withCmsNativeLock(root, async () => assert.fail("second writer entered")), (error) => {
        assert.equal(error.code, "ELOCKED", JSON.stringify({ message: error.message, native_helper: error.native_helper }));
        return true;
      });
      throw new Error("fixture interrupted");
    }), /fixture interrupted/);
    await withCmsNativeLock(root, async (assertHeld) => { await assertHeld(); });
  });
});

test("Linux native lock file-open failure is not reported as contention", { skip: process.platform !== "linux" || process.getuid() === 0 }, async () => {
  await fixture(async (root) => {
    await withCmsNativeLock(root, async (assertHeld) => { await assertHeld(); });
    const lockFile = path.join(root, "writer.os-lock");
    await chmod(lockFile, 0o000);
    try {
      await assert.rejects(withCmsNativeLock(root, async () => assert.fail("unreadable lock entered")), (error) => {
        assert.notEqual(error.code, "ELOCKED");
        assert.ok(error.native_helper, "the actual native helper failure must remain visible");
        assert.equal(error.native_helper.observed_state, null);
        return true;
      });
    } finally { await chmod(lockFile, 0o600); }
    await withCmsNativeLock(root, async (assertHeld) => { await assertHeld(); });
  });
});

test("native command completion reuses a receipt; uncertain execution never reruns", async () => {
  await fixture(async (root) => {
    const records = new Map();
    const continuation = { async nativeRecord(name, value) { if (value !== undefined) records.set(name, structuredClone(value)); return structuredClone(records.get(name) ?? null); } };
    const output = path.join(root, "actual-native-count.txt");
    const command = { executable: process.execPath, args: ["--input-type=module", "-e", "import { appendFile } from 'node:fs/promises'; await appendFile(process.argv[1], 'one\\n');", output], timeoutMs: 30000 };
    const input = { kind: "build", transactionId: randomUUID(), command, values: { site_root: root }, continuation, assertFence: async () => {} };
    const first = await runCmsNativeCommand(input);
    assert.deepEqual(await runCmsNativeCommand(input), first);
    assert.equal(await readFile(output, "utf8"), "one\n");
    const pendingId = randomUUID();
    await continuation.nativeRecord(`native/${pendingId}/build.json`, { ...records.values().next().value, transaction_id: pendingId, phase: "intent", completed_at: null });
    await assert.rejects(runCmsNativeCommand({ ...input, transactionId: pendingId }), /requires attention/);
    assert.equal(await readFile(output, "utf8"), "one\n");
    const failedId = randomUUID();
    await assert.rejects(runCmsNativeCommand({ ...input, transactionId: failedId, command: { ...command, args: ["-e", "process.exit(2)"] } }), /requires attention/);
    assert.notEqual((await continuation.nativeRecord(`native/${failedId}/build.json`)).phase, "completed");
    await assert.rejects(runCmsNativeCommand({ ...input, transactionId: randomUUID(), command: { ...command, executable: path.join(root, "missing-command.exe") } }), /requires attention/);
    await assert.rejects(runCmsNativeCommand({ ...input, transactionId: randomUUID(), command: { ...command, args: ["-e", "setTimeout(() => {}, 60000)"], timeoutMs: 30 } }), /requires attention/);
  });
});

test("complete native HTML is sanitized and hashed before a Unicode-safe article excerpt", async () => {
  const raw = '<h1>Actual source</h1><p>' + 'é&😀'.repeat(100) + '</p><script>unsafe()</script><section class="discussionbridge-presentation"><p>owned discussion</p></section>';
  const clean = cleanSourceHtml(raw);
  assert.ok(!clean.includes("unsafe") && !clean.includes("owned discussion"));
  const complete = completeSourceFingerprint(clean);
  assert.equal(complete.content_bytes, Buffer.byteLength(clean));
  assert.equal(complete.content_sha256, createHash("sha256").update(clean).digest("hex"));
  const article = excerptArticle(clean, 79);
  assert.ok(article.isWellFormed()); assert.ok(Buffer.byteLength(article) <= 79);
  assert.notEqual(createHash("sha256").update(article).digest("hex"), complete.content_sha256);
  assert.throws(() => cleanSourceHtml("<script>unsafe()</script>"), /empty after sanitization/);
  await fixture(async (root) => {
    const file = nativePath(root, "source/article.md"); await mkdir(path.dirname(file)); await writeFile(file, clean);
    assert.deepEqual(await fileFingerprint(file), { sha256: complete.content_sha256, bytes: complete.content_bytes });
    assert.throws(() => nativePath(root, "../escaped.md"), /relative path/);
  });
});
