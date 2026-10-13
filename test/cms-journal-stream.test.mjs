import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withCmsJournal } from "../src/cms-journal.mjs";
import { createCmsPayloadSpool } from "../src/cms-payload-spool.mjs";

const mappingId = "11111111-1111-4111-8111-111111111111";
const transactionId = "44444444-4444-4444-8444-444444444444";
const authority = { work_id: "33333333-3333-4333-8333-333333333333", lease_generation: 1,
  source_revision: "revision-1", policy_revision: "policy-1" };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const receipt = (auth = authority) => ({ schema_version: "db-native-ownership-1", forum_origin: "https://forum.example/",
  connection_id: `dbc_${"a".repeat(24)}`, mapping_id: mappingId, resource_id: "22222222-2222-4222-8222-222222222222",
  source_id: "source-1", external_id: "external-1", native_id: "article.md", canonical_url: "https://native.example/article/",
  source_revision: auth.source_revision, last_lease_generation: auth.lease_generation, move_id: null, proof_nonce: null });

async function fixture(t) {
  const parent = path.resolve(process.env.DISCUSSIONBRIDGE_CMS_AUTHOR_FIXTURE_ROOT ?? os.tmpdir());
  const root = await mkdtemp(path.join(parent, "hugo-cms-stream-author-"));
  const marker = path.join(root, ".owned-author-fixture"); await writeFile(marker, "hugo-cms-stream-author\n");
  t.after(async () => {
    // One verified task-owned directory; no shell enumeration or foreign cleanup.
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith("hugo-cms-stream-author-"));
    assert.equal(await readFile(marker, "utf8"), "hugo-cms-stream-author\n");
    await rm(root, { recursive: true, force: true });
  });
  const config = { root, nativeRoot: path.join(root, "content"), journalRoot: path.join(root, "private-journal"), mappingId,
    spoolParent: path.join(root, "private-spool"), publicRoots: [path.join(root, "served-output")] };
  await mkdir(config.spoolParent, { mode: 0o700 });
  return config;
}

async function* chunks(bytes, size = 3) {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

async function privateFile(config) {
  const [directory] = await readdir(config.spoolParent);
  const [file] = await readdir(path.join(config.spoolParent, directory));
  return path.join(config.spoolParent, directory, file);
}

async function hashFile(file) {
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 32_768 })) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest("hex"), bytes };
}

async function stage(context, bytes, files = []) {
  return await context.stage({ transactionId, action: "publish_revision", receipt: receipt(), files: [
    { path: "article.md", bytes, expectedSha256: null }, ...files
  ] });
}

test("private payload requires explicit disjoint root policy and rejects raw or serialized path authority", async (t) => {
  const config = await fixture(t);
  await assert.rejects(createCmsPayloadSpool({ ...config, publicRoots: undefined }), /public-root policy/u);
  await assert.rejects(createCmsPayloadSpool({ ...config, spoolParent: config.nativeRoot }), /disjoint/u);
  await assert.rejects(createCmsPayloadSpool({ ...config, spoolParent: `${config.root}${path.sep}..${path.sep}foreign` }), /safe absolute/u);
  await withCmsJournal(config, authority, async (context) => {
    await assert.rejects(stage(context, { payloadFile: path.join(config.root, "arbitrary"), sha256: sha("data"), bytes: 4 }), /capability/u);
    assert.equal(context.snapshot().transaction, null);
  });
  await assert.rejects(readFile(path.join(config.nativeRoot, "article.md")), { code: "ENOENT" });
});

