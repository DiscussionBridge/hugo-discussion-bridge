import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withCmsJournal } from "../src/cms-journal.mjs";
import { hashCmsOwnershipReceipt } from "../src/cms-ownership.mjs";

const mappingId = "11111111-1111-4111-8111-111111111111";
const resourceId = "22222222-2222-4222-8222-222222222222";
const workId = "33333333-3333-4333-8333-333333333333";
const transactionId = "44444444-4444-4444-8444-444444444444";
const mutationId = "55555555-5555-4555-8555-555555555555";
const finalizeId = "66666666-6666-4666-8666-666666666666";
const token = Buffer.alloc(32, 7).toString("base64url");
const authority = { work_id: workId, lease_generation: 1, source_revision: "revision-1", policy_revision: "policy-1" };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const time = "2026-10-13T12:00:00.000Z";

function receipt(auth = authority) {
  return { schema_version: "db-native-ownership-1", forum_origin: "https://forum.example/", connection_id: `dbc_${"a".repeat(24)}`,
    mapping_id: mappingId, resource_id: resourceId, source_id: "source-1", external_id: "external-1", native_id: "article.md",
    canonical_url: "https://native.example/article/", source_revision: auth.source_revision, last_lease_generation: auth.lease_generation,
    move_id: null, proof_nonce: null };
}

function preparation(auth = authority, tx = transactionId) {
  return { mutation_id: auth.lease_generation === 1 ? mutationId : "88888888-8888-4888-8888-888888888888", authority: auth, transaction_id: tx, prepared_at: time,
    native_result: { kind: "publish_revision", native_id: "article.md", external_id: "external-1", canonical_url: "https://native.example/article/",
      native_revision: "native-revision-1", ownership_receipt_sha256: hashCmsOwnershipReceipt(receipt(auth)), representation: { kind: "full", source_content_sha256: sha("source content") } } };
}

function finalization(auth = authority, tx = transactionId) {
  return { mutation_id: finalizeId, authority: auth, transaction_id: tx, deployment_id: "local-build-1", deployed_at: time,
    verification: { kind: "published", url: "https://native.example/article/", native_id: "article.md", source_revision: auth.source_revision,
      source_content_sha256: sha("source content"), native_publication_sha256: sha("native rendered content"), verification_profile: "hugo-test-fixture-profile-1",
      checked_at: time, representation: { kind: "full", source_content_sha256: sha("source content") } } };
}

function receiverResponse(state, auth = authority) {
  return { work: { work_id: auth.work_id, mapping_id: mappingId, source_id: "source-1", source_revision: auth.source_revision,
    policy_revision: auth.policy_revision, action: auth.source_revision === null ? "withdraw" : "publish_revision", state,
    attempt_cycle: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", attempt: 1, lease_generation: auth.lease_generation, retry_at: null, last_failure_code: null },
    mapping: { mapping_id: mappingId, resource_id: resourceId, connection_id: `dbc_${"a".repeat(24)}`, source_id: "source-1", external_id: "external-1",
      mapping_revision: "mapping-revision-1", destination_native_id: "article.md", canonical_url: "https://native.example/article/", retired_url_count: 0,
      mapping_state: state === "verified" ? "active" : "pending", presentation_mode: "interactive", desired_source_revision: auth.source_revision,
      synchronized_source_revision: auth.source_revision, publicly_verified_source_revision: state === "verified" ? auth.source_revision : null,
      destination_native_revision: "native-revision-1", source_created_at: null, source_updated_at: null, synchronized_at: time,
      publicly_verified_at: state === "verified" ? time : null }, lease_expires_at: null };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hugo-cms-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, journalRoot: path.join(root, "private-journal"), nativeRoot: path.join(root, "content"), mappingId };
}

