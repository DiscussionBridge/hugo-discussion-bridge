import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { link, lstat, mkdir, open, readFile, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { cmsCanonicalToken, cmsOpaque, cmsUrl, cmsUuid, hashCmsOwnershipReceipt, validateCmsOwnershipReceipt } from "./cms-ownership.mjs";
import { cmsPayloadFileInfo, copyCmsPayloadFile } from "./cms-payload-spool.mjs";

const SCHEMA = "db-hugo-cms-journal-2";
const HASH = /^[a-f0-9]{64}$/u;
const same = (a, b) => semantic(a) === semantic(b);
const digest = (bytes) => bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
const semantic = (value) => JSON.stringify(value, (_, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : child);

function requireAuthority(value) {
  const fields = ["work_id", "lease_generation", "source_revision", "policy_revision"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length
      || fields.some((field) => !Object.hasOwn(value, field)) || !cmsUuid(value.work_id)
      || !Number.isSafeInteger(value.lease_generation) || value.lease_generation < 1
      || (value.source_revision !== null && !cmsOpaque(value.source_revision, 128)) || !cmsOpaque(value.policy_revision, 128)) {
    throw new Error("CMS journal requires secret-free exact lease authority.");
  }
}

function assertSecretFree(value) {
  if (Array.isArray(value)) { for (const child of value) assertSecretFree(child); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:lease_token|connection_secret|secret|credentials|authorization)$/iu.test(key)) throw new Error("CMS journal cannot store credentials.");
    assertSecretFree(child);
  }
}