test("complete UTF-8 may split every code point and stage retains the old Buffer and null contract", async (t) => {
  const config = await fixture(t), spool = await createCmsPayloadSpool(config);
  const bytes = Buffer.from("<p>café 😃 漢字</p>\n".repeat(4000));
  const capability = await spool.ingest(chunks(bytes), { sha256: sha(bytes), bytes: bytes.length });
  assert.ok(Object.isFrozen(capability)); assert.equal(Object.hasOwn(capability, "payloadFile"), false);
  await withCmsJournal(config, authority, async (context) => {
    await assert.rejects(stage(context, structuredClone(capability)), /capability/u);
    await stage(context, capability, [{ path: "small.txt", bytes: Buffer.from("old Buffer input"), expectedSha256: null },
      { path: "absent.txt", bytes: null, expectedSha256: null }]);
    assert.equal(context.snapshot().transaction.files[0].after_bytes, bytes.length);
    await spool.dispose();
    await context.apply(transactionId);
  });
  assert.deepEqual(await hashFile(path.join(config.nativeRoot, "article.md")), { sha256: sha(bytes), bytes: bytes.length });
  assert.equal(await readFile(path.join(config.nativeRoot, "small.txt"), "utf8"), "old Buffer input");
  const journal = await readFile(path.join(config.journalRoot, `${mappingId}.json`), "utf8");
  assert.equal(journal.includes(config.spoolParent), false); assert.equal(journal.includes("cms-private-payload-file"), false);
});

test("complete integrity and final UTF-8 are checked before any payload capability exists", async (t) => {
  const config = await fixture(t), spool = await createCmsPayloadSpool(config);
  const bytes = Buffer.from("complete native payload");
  await assert.rejects(spool.ingest(chunks(bytes), { sha256: sha(bytes), bytes: bytes.length + 1 }), /byte count/u);
  await assert.rejects(spool.ingest(chunks(bytes), { sha256: sha("wrong"), bytes: bytes.length }), /hash/u);
  const incomplete = Buffer.from([0x61, 0xf0, 0x9f, 0x98]);
  await assert.rejects(spool.ingest(chunks(incomplete), { sha256: sha(incomplete), bytes: incomplete.length }), /complete valid UTF-8/u);
  await spool.dispose();
  assert.deepEqual(await readdir(config.spoolParent), []);
});

test("edited, replaced or multiply linked private payloads cannot bypass native ownership", async (t) => {
  for (const action of ["edit", "replace", "hardlink"]) {
    const config = await fixture(t), spool = await createCmsPayloadSpool(config);
    const bytes = Buffer.from("sealed desired bytes");
    const capability = await spool.ingest(chunks(bytes), { sha256: sha(bytes), bytes: bytes.length });
    const file = await privateFile(config);
    if (action === "edit") { await chmod(file, 0o600); await writeFile(file, "modified desired data"); }
    if (action === "replace") { await rename(file, `${file}.moved`); await writeFile(file, bytes, { mode: 0o400 }); }
    if (action === "hardlink") await link(file, path.join(config.root, "foreign-link"));
    await withCmsJournal(config, authority, async (context) => {
      await assert.rejects(stage(context, capability), /edited|replaced|linked/u);
      assert.equal(context.snapshot().transaction, null);
    });
    await assert.rejects(readFile(path.join(config.nativeRoot, "article.md")), { code: "ENOENT" });
  }
});

test("a symlink or directory swap in spool ancestry never adopts foreign bytes", async (t) => {
  const config = await fixture(t), spool = await createCmsPayloadSpool(config);
  const bytes = Buffer.from("owned source");
  const capability = await spool.ingest(chunks(bytes), { sha256: sha(bytes), bytes: bytes.length });
  const file = await privateFile(config), directory = path.dirname(file), moved = `${directory}-moved`;
  await rename(directory, moved);
  await symlink(moved, directory, process.platform === "win32" ? "junction" : "dir");
  await withCmsJournal(config, authority, async (context) => {
    await assert.rejects(stage(context, capability), /symbolic links/u);
    assert.equal(context.snapshot().transaction, null);
  });
});