async function staged(context, files = [{ path: "article.md", bytes: Buffer.from("native first revision"), expectedSha256: null }], auth = authority, tx = transactionId) {
  await context.stage({ transactionId: tx, action: "publish_revision", receipt: receipt(auth), files });
  await context.apply(tx);
}

async function verifyFixture(context, auth = authority, tx = transactionId) {
  await context.queueMutation("prepare", preparation(auth, tx), token);
  await context.acceptMutation(preparation(auth, tx).mutation_id, receiverResponse("synchronized", auth));
  await context.queueMutation("finalize", finalization(auth, tx), token);
  await context.acceptMutation(finalizeId, receiverResponse("verified", auth));
}

test("native first claim is exclusive and stage/finalize receipts preserve exact ownership", async (t) => {
  const config = await fixture(t);
  await withCmsJournal(config, authority, async (context) => {
    await staged(context);
    await assert.rejects(context.queueMutation("finalize", finalization(), token), /accepted exact preparation/u);
    await verifyFixture(context);
    assert.equal(context.snapshot().last_verified.receipt.native_id, "article.md");
    assert.equal(context.snapshot().last_verified.finalize_report.deployment_id, "local-build-1");
    assert.equal(context.snapshot().last_verified.finalize_report.verification.checked_at, time);
    assert.equal(context.snapshot().transaction.phase, "verified");
    await assert.rejects(context.restore(transactionId), /verified transaction/u);
  });
  assert.equal(await readFile(path.join(config.nativeRoot, "article.md"), "utf8"), "native first revision");
  const journal = await readFile(path.join(config.journalRoot, `${mappingId}.json`), "utf8");
  assert.ok(!journal.includes(token)); assert.ok(!journal.includes("lease_token"));
});

test("lock prevents simultaneous workers and mapping fence survives a different work item", async (t) => {
  const config = await fixture(t);
  await withCmsJournal(config, authority, async () => {
    await assert.rejects(withCmsJournal(config, { ...authority, lease_generation: 2 }, () => {}), /mapping is locked/u);
  });
  const next = { ...authority, work_id: "77777777-7777-4777-8777-777777777777", lease_generation: 9, source_revision: "revision-2" };
  await withCmsJournal(config, next, () => {});
  await assert.rejects(withCmsJournal(config, authority, () => {}), /fencing generation/u);
  await assert.rejects(withCmsJournal(config, { ...next, policy_revision: "wrong-policy" }, () => {}), /fencing generation/u);
});

test("partial native application recovers exact staged files without a second create", async (t) => {
  const config = await fixture(t);
  await assert.rejects(withCmsJournal(config, authority, async (context) => {
    await context.stage({ transactionId, action: "publish_revision", receipt: receipt(), files: [
      { path: "article.md", bytes: Buffer.from("article"), expectedSha256: null },
      { path: "data/source.json", bytes: Buffer.from("prepared Hugo data"), expectedSha256: null },
    ] });
    await context.apply(transactionId, { afterFile: () => { throw new Error("simulated interruption after native commit"); } });
  }), /simulated interruption/u);
  assert.equal(await readFile(path.join(config.nativeRoot, "article.md"), "utf8"), "article");
  await withCmsJournal(config, authority, async (context) => {
    assert.equal(context.snapshot().transaction.phase, "staged");
    await context.apply(transactionId);
    assert.equal(context.snapshot().transaction.phase, "applied");
  });
  assert.equal(await readFile(path.join(config.nativeRoot, "data/source.json"), "utf8"), "prepared Hugo data");
});

test("new generation can resume exact staged transaction after native reconciliation", async (t) => {
  const config = await fixture(t);
  await withCmsJournal(config, authority, async (context) => { await staged(context); });
  const next = { ...authority, lease_generation: 2 };
  await withCmsJournal(config, next, async (context) => {
    await assert.rejects(context.apply(transactionId), /current native fence/u);
    await context.rebind(transactionId, receipt(next));
    await context.apply(transactionId);
    const currentPrepare = { ...preparation(next), mutation_id: "88888888-8888-4888-8888-888888888888" };
    await context.queueMutation("prepare", currentPrepare, token);
  });
  await assert.rejects(withCmsJournal(config, authority, () => {}), /fencing generation/u);
});