function exactFields(value, fields) {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function instant(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validateRepresentation(value) {
  if (value?.kind === "full") return exactFields(value, ["kind", "source_content_sha256"]) && HASH.test(value.source_content_sha256);
  return value?.kind === "native_excerpt" && exactFields(value, ["kind", "source_content_sha256", "native_limit_bytes", "native_constraint_code", "read_more_url"])
    && HASH.test(value.source_content_sha256) && Number.isSafeInteger(value.native_limit_bytes) && value.native_limit_bytes > 0
    && cmsOpaque(value.native_constraint_code) && cmsUrl(value.read_more_url);
}

function validateMutationPayload(operation, payload, transaction) {
  const common = ["mutation_id", "authority", "transaction_id"];
  const keys = operation === "prepare" ? [...common, "native_result", "prepared_at"]
    : operation === "finalize" ? [...common, "deployment_id", "deployed_at", "verification"]
      : [...common, "native_restored", "safe_detail"];
  if (!exactFields(payload, keys)) throw new Error("CMS request does not match the approved static wire fields.");
  const receipt = transaction.receipt;
  if (operation === "prepare") {
    const result = payload.native_result;
    const resultKeys = ["kind", "native_id", "external_id", "canonical_url", "native_revision", "ownership_receipt_sha256"];
    if (transaction.action === "publish_revision") resultKeys.push("representation");
    if (!exactFields(result, resultKeys) || result.kind !== transaction.action || result.native_id !== receipt.native_id
        || result.external_id !== receipt.external_id || result.canonical_url !== receipt.canonical_url
        || (result.native_revision !== null && !cmsOpaque(result.native_revision, 128))
        || result.ownership_receipt_sha256 !== hashCmsOwnershipReceipt(receipt) || !instant(payload.prepared_at)
        || (result.kind === "publish_revision" && !validateRepresentation(result.representation))) throw new Error("CMS preparation native result is invalid.");
  } else if (operation === "finalize") {
    const verification = payload.verification;
    const published = transaction.action === "publish_revision";
    const proofKeys = published ? ["kind", "url", "native_id", "source_revision", "source_content_sha256", "native_publication_sha256", "verification_profile", "checked_at", "representation"]
      : ["kind", "url", "native_id", "checked_at", "http_status"];
    if (!cmsOpaque(payload.deployment_id) || !instant(payload.deployed_at) || !exactFields(verification, proofKeys)
        || verification.kind !== (published ? "published" : "absent") || verification.url !== receipt.canonical_url
        || verification.native_id !== receipt.native_id || !instant(verification.checked_at)
        || verification.checked_at < payload.deployed_at || verification.checked_at < transaction.prepared_at
        || (published ? verification.source_revision !== receipt.source_revision || !HASH.test(verification.source_content_sha256)
          || !HASH.test(verification.native_publication_sha256) || !cmsOpaque(verification.verification_profile)
          || !validateRepresentation(verification.representation) || !same(verification.representation, transaction.native_result.representation)
          || verification.source_content_sha256 !== transaction.native_result.representation.source_content_sha256
          : ![404, 410].includes(verification.http_status))) throw new Error("CMS finalization public report is invalid.");
  } else if (typeof payload.native_restored !== "boolean" || (payload.safe_detail !== null && !cmsOpaque(payload.safe_detail, 200))) {
    throw new Error("CMS abort report is invalid.");
  }
}

async function safeAncestors(target) {
  const resolved = path.resolve(target);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("CMS paths must not follow symbolic links."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function durableDirectory(directory) {
  await safeAncestors(directory);
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!created) return;
  // Windows recursive mkdir returns an extended \\?\ path; directory fsync is
  // unavailable there, so do not compare that spelling in the POSIX walk.
  if (process.platform === "win32") { await safeAncestors(directory); return; }
  let current = path.resolve(directory);
  while (true) {
    await syncDirectory(current);
    if (current === path.resolve(created)) break;
    current = path.dirname(current);
  }
  await syncDirectory(path.dirname(created));
  await safeAncestors(directory);
}

async function readRegular(file) {
  await safeAncestors(file);
  let stat;
  try { stat = await lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("CMS target must be an unlinked regular file.");
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("CMS target changed while opening.");
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function openRegular(file) {
  await safeAncestors(file);
  let stat;
  try { stat = await lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("CMS target must be an unlinked regular file.");
  const handle = await open(file, "r");
  const opened = await handle.stat();
  if (opened.dev !== stat.dev || opened.ino !== stat.ino) { await handle.close(); throw new Error("CMS target changed while opening."); }
  return handle;
}

async function fileFingerprint(file) {
  const handle = await openRegular(file);
  if (handle === null) return { sha256: null, bytes: null };
  try {
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk); bytes += chunk.length;
      if (!Number.isSafeInteger(bytes)) throw new Error("CMS native byte counter exhausted.");
    }
    return { sha256: hash.digest("hex"), bytes };
  } finally { await handle.close(); }
}

async function writeSource(handle, source) {
  if (!Buffer.isBuffer(source) && source?.privateCapability) return await copyCmsPayloadFile(source.privateCapability, handle, source.binding);
  let input;
  try {
    if (Buffer.isBuffer(source)) input = [source];
    else {
      const opened = await openRegular(source.payloadFile);
      if (opened === null) throw new Error("CMS native snapshot payload is unavailable.");
      input = opened.createReadStream({ autoClose: true });
    }
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of input) {
      hash.update(chunk); bytes += chunk.length;
      if (!Number.isSafeInteger(bytes)) throw new Error("CMS native byte counter exhausted.");
      await handle.writeFile(chunk);
    }
    const sha256 = hash.digest("hex");
    if (!Buffer.isBuffer(source) && sha256 !== source.sha256) throw new Error("CMS private snapshot bytes changed; native commit refused.");
    return { sha256, bytes };
  } finally { if (input && !Array.isArray(input)) input.destroy(); }
}

async function immutablePayload(file, source, expectedSha256, expectedBytes) {
  await durableDirectory(path.dirname(file));
  const existing = await fileFingerprint(file);
  if (existing.sha256 !== null) {
    if (existing.sha256 !== expectedSha256 || (expectedBytes !== undefined && existing.bytes !== expectedBytes)) throw new Error("CMS immutable native snapshot conflicts.");
    return existing;
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    const fingerprint = await writeSource(handle, source);
    if (fingerprint.sha256 !== expectedSha256 || (expectedBytes !== undefined && fingerprint.bytes !== expectedBytes)) throw new Error("CMS snapshot source changed during staging.");
    await handle.sync(); await handle.close(); handle = undefined;
    await safeAncestors(file); await link(temporary, file); await syncDirectory(path.dirname(file));
    return fingerprint;
  } finally { await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
}

async function replaceRegular(file, contents, expected) {
  await durableDirectory(path.dirname(file));
  if ((await fileFingerprint(file)).sha256 !== expected) throw new Error("CMS native file changed before commit.");
  if (contents === null) {
    if (expected !== null) await rm(file);
    await syncDirectory(path.dirname(file));
    return;
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await writeSource(handle, contents); await handle.sync(); await handle.close(); handle = undefined;
    await safeAncestors(file);
    if ((await fileFingerprint(file)).sha256 !== expected) throw new Error("CMS native file changed during commit.");
    if (expected === null) await link(temporary, file);
    else await rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally { await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
}

function nativePath(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.includes("\\")
      || relative.split("/").some((part) => !part || part === "." || part === ".." || /[\p{Cc}:]/u.test(part))) throw new Error("CMS native relative path is invalid.");
  const resolved = path.resolve(root, ...relative.split("/"));
  const inside = path.relative(root, resolved);
  if (!inside || inside.startsWith(`..${path.sep}`) || inside === ".." || path.isAbsolute(inside)) throw new Error("CMS native path escapes its root.");
  return resolved;
}

function validateFileSnapshots(files, mappingId) {
  if (!Array.isArray(files) || !files.length) throw new Error("CMS transaction files are invalid.");
  const names = new Set();
  for (const file of files) {
    if (!exactFields(file, ["path", "before_payload", "before_sha256", "before_bytes", "after_payload", "after_sha256", "after_bytes"])) throw new Error("CMS file snapshot fields are invalid.");
    nativePath(path.resolve("."), file.path);
    const key = process.platform === "win32" ? file.path.toLowerCase() : file.path;
    if (names.has(key)) throw new Error("CMS transaction contains duplicate paths.");
    names.add(key);
    for (const side of ["before", "after"]) {
      const payload = file[`${side}_payload`], hash = file[`${side}_sha256`], bytes = file[`${side}_bytes`];
      if (payload === null) {
        if (hash !== null || bytes !== null) throw new Error("CMS absent file snapshot is invalid.");
      } else {
        nativePath(path.resolve("."), payload);
        const parts = payload.split("/");
        if (parts.length !== 4 || parts[0] !== ".payloads" || parts[1] !== mappingId || !cmsUuid(parts[2])
            || !/^(?:0|[1-9][0-9]*)-(?:before|after)\.bin$/u.test(parts[3]) || !HASH.test(hash)
            || !Number.isSafeInteger(bytes) || bytes < 0 || Object.is(bytes, -0)) throw new Error("CMS private file snapshot is invalid.");
      }
    }
  }
}

function validateJournal(value, mappingId) {
  assertSecretFree(value);
  if (!exactFields(value, ["schema_version", "mapping_id", "last_lease_generation", "authority", "transaction", "last_verified", "pending_mutation"])
      || value.schema_version !== SCHEMA || value.mapping_id !== mappingId
      || !Number.isSafeInteger(value.last_lease_generation) || value.last_lease_generation < 0
      || !Object.hasOwn(value, "transaction") || !Object.hasOwn(value, "last_verified") || !Object.hasOwn(value, "pending_mutation")) throw new Error("CMS journal is invalid.");
  if (value.authority !== null) { requireAuthority(value.authority); if (value.authority.lease_generation !== value.last_lease_generation) throw new Error("CMS journal fence is invalid."); }
  else if (value.last_lease_generation !== 0) throw new Error("CMS journal fence is invalid.");
  const transaction = value.transaction;
  if (transaction !== null) {
    if (!cmsUuid(transaction.transaction_id) || !["publish_revision", "withdraw"].includes(transaction.action)
        || !["staged", "applied", "verified", "restored", "attention"].includes(transaction.phase)
        || typeof transaction.receiver_prepared !== "boolean"
        || !Array.isArray(transaction.files) || transaction.files.length < 1) throw new Error("CMS transaction is invalid.");
    requireAuthority(transaction.authority); validateCmsOwnershipReceipt(transaction.receipt);
    if (transaction.receipt.mapping_id !== mappingId || transaction.receipt.last_lease_generation !== transaction.authority.lease_generation
        || transaction.receipt.source_revision !== transaction.authority.source_revision
        || (transaction.action === "publish_revision") !== (transaction.authority.source_revision !== null)) throw new Error("CMS transaction receipt is invalid.");
    validateFileSnapshots(transaction.files, mappingId);
  }
  if (value.last_verified !== null) {
    const verified = value.last_verified;
    if (!verified || verified.phase !== "verified" || verified.receiver_prepared !== true || !cmsUuid(verified.transaction_id)
        || !instant(verified.prepared_at) || !Array.isArray(verified.files) || !verified.files.length) throw new Error("CMS prior verified state is invalid.");
    requireAuthority(verified.authority); validateCmsOwnershipReceipt(verified.receipt);
    if (verified.receipt.mapping_id !== mappingId || verified.receipt.last_lease_generation !== verified.authority.lease_generation) throw new Error("CMS verified ownership is invalid.");
    validateFileSnapshots(verified.files, mappingId);
  }
  if (value.pending_mutation !== null) {
    const pending = value.pending_mutation;
    requireAuthority(pending.payload.authority);
    if (!cmsUuid(pending.payload.mutation_id) || !HASH.test(pending.token_sha256)
        || !["prepare", "finalize", "abort"].includes(pending.operation)
        || pending.payload.transaction_id !== transaction?.transaction_id) throw new Error("CMS pending mutation is invalid.");
    validateMutationPayload(pending.operation, pending.payload, transaction);
  }
  return value;
}

async function captureNative(program, args) {
  const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  return await new Promise((resolve) => {
    let output = ""; let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill(); finish(null); }, 5000);
    child.stdout.on("data", (bytes) => { output += bytes.toString("utf8"); if (output.length > 4096) { child.kill(); finish(null); } });
    child.stderr.resume(); child.once("error", () => finish(null));
    child.once("exit", (code) => { if (code !== 0) finish(null); else { try { finish(JSON.parse(output)); } catch { finish(null); } } });
  });
}

async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 1 || pid > 2147483647) return { state: "unknown" };
  if (process.platform === "linux") {
    try {
      const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      if (!cmsUuid(boot)) return { state: "unknown" };
      let stat;
      try { stat = await readFile(`/proc/${pid}/stat`, "utf8"); }
      catch (error) { return { state: error.code === "ENOENT" ? "absent" : "unknown" }; }
      const end = stat.lastIndexOf(")");
      const start = stat.slice(end + 2).split(" ")[19];
      if (end < 0 || !/^[0-9]+$/u.test(start)) return { state: "unknown" };
      return { state: "present", identity: { platform: "linux", pid, start, boot, uid: process.getuid() } };
    } catch { return { state: "unknown" }; }
  }
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);
      try { $nativeProcess=[System.Diagnostics.Process]::GetProcessById(${pid}); $start=$nativeProcess.StartTime.ToUniversalTime().Ticks.ToString();
        @{state='present';identity=@{platform='win32';pid=${pid};start=$start}} | ConvertTo-Json -Compress }
      catch [System.ArgumentException] { @{state='absent'} | ConvertTo-Json -Compress }
      catch { @{state='unknown'} | ConvertTo-Json -Compress }`;
    return await captureNative("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]) ?? { state: "unknown" };
  }
  return { state: "unknown" };
}

async function ownerDisposition(owner) {
  if (!owner || owner.lock_version !== "db-native-lock-2" || !cmsUuid(owner.lock_nonce)
      || owner.process_identity?.platform !== process.platform || owner.owner_pid !== owner.process_identity?.pid
      || !/^[0-9]+$/u.test(owner.process_identity?.start ?? "")
      || (process.platform === "linux" && (owner.process_identity.uid !== process.getuid() || !cmsUuid(owner.process_identity.boot)))) return "unknown";
  const current = await processIdentity(owner.owner_pid);
  if (current.state === "absent") return "dead";
  if (current.state !== "present") return "unknown";
  return same(current.identity, owner.process_identity) ? "alive" : "unknown"; // PID reuse never authorizes takeover.
}

async function nativeOsLock(lockFile) {
  await safeAncestors(lockFile);
  let file;
  try { file = await open(lockFile, "wx", 0o600); await file.sync(); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  finally { await file?.close(); }
  const stat = await lstat(lockFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("CMS native OS lock file must be an unlinked regular file.");
  let program, args;
  if (process.platform === "linux") {
    const helper = `process.stdout.write('{"state":"locked"}\\n'); process.stdin.setEncoding('utf8'); let buffer='';
      process.stdin.on('data', (data)=>{ buffer+=data; while(buffer.includes('\\n')) {const end=buffer.indexOf('\\n');const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line==='probe')process.stdout.write('{"state":"held"}\\n');} });
      process.stdin.on('end',()=>process.exit(0));`;
    program = "/usr/bin/flock";
    args = ["--exclusive", "--nonblock", "--conflict-exit-code", "73", "--", lockFile, process.execPath, "--input-type=module", "-e", helper];
  } else if (process.platform === "win32") {
    const encodedPath = Buffer.from(lockFile, "utf8").toString("base64");
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);
      $nativeLockPath=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'));
      try { $nativeStream=[System.IO.File]::Open($nativeLockPath,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None) }
      catch { [Console]::WriteLine('{"state":"busy"}'); exit 73 }
      try { [Console]::WriteLine('{"state":"locked"}'); while($null -ne ($line=[Console]::ReadLine())) {if($line -eq 'probe'){[Console]::WriteLine('{"state":"held"}')}} }
      finally { $nativeStream.Dispose() }`;
    program = "powershell.exe"; args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  } else throw new Error("CMS native OS locking is unavailable on this unqualified platform.");
  const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = [], waiting = []; let buffer = "", ended = false;
  const fail = () => { ended = true; for (const pending of waiting.splice(0)) pending.reject(new Error("CMS mapping is locked or its native OS lock helper is unavailable.")); };
  child.stdin.on("error", fail); // Helper death between probe/check and write must reject safely, not crash the worker on EPIPE.
  child.stderr.resume(); child.once("error", fail); child.once("exit", fail);
  child.stdout.on("data", (data) => {
    buffer += data.toString("utf8");
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"); const value = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (waiting.length) waiting.shift().resolve(value); else lines.push(value);
    }
  });
  const nextLine = () => {
    if (lines.length) return Promise.resolve(lines.shift());
    if (ended) return Promise.reject(new Error("CMS mapping is locked or its native OS lock helper is unavailable."));
    return new Promise((resolve, reject) => {
      const item = { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => { const index = waiting.indexOf(item); if (index >= 0) waiting.splice(index, 1); reject(new Error("CMS native OS lock helper response timed out.")); }, 5000);
      waiting.push(item);
    });
  };
  const release = async () => {
    child.stdin.end();
    if (ended) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 2000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  };
  try {
    if (JSON.parse(await nextLine()).state !== "locked") throw new Error("CMS mapping is locked by a native OS handle.");
  } catch (error) { await release(); throw error; }
  return {
    async assertHeld() {
      if (ended || child.exitCode !== null || child.signalCode !== null) throw new Error("CMS native OS lock ownership is unavailable.");
      child.stdin.write("probe\n");
      if (JSON.parse(await nextLine()).state !== "held") throw new Error("CMS native OS lock ownership is unavailable.");
    }, release,
  };
}