test("a capability cannot cross native mapping or root authority or survive disposal", async (t) => {
  const config = await fixture(t), spool = await createCmsPayloadSpool(config);
  const bytes = Buffer.from("bound payload");
  const capability = await spool.ingest(chunks(bytes), { sha256: sha(bytes), bytes: bytes.length });
  await withCmsJournal({ ...config, nativeRoot: path.join(config.root, "other-content") }, authority, async (context) => {
    await assert.rejects(stage(context, capability), /different native mapping or roots/u);
  });
  const otherMapping = "99999999-9999-4999-8999-999999999999";
  await withCmsJournal({ ...config, mappingId: otherMapping }, authority, async (context) => {
    await assert.rejects(context.stage({ transactionId, action: "publish_revision", receipt: { ...receipt(), mapping_id: otherMapping },
      files: [{ path: "article.md", bytes: capability, expectedSha256: null }] }), /different native mapping/u);
  });
  await spool.dispose();
  await withCmsJournal(config, authority, async (context) => { await assert.rejects(stage(context, capability), /disposed/u); });
});

test("an observed source edit during streamed copy refuses staging before a native commit", async (t) => {
  const config = await fixture(t), spool = await createCmsPayloadSpool(config);
  const bytes = Buffer.from("valid UTF-8 bytes\n".repeat(12_000));
  const capability = await spool.ingest(chunks(bytes, 32_768), { sha256: sha(bytes), bytes: bytes.length });
  const source = await privateFile(config), probe = await open(path.join(config.root, "probe"), "wx");
  const prototype = Object.getPrototypeOf(probe), original = prototype.writeFile;
  await probe.close(); let changed = false;
  prototype.writeFile = async function (part, ...args) {
    const result = await original.call(this, part, ...args);
    if (!changed && part instanceof Uint8Array && part.length === 32_768) {
      changed = true; await chmod(source, 0o600); await writeFile(source, "unproved source edit");
    }
    return result;
  };
  try {
    await withCmsJournal(config, authority, async (context) => {
      await assert.rejects(stage(context, capability), /changed|byte count/u);
      assert.equal(context.snapshot().transaction, null);
    });
  } finally { prototype.writeFile = original; }
  assert.equal(changed, true);
  await assert.rejects(readFile(path.join(config.nativeRoot, "article.md")), { code: "ENOENT" });
});

test("large complete payload uses bounded I/O and recovery needs no external spool", async (t) => {
  const config = await fixture(t), spool = await createCmsPayloadSpool(config);
  const part = Buffer.from("😃-é\n".repeat(4096)), count = 2200;
  const hash = createHash("sha256"); for (let index = 0; index < count; index++) hash.update(part);
  const expected = { sha256: hash.digest("hex"), bytes: part.length * count };
  assert.ok(expected.bytes > 66 * 1024 * 1024);
  const probe = await open(path.join(config.root, "probe"), "wx"), prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalReadFile = prototype.readFile, originalRead = prototype.read, originalWrite = prototype.writeFile;
  let maxRead = 0, maxWrite = 0;
  prototype.readFile = async function (...args) {
    if ((await this.stat()).size > 1024 * 1024) throw new Error("Author check refuses whole-body FileHandle.readFile.");
    return await originalReadFile.apply(this, args);
  };
  prototype.read = async function (...args) {
    const length = typeof args[2] === "number" ? args[2] : args[0]?.length;
    if (typeof length === "number") { maxRead = Math.max(maxRead, length); assert.ok(length <= 65_536); }
    return await originalRead.apply(this, args);
  };
  prototype.writeFile = async function (bytes, ...args) {
    if (bytes instanceof Uint8Array) { maxWrite = Math.max(maxWrite, bytes.length); assert.ok(bytes.length <= 65_536); }
    return await originalWrite.call(this, bytes, ...args);
  };
  try {
    const capability = await spool.ingest((async function* () { for (let index = 0; index < count; index++) yield part; })(), expected);
    await withCmsJournal(config, authority, async (context) => { await stage(context, capability); });
    await spool.dispose();
    await withCmsJournal(config, authority, async (context) => {
      const saved = context.snapshot().transaction.files[0];
      assert.equal(saved.after_bytes, expected.bytes); assert.equal(saved.after_sha256, expected.sha256);
      await context.apply(transactionId);
    });
    assert.deepEqual(await hashFile(path.join(config.nativeRoot, "article.md")), expected);
    assert.ok(maxRead > 0 && maxRead <= 65_536); assert.ok(maxWrite > 0 && maxWrite <= 65_536);
  } finally { prototype.readFile = originalReadFile; prototype.read = originalRead; prototype.writeFile = originalWrite; }
  assert.ok((await readFile(path.join(config.journalRoot, `${mappingId}.json`))).length < 100_000);
});