test("pending mutation survives restart without storing credentials or changing exact replay", async (t) => {
  const config = await fixture(t);
  await withCmsJournal(config, authority, async (context) => {
    await staged(context);
    const outbound = await context.queueMutation("prepare", preparation(), token);
    assert.equal(outbound.payload.authority.lease_token, token);
  });
  await withCmsJournal(config, authority, async (context) => {
    assert.deepEqual(context.pendingRequest(token).payload, { ...preparation(), authority: { ...authority, lease_token: token } });
    assert.throws(() => context.pendingRequest(Buffer.alloc(32, 9).toString("base64url")), /original pending credential/u);
    await assert.rejects(context.queueMutation("prepare", { ...preparation(), prepared_at: "2026-10-13T12:00:01.000Z" }, token), /cannot change/u);
    await assert.rejects(context.queueMutation("prepare", { ...preparation(), connection_secret: "secret" }, token), /credentials/u);
    await context.acceptMutation(mutationId, receiverResponse("synchronized"));
  });
});

test("resumed accepted preparation cannot finalize until the replacement generation repeats prepare", async (t) => {
  const config = await fixture(t);
  await withCmsJournal(config, authority, async (context) => {
    await staged(context); await context.queueMutation("prepare", preparation(), token); await context.acceptMutation(mutationId, receiverResponse("synchronized"));
  });
  const next = { ...authority, lease_generation: 2 };
  await withCmsJournal(config, next, async (context) => {
    await context.rebind(transactionId, receipt(next));
    await assert.rejects(context.queueMutation("finalize", finalization(next), token), /accepted exact preparation/u);
    const repeated = preparation(next);
    assert.notEqual(repeated.mutation_id, mutationId);
    await context.queueMutation("prepare", repeated, token); await context.acceptMutation(repeated.mutation_id, receiverResponse("synchronized", next));
    await context.queueMutation("finalize", finalization(next), token); await context.acceptMutation(finalizeId, receiverResponse("verified", next));
  });
});