export async function withCmsJournal({ journalRoot, nativeRoot, mappingId }, authority, action) {
  requireAuthority(authority);
  if (!cmsUuid(mappingId)) throw new Error("CMS mapping ID is invalid.");
  journalRoot = path.resolve(journalRoot); nativeRoot = path.resolve(nativeRoot);
  if (/(?:^|[\\/])(?:public|static|assets)(?:[\\/]|$)/iu.test(journalRoot)) throw new Error("CMS journal must stay outside public output directories.");
  if (journalRoot === nativeRoot || !path.relative(nativeRoot, journalRoot).startsWith("..")) throw new Error("CMS journal must stay outside the native publication root.");
  await durableDirectory(journalRoot); await safeAncestors(nativeRoot);
  const journalFile = path.join(journalRoot, `${mappingId}.json`);
  const lockPath = path.join(journalRoot, `${mappingId}.lock`);
  const ownerFile = path.join(lockPath, "owner.json");
  let locked = false;
  let ownerHash = null;
  const osLock = await nativeOsLock(path.join(journalRoot, `${mappingId}.os-lock`));
  try {
    await osLock.assertHeld();
    const ownIdentity = await processIdentity(process.pid);
    if (ownIdentity.state !== "present") throw new Error("CMS native process start identity is unavailable; locking needs attention.");
    try { await mkdir(lockPath, { mode: 0o700 }); locked = true; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const oldBytes = await readRegular(ownerFile);
      let oldOwner; try { oldOwner = JSON.parse(oldBytes?.toString("utf8") ?? "null"); } catch { oldOwner = null; }
      if (await ownerDisposition(oldOwner) !== "dead") throw new Error("CMS mapping is locked; live, reused or unknown owner needs attention.");
      await osLock.assertHeld();
      if (digest(await readRegular(ownerFile)) !== digest(oldBytes)) throw new Error("CMS abandoned owner changed; recovery refused.");
      await rm(ownerFile); await rmdir(lockPath); await syncDirectory(journalRoot);
      await mkdir(lockPath, { mode: 0o700 }); locked = true;
    }
    const ownerBytes = Buffer.from(JSON.stringify({ lock_version: "db-native-lock-2", lock_nonce: randomUUID(), owner_pid: process.pid,
      process_identity: ownIdentity.identity }));
    await replaceRegular(ownerFile, ownerBytes, null); ownerHash = digest(ownerBytes);
    await syncDirectory(journalRoot);
    const bytes = await readRegular(journalFile);
    const state = bytes === null ? { schema_version: SCHEMA, mapping_id: mappingId, last_lease_generation: 0, authority: null, transaction: null, last_verified: null, pending_mutation: null }
      : validateJournal(JSON.parse(bytes.toString("utf8")), mappingId);
    let journalHash = digest(bytes);
    const save = async () => {
      validateJournal(state, mappingId);
      const output = Buffer.from(`${JSON.stringify(state)}\n`);
      await replaceRegular(journalFile, output, journalHash); journalHash = digest(output);
    };
    if (authority.lease_generation < state.last_lease_generation
        || (authority.lease_generation === state.last_lease_generation && !same(authority, state.authority))) throw new Error("CMS native fencing generation is stale or conflicts.");
    state.last_lease_generation = authority.lease_generation; state.authority = structuredClone(authority);
    await save();
    const assertFence = async () => {
      await osLock.assertHeld();
      const current = await readRegular(journalFile);
      if (digest(current) !== journalHash || digest(await readRegular(ownerFile)) !== ownerHash
          || !(await lstat(lockPath)).isDirectory()) throw new Error("CMS native lock or durable fence changed.");
    };
    const context = {
      snapshot: () => structuredClone(state),
      async stage({ transactionId, action: workAction, receipt, files }) {
        await assertFence(); validateCmsOwnershipReceipt(receipt);
        if (!cmsUuid(transactionId) || !["publish_revision", "withdraw"].includes(workAction)
            || receipt.mapping_id !== mappingId || receipt.last_lease_generation !== authority.lease_generation
            || receipt.source_revision !== authority.source_revision || (workAction === "publish_revision") !== (authority.source_revision !== null)
            || !Array.isArray(files) || !files.length) throw new Error("CMS staged identity or authority is invalid.");
        if (state.pending_mutation !== null) throw new Error("CMS pending mutation must be reconciled before changing transaction authority.");
        if (state.transaction && !["verified", "restored"].includes(state.transaction.phase)) throw new Error("CMS open transaction requires reconciliation.");
        if (state.transaction && !same(stableBinding(state.transaction.receipt), stableBinding(receipt))) throw new Error("CMS reserved native identity cannot change after an aborted preparation.");
        if (state.last_verified && !same(stableBinding(state.last_verified.receipt), stableBinding(receipt))) throw new Error("CMS verified native identity cannot change during a normal revision.");
        if (workAction === "withdraw" && state.last_verified === null) throw new Error("CMS withdrawal requires previously owned verified native identity.");
        const snapshots = [];
        for (const [index, file] of files.entries()) {
          const target = nativePath(nativeRoot, file.path), before = await fileFingerprint(target);
          if (file.expectedSha256 !== before.sha256) throw new Error("CMS staged native revision does not match.");
          if (before.sha256 !== null && !state.last_verified?.files?.some((prior) => prior.path === file.path && prior.after_sha256 === before.sha256)) throw new Error("CMS existing native file has no verified journal ownership; explicit adoption is required.");
          const binding = { nativeRoot, journalRoot, mappingId };
          const payload = file.bytes !== null && !Buffer.isBuffer(file.bytes)
            ? await cmsPayloadFileInfo(file.bytes, binding) : null;
          const beforePayload = before.sha256 === null ? null : `.payloads/${mappingId}/${transactionId}/${index}-before.bin`;
          const afterPayload = file.bytes === null ? null : `.payloads/${mappingId}/${transactionId}/${index}-after.bin`;
          if (beforePayload !== null) await immutablePayload(nativePath(journalRoot, beforePayload), { payloadFile: target, sha256: before.sha256 }, before.sha256);
          const after = file.bytes === null ? { sha256: null, bytes: null } : await immutablePayload(
            nativePath(journalRoot, afterPayload), payload ? { privateCapability: file.bytes, binding } : file.bytes,
            payload ? payload.sha256 : digest(file.bytes), payload?.bytes
          );
          snapshots.push({ path: file.path, before_payload: beforePayload, before_sha256: before.sha256, before_bytes: before.bytes,
            after_payload: afterPayload, after_sha256: after.sha256, after_bytes: after.bytes });
        }
        state.transaction = { transaction_id: transactionId, action: workAction, authority: structuredClone(authority), receipt: structuredClone(receipt), phase: "staged", receiver_prepared: false, prior_verified: structuredClone(state.last_verified), files: snapshots };
        await save(); return context.snapshot();
      },
      async rebind(transactionId, receipt) {
        await assertFence(); validateCmsOwnershipReceipt(receipt);
        const transaction = state.transaction;
        if (!transaction || transaction.transaction_id !== transactionId || !["staged", "applied"].includes(transaction.phase)
            || transaction.authority.source_revision !== authority.source_revision || transaction.authority.policy_revision !== authority.policy_revision
            || transaction.authority.work_id !== authority.work_id || state.pending_mutation !== null
            || !same({ ...transaction.receipt, last_lease_generation: receipt.last_lease_generation }, receipt)
            || receipt.last_lease_generation !== authority.lease_generation) throw new Error("CMS prepared transaction cannot be rebound without exact reconciled identity.");
        for (const file of transaction.files) {
          const current = (await fileFingerprint(nativePath(nativeRoot, file.path))).sha256;
          if (current !== file.before_sha256 && current !== file.after_sha256) throw new Error("CMS prepared native file needs reconciliation.");
        }
        transaction.authority = structuredClone(authority); transaction.receipt = structuredClone(receipt);
        transaction.receiver_prepared = false; // A replacement generation must repeat prepare before finalize/abort.
        await save(); return context.snapshot();
      },
      async apply(transactionId, { afterFile } = {}) {
        await assertFence();
        const transaction = currentTransaction(state, transactionId, authority);
        if (!["staged", "applied"].includes(transaction.phase)) throw new Error("CMS transaction cannot apply in this state.");
        for (const file of transaction.files) {
          await assertFence();
          const target = nativePath(nativeRoot, file.path), current = (await fileFingerprint(target)).sha256;
          if (current !== file.after_sha256) {
            if (current !== file.before_sha256) throw new Error("CMS native file needs reconciliation; staged write refused.");
            await replaceRegular(target, file.after_payload === null ? null : { payloadFile: nativePath(journalRoot, file.after_payload), sha256: file.after_sha256 }, current);
          }
          await afterFile?.(file.path);
        }
        transaction.phase = "applied"; await save(); return context.snapshot();
      },
      async restore(transactionId) {
        await assertFence();
        const transaction = currentTransaction(state, transactionId, authority);
        if (transaction.phase === "verified") throw new Error("CMS verified transaction cannot abort.");
        for (const file of transaction.files) {
          await assertFence();
          const target = nativePath(nativeRoot, file.path), current = (await fileFingerprint(target)).sha256;
          if (current !== file.before_sha256) {
            if (current !== file.after_sha256) throw new Error("CMS native restore requires reconciliation; changed local file retained.");
            await replaceRegular(target, file.before_payload === null ? null : { payloadFile: nativePath(journalRoot, file.before_payload), sha256: file.before_sha256 }, current);
          }
        }
        transaction.phase = "restored"; state.last_verified = structuredClone(transaction.prior_verified);
        await save(); return { native_restored: true, previous_verified: structuredClone(state.last_verified) };
      },
      async queueMutation(operation, payload, leaseToken) {
        await assertFence(); assertSecretFree(payload);
        const transaction = currentTransaction(state, payload?.transaction_id, authority);
        if (!cmsCanonicalToken(leaseToken) || !cmsUuid(payload?.mutation_id) || !same(payload.authority, authority)
            || !["prepare", "finalize", "abort"].includes(operation)) throw new Error("CMS pending request is invalid.");
        if (operation === "prepare" && transaction.phase !== "applied") throw new Error("CMS prepare requires a durable applied native stage.");
        if (operation === "finalize" && (!transaction.receiver_prepared || transaction.phase !== "applied")) throw new Error("CMS finalize requires receiver-accepted exact preparation.");
        if (operation === "abort" && (!transaction.receiver_prepared || transaction.phase === "verified"
            || (payload.native_restored === true && transaction.phase !== "restored"))) throw new Error("CMS abort requires accepted preparation and truthful restoration.");
        validateMutationPayload(operation, payload, transaction);
        if (JSON.stringify(payload).includes(leaseToken)) throw new Error("CMS journal cannot store a lease credential in payload values.");
        const pending = { operation, payload: structuredClone(payload), token_sha256: digest(Buffer.from(leaseToken, "utf8")) };
        if (state.pending_mutation !== null && !same(state.pending_mutation, pending)) throw new Error("CMS pending mutation identity/payload cannot change before reconciliation.");
        state.pending_mutation = pending; await save(); return context.pendingRequest(leaseToken);
      },
      pendingRequest(leaseToken) {
        if (!state.pending_mutation || !cmsCanonicalToken(leaseToken)
            || digest(Buffer.from(leaseToken, "utf8")) !== state.pending_mutation.token_sha256) throw new Error("CMS original pending credential is unavailable; reconcile receiver status before another mutation.");
        const pending = structuredClone(state.pending_mutation);
        pending.payload.authority.lease_token = leaseToken;
        return { operation: pending.operation, payload: pending.payload };
      },
      async acceptMutation(mutationId, receiverResponse) {
        await assertFence();
        const pending = state.pending_mutation;
        assertSecretFree(receiverResponse);
        const receiverState = receiverResponse?.work?.state;
        const responseAuthority = receiverResponse?.work;
        const responseMapping = receiverResponse?.mapping;
        if (!pending || pending.payload.mutation_id !== mutationId || !exactFields(receiverResponse, ["work", "mapping", "lease_expires_at"])
            || !same(pending.payload.authority, { work_id: responseAuthority?.work_id, lease_generation: responseAuthority?.lease_generation,
              source_revision: responseAuthority?.source_revision, policy_revision: responseAuthority?.policy_revision })
            || responseAuthority?.mapping_id !== mappingId || responseAuthority?.action !== state.transaction.action
            || responseMapping?.mapping_id !== mappingId || responseMapping?.resource_id !== state.transaction.receipt.resource_id
            || responseMapping?.connection_id !== state.transaction.receipt.connection_id || responseMapping?.external_id !== state.transaction.receipt.external_id
            || responseMapping?.destination_native_id !== state.transaction.receipt.native_id || responseMapping?.canonical_url !== state.transaction.receipt.canonical_url
            || (pending.operation === "prepare" && receiverState !== "synchronized")
            || (pending.operation === "finalize" && receiverState !== "verified")
            || (pending.operation === "abort" && receiverState !== "attention")) throw new Error("CMS mutation receipt does not match the pending stage and owned binding.");
        if (pending.operation === "finalize") {
          state.transaction.phase = "verified";
          state.transaction.finalize_report = structuredClone(pending.payload);
          state.transaction.finalize_receiver_receipt = structuredClone(receiverResponse);
          state.last_verified = structuredClone(state.transaction);
          delete state.last_verified.prior_verified;
        }
        if (pending.operation === "prepare") {
          state.transaction.receiver_prepared = true;
          state.transaction.prepared_at = pending.payload.prepared_at;
          state.transaction.native_result = structuredClone(pending.payload.native_result);
          state.transaction.prepare_receiver_receipt = structuredClone(receiverResponse);
        }
        if (pending.operation === "abort") {
          if (pending.payload.native_restored === false) state.transaction.phase = "attention";
          state.transaction.abort_report = structuredClone(pending.payload);
          state.transaction.abort_receiver_receipt = structuredClone(receiverResponse);
        }
        state.pending_mutation = null; await save(); return context.snapshot();
      },
      ownershipHash: () => state.transaction ? hashCmsOwnershipReceipt(state.transaction.receipt) : null,
    };
    return await action(context);
  } finally {
    try { if (locked) {
      if (ownerHash !== null) {
        if (digest(await readRegular(ownerFile)) !== ownerHash) throw new Error("CMS lock ownership changed; another owner's lock is retained.");
        await rm(ownerFile);
      }
      await rmdir(lockPath); await syncDirectory(journalRoot);
    } } finally { await osLock.release(); }
  }
}

function currentTransaction(state, transactionId, authority) {
  const transaction = state.transaction;
  if (!transaction || transaction.transaction_id !== transactionId || !same(transaction.authority, authority)) throw new Error("CMS transaction does not match the current native fence.");
  return transaction;
}

function stableBinding(receipt) {
  return Object.fromEntries(["schema_version", "forum_origin", "connection_id", "mapping_id", "resource_id", "source_id", "external_id", "native_id", "canonical_url"].map((field) => [field, receipt[field]]));
}