test("staged durable payload corruption and foreign native CAS results refuse commit", async (t) => {
  const config = await fixture(t), spool = await createCmsPayloadSpool(config), bytes = Buffer.from("durable full bytes");
  const capability = await spool.ingest(chunks(bytes), { sha256: sha(bytes), bytes: bytes.length });
  await withCmsJournal(config, authority, async (context) => {
    await stage(context, capability); await spool.dispose();
    const relative = context.snapshot().transaction.files[0].after_payload;
    const payload = path.join(config.journalRoot, ...relative.split("/"));
    await writeFile(payload, "corrupt durable payload");
    await assert.rejects(context.apply(transactionId), /snapshot bytes changed/u);
    await assert.rejects(readFile(path.join(config.nativeRoot, "article.md")), { code: "ENOENT" });
    await writeFile(payload, bytes); await mkdir(config.nativeRoot, { recursive: true });
    await writeFile(path.join(config.nativeRoot, "article.md"), "unowned native edit");
    await assert.rejects(context.apply(transactionId), /needs reconciliation/u);
    assert.equal(await readFile(path.join(config.nativeRoot, "article.md"), "utf8"), "unowned native edit");
  });
});

test("worker death after partial application recovers from durable files after external spool removal", async (t) => {
  const config = await fixture(t);
  const journalUrl = new URL("../src/cms-journal.mjs", import.meta.url).href;
  const spoolUrl = new URL("../src/cms-payload-spool.mjs", import.meta.url).href;
  const data = "crash-owned complete UTF-8 😃\n";
  const script = `import { withCmsJournal } from ${JSON.stringify(journalUrl)};
    import { createCmsPayloadSpool } from ${JSON.stringify(spoolUrl)};
    const config=${JSON.stringify(config)}; const bytes=Buffer.from(${JSON.stringify(data)});
    const spool=await createCmsPayloadSpool(config);
    const capability=await spool.ingest((async function*(){yield bytes;})(),${JSON.stringify({ sha256: sha(data), bytes: Buffer.byteLength(data) })});
    await withCmsJournal(config,${JSON.stringify(authority)},async(context)=>{
      await context.stage({transactionId:${JSON.stringify(transactionId)},action:'publish_revision',receipt:${JSON.stringify(receipt())},files:[
        {path:'article.md',bytes:capability,expectedSha256:null},{path:'other.txt',bytes:Buffer.from('recovered second file'),expectedSha256:null}]});
      await context.apply(${JSON.stringify(transactionId)},{afterFile:()=>process.exit(77)});
    });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (bytes) => { stderr += bytes.toString(); });
  const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
  assert.deepEqual(status, { code: 77, signal: null }, stderr);
  assert.equal(path.dirname(config.spoolParent), config.root); assert.equal(path.basename(config.spoolParent), "private-spool");
  await rm(config.spoolParent, { recursive: true, force: true }); // This isolated child's known fixture only.
  await withCmsJournal(config, authority, async (context) => { await context.apply(transactionId); });
  assert.equal(await readFile(path.join(config.nativeRoot, "article.md"), "utf8"), data);
  assert.equal(await readFile(path.join(config.nativeRoot, "other.txt"), "utf8"), "recovered second file");
});