test("unowned existing files, traversal, duplicate paths and links are refused before mutation", async (t) => {
  const config = await fixture(t); await mkdir(config.nativeRoot);
  const target = path.join(config.nativeRoot, "article.md"); await writeFile(target, "operator content");
  await withCmsJournal(config, authority, async (context) => {
    await assert.rejects(context.stage({ transactionId, action: "publish_revision", receipt: receipt(), files: [
      { path: "article.md", bytes: Buffer.from("overwrite"), expectedSha256: sha("operator content") },
    ] }), /explicit adoption/u);
    await assert.rejects(context.stage({ transactionId, action: "publish_revision", receipt: receipt(), files: [
      { path: "../outside.md", bytes: Buffer.from("escape"), expectedSha256: null },
    ] }), /relative path/u);
    await assert.rejects(context.stage({ transactionId, action: "publish_revision", receipt: receipt(), files: [
      { path: "duplicate.md", bytes: Buffer.from("a"), expectedSha256: null }, { path: "duplicate.md", bytes: Buffer.from("b"), expectedSha256: null },
    ] }), /duplicate/u);
  });
  assert.equal(await readFile(target, "utf8"), "operator content");
  const linkedConfig = { ...config, journalRoot: path.join(config.root, "journal-link") };
  try { await symlink(config.journalRoot, linkedConfig.journalRoot, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM") { t.diagnostic("Symlink creation unavailable in this Windows context; actual link case not exercised."); return; } throw error; }
  await assert.rejects(withCmsJournal(linkedConfig, authority, () => {}), /symbolic links/u);
});

test("rollback restores previous verified bytes and refuses local edits during restore", async (t) => {
  const config = await fixture(t);
  await withCmsJournal(config, authority, async (context) => { await staged(context); await verifyFixture(context); });
  const next = { ...authority, work_id: "77777777-7777-4777-8777-777777777777", lease_generation: 2, source_revision: "revision-2" };
  const nextTx = "99999999-9999-4999-8999-999999999999";
  await withCmsJournal(config, next, async (context) => {
    await staged(context, [{ path: "article.md", bytes: Buffer.from("native second revision"), expectedSha256: sha("native first revision") }], next, nextTx);
    await context.queueMutation("prepare", preparation(next, nextTx), token); await context.acceptMutation(preparation(next, nextTx).mutation_id, receiverResponse("synchronized", next));
    await writeFile(path.join(config.nativeRoot, "article.md"), "operator edit");
    await assert.rejects(context.restore(nextTx), /changed local file retained/u);
    assert.equal(await readFile(path.join(config.nativeRoot, "article.md"), "utf8"), "operator edit");
    await writeFile(path.join(config.nativeRoot, "article.md"), "native second revision");
    const restored = await context.restore(nextTx);
    assert.equal(restored.native_restored, true);
    assert.equal(restored.previous_verified.receipt.source_revision, "revision-1");
    assert.equal(await readFile(path.join(config.nativeRoot, "article.md"), "utf8"), "native first revision");
    await context.queueMutation("abort", { mutation_id: finalizeId, authority: next, transaction_id: nextTx, native_restored: true, safe_detail: null }, token);
    await context.acceptMutation(finalizeId, receiverResponse("attention", next));
    assert.equal(context.snapshot().last_verified.receipt.source_revision, "revision-1");
  });
});

test("native publication proof shapes cannot substitute a source marker or wrong action", async (t) => {
  const config = await fixture(t);
  await withCmsJournal(config, authority, async (context) => {
    await staged(context); await context.queueMutation("prepare", preparation(), token); await context.acceptMutation(mutationId, receiverResponse("synchronized"));
    for (const verification of [
      { kind: "absent", url: "https://native.example/article/", native_id: "article.md", checked_at: time, http_status: 404 },
      { ...finalization().verification, native_publication_sha256: undefined },
      { ...finalization().verification, source_revision: "wrong-revision" },
      { ...finalization().verification, checked_at: "2026-10-13T11:59:59.000Z" },
    ]) await assert.rejects(context.queueMutation("finalize", { ...finalization(), verification }, token), /public report/u);
  });
});

test("aborted first creation retains identity and false restoration remains attention", async (t) => {
  const config = await fixture(t);
  await withCmsJournal(config, authority, async (context) => {
    await staged(context); await context.queueMutation("prepare", preparation(), token); await context.acceptMutation(mutationId, receiverResponse("synchronized"));
    await context.restore(transactionId);
    await context.queueMutation("abort", { mutation_id: finalizeId, authority, transaction_id: transactionId, native_restored: true, safe_detail: null }, token);
    await context.acceptMutation(finalizeId, receiverResponse("attention"));
  });
  const next = { ...authority, lease_generation: 2 };
  await withCmsJournal(config, next, async (context) => {
    await assert.rejects(context.stage({ transactionId: "99999999-9999-4999-8999-999999999999", action: "publish_revision",
      receipt: { ...receipt(next), native_id: "different.md" }, files: [{ path: "different.md", bytes: Buffer.from("different"), expectedSha256: null }] }), /reserved native identity/u);
    await staged(context, undefined, next, "99999999-9999-4999-8999-999999999999");
    await context.queueMutation("prepare", preparation(next, "99999999-9999-4999-8999-999999999999"), token); await context.acceptMutation(preparation(next, "99999999-9999-4999-8999-999999999999").mutation_id, receiverResponse("synchronized", next));
    await context.queueMutation("abort", { mutation_id: finalizeId, authority: next, transaction_id: "99999999-9999-4999-8999-999999999999", native_restored: false, safe_detail: "Native restoration needs operator reconciliation." }, token);
    await context.acceptMutation(finalizeId, receiverResponse("attention", next));
    assert.equal(context.snapshot().transaction.phase, "attention");
    assert.equal(await readFile(path.join(config.nativeRoot, "article.md"), "utf8"), "native first revision");
  });
});

test("receiver acknowledgement is accepted only for exact work, generation and native binding", async (t) => {
  const config = await fixture(t);
  await withCmsJournal(config, authority, async (context) => {
    await staged(context); await context.queueMutation("prepare", preparation(), token);
    await assert.rejects(context.acceptMutation(mutationId, "synchronized"), /owned binding/u);
    const wrongGeneration = receiverResponse("synchronized"); wrongGeneration.work.lease_generation = 2;
    await assert.rejects(context.acceptMutation(mutationId, wrongGeneration), /owned binding/u);
    const wrongNative = receiverResponse("synchronized"); wrongNative.mapping.destination_native_id = "unrelated.md";
    await assert.rejects(context.acceptMutation(mutationId, wrongNative), /owned binding/u);
    await assert.rejects(context.acceptMutation(mutationId, receiverResponse("verified")), /owned binding/u);
    assert.ok(context.snapshot().pending_mutation);
    await context.acceptMutation(mutationId, receiverResponse("synchronized"));
    assert.equal(context.snapshot().pending_mutation, null);
  });
});

test("a killed native worker is recovered automatically only after native owner death proof", async (t) => {
  const config = await fixture(t);
  const moduleUrl = pathToFileURL(fileURLToPath(new URL("../src/cms-journal.mjs", import.meta.url))).href;
  const source = `import { withCmsJournal } from ${JSON.stringify(moduleUrl)};
    await withCmsJournal(${JSON.stringify(config)}, ${JSON.stringify(authority)}, async (context) => {
      await context.stage({ transactionId: ${JSON.stringify(transactionId)}, action: "publish_revision", receipt: ${JSON.stringify(receipt())}, files: [
        { path: "article.md", bytes: Buffer.from("crash-owned article"), expectedSha256: null },
        { path: "data/source.json", bytes: Buffer.from("crash-owned data"), expectedSha256: null }
      ] });
      await context.apply(${JSON.stringify(transactionId)}, { afterFile: () => process.exit(77) });
    });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (bytes) => { stderr += bytes.toString(); });
  const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
  assert.deepEqual(status, { code: 77, signal: null }, stderr);
  const lockPath = path.join(config.journalRoot, `${mappingId}.lock`);
  const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
  assert.equal(owner.owner_pid, child.pid);
  assert.equal(await readFile(path.join(config.nativeRoot, "article.md"), "utf8"), "crash-owned article");
  assert.equal(owner.lock_version, "db-native-lock-2");
  assert.equal(typeof owner.process_identity.start, "string");
  // The implementation obtains the OS lock and independently proves that this
  // exact recorded parent owner is absent; the harness does not erase its lock.
  await withCmsJournal(config, authority, async (context) => { await context.apply(transactionId); });
  assert.equal(await readFile(path.join(config.nativeRoot, "data/source.json"), "utf8"), "crash-owned data");
});

test("full native payload over the former 64 MiB journal bound roundtrips and restores", async (t) => {
  const config = await fixture(t);
  const bytes = Buffer.alloc(66 * 1024 * 1024, 0x71); bytes.write("native full content\n");
  const expected = sha(bytes);
  await withCmsJournal(config, authority, async (context) => {
    await staged(context, [{ path: "article.md", bytes, expectedSha256: null }]);
    await verifyFixture(context);
    assert.equal(context.snapshot().last_verified.files[0].after_bytes, bytes.length);
  });
  const target = path.join(config.nativeRoot, "article.md");
  const hashFile = async () => { const hash = createHash("sha256"); for await (const chunk of createReadStream(target)) hash.update(chunk); return hash.digest("hex"); };
  assert.equal(await hashFile(), expected);
  const metadata = await readFile(path.join(config.journalRoot, `${mappingId}.json`));
  assert.ok(metadata.length < 100_000, "native bytes are private payload files, not JSON/base64 duplication");
  const next = { ...authority, work_id: "77777777-7777-4777-8777-777777777777", lease_generation: 2, source_revision: "revision-2" };
  const nextTx = "99999999-9999-4999-8999-999999999999";
  await withCmsJournal(config, next, async (context) => {
    await staged(context, [{ path: "article.md", bytes: Buffer.from("replacement"), expectedSha256: expected }], next, nextTx);
    await context.restore(nextTx);
  });
  assert.equal(await hashFile(), expected);
});

test("native transaction has no arbitrary 32 file ceiling and private payload corruption refuses commit", async (t) => {
  const config = await fixture(t);
  const files = Array.from({ length: 40 }, (_, index) => ({ path: `parts/${index}.txt`, bytes: Buffer.from(`native part ${index}`), expectedSha256: null }));
  await withCmsJournal(config, authority, async (context) => {
    await context.stage({ transactionId, action: "publish_revision", receipt: receipt(), files });
    const state = context.snapshot(); assert.equal(state.transaction.files.length, 40);
    const payload = path.join(config.journalRoot, ...state.transaction.files[0].after_payload.split("/"));
    await writeFile(payload, "unproved private payload change");
    await assert.rejects(context.apply(transactionId), /snapshot bytes changed/u);
    await assert.rejects(readFile(path.join(config.nativeRoot, "parts/0.txt")), { code: "ENOENT" });
    await writeFile(payload, "native part 0");
    await context.apply(transactionId);
  });
  assert.equal(await readFile(path.join(config.nativeRoot, "parts/39.txt"), "utf8"), "native part 39");
});

test("present PID with a different start identity and unknown owner both retain attention", async (t) => {
  const config = await fixture(t); let own;
  const lockPath = path.join(config.journalRoot, `${mappingId}.lock`);
  await withCmsJournal(config, authority, async () => { own = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")); });
  await mkdir(lockPath);
  own.process_identity.start += "1";
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify(own));
  await assert.rejects(withCmsJournal(config, { ...authority, lease_generation: 2 }, () => {}), /reused or unknown owner/u);
  assert.equal(JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")).process_identity.start, own.process_identity.start);
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ owner_pid: process.pid }));
  await assert.rejects(withCmsJournal(config, authority, () => {}), /reused or unknown owner/u);
});

test("live worker and Linux-paused worker never lose the native OS lock through elapsed time", async (t) => {
  const config = await fixture(t);
  const moduleUrl = pathToFileURL(fileURLToPath(new URL("../src/cms-journal.mjs", import.meta.url))).href;
  const source = `import { withCmsJournal } from ${JSON.stringify(moduleUrl)};
    await withCmsJournal(${JSON.stringify(config)}, ${JSON.stringify(authority)}, async()=>{
      process.stdout.write('READY\\n'); await new Promise(()=>{});
    });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (bytes) => { stderr += bytes.toString(); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", () => reject(new Error(`Native live worker exited before readiness: ${stderr}`)));
    child.stdout.on("data", (bytes) => { if (bytes.toString().includes("READY")) resolve(); });
  });
  if (process.platform === "linux") child.kill("SIGSTOP");
  await assert.rejects(withCmsJournal(config, { ...authority, lease_generation: 2 }, () => {}), /mapping is locked/u);
  if (process.platform === "linux") child.kill("SIGCONT");
  const exit = new Promise((resolve) => child.once("exit", resolve)); child.kill(); await exit;
  await withCmsJournal(config, { ...authority, lease_generation: 2 }, () => {});
});
