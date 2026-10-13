import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { cmsUuid } from "./cms-ownership.mjs";

const CHUNK_BYTES = 32_768;
const HASH = /^[a-f0-9]{64}$/u;
const capabilities = new WeakMap();
const fields = ["dev", "ino", "nlink", "size", "mode", "uid", "mtimeNs", "ctimeNs", "birthtimeNs"];
const identity = (stat) => Object.fromEntries(fields.map((field) => [field, stat[field]]));
const sameIdentity = (left, right) => fields.every((field) => left[field] === right[field]);

function absolutePath(value) {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)
      || /[\p{Cc}\p{Cf}]/u.test(value) || value.split(/[\\/]/u).some((part) => part === "." || part === "..")) {
    throw new Error("CMS private spool requires explicit safe absolute roots.");
  }
  return path.resolve(value);
}

async function ancestors(target) {
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current, { bigint: true });
      if (stat.isSymbolicLink()) throw new Error("CMS private spool must not follow symbolic links.");
      if (current !== target && !stat.isDirectory()) throw new Error("CMS private spool ancestor is not a directory.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

async function canonicalRoot(value) {
  const target = absolutePath(value);
  await ancestors(target);
  const missing = [];
  let existing = target;
  while (true) {
    try { return path.join(await realpath(existing), ...missing.reverse()); }
    catch (error) {
      if (error.code !== "ENOENT" || path.dirname(existing) === existing) throw error;
      missing.push(path.basename(existing)); existing = path.dirname(existing);
    }
  }
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function directorySync(directory) {
  if (process.platform === "win32") return;
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

function ownedRegular(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
      || (process.platform !== "win32" && stat.uid !== BigInt(process.getuid()))) {
    throw new Error("CMS private payload requires the original singly linked owned regular file.");
  }
}

async function checkDirectory(state) {
  if (state.closed) throw new Error("CMS private payload capability has been disposed.");
  await ancestors(state.directory);
  const stat = await lstat(state.directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== state.directoryIdentity.dev
      || stat.ino !== state.directoryIdentity.ino
      || (process.platform !== "win32" && (stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o777n) !== 0o700n))) {
    throw new Error("CMS private spool ownership or directory identity changed.");
  }
  await ancestors(state.parent);
  const parent = await lstat(state.parent, { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== state.parentIdentity.dev
      || parent.ino !== state.parentIdentity.ino) throw new Error("CMS private spool parent identity changed.");
  for (const configured of state.policyRoots) {
    const root = await canonicalRoot(configured);
    if (contains(root, state.parent) || contains(state.parent, root)) {
      throw new Error("CMS private spool output-root policy changed.");
    }
  }
}

function decodeUtf8(decoder, bytes, stream = false) {
  try { return decoder.decode(bytes, { stream }); }
  catch { throw new Error("CMS private payload is not complete valid UTF-8."); }
}

async function checkedHandle(record) {
  await checkDirectory(record.state);
  const named = await lstat(record.file, { bigint: true });
  ownedRegular(named);
  if (!sameIdentity(named, record.identity)) throw new Error("CMS private payload was replaced or edited after verification.");
  const handle = await open(record.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    ownedRegular(opened);
    if (!sameIdentity(opened, record.identity)) throw new Error("CMS private payload changed while opening.");
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function checkUnchanged(record, handle) {
  await checkDirectory(record.state);
  const opened = await handle.stat({ bigint: true });
  const named = await lstat(record.file, { bigint: true });
  ownedRegular(opened); ownedRegular(named);
  if (!sameIdentity(opened, record.identity) || !sameIdentity(named, record.identity)) {
    throw new Error("CMS private payload changed during streaming.");
  }
}

async function scan(handle, expected, destination) {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const hash = createHash("sha256");
  let bytes = 0;
  while (true) {
    const result = await handle.read(buffer, 0, buffer.length, bytes);
    if (!result.bytesRead) break;
    if (bytes > Number.MAX_SAFE_INTEGER - result.bytesRead) throw new Error("CMS private payload byte counter exhausted.");
    const part = buffer.subarray(0, result.bytesRead);
    decodeUtf8(decoder, part, true); hash.update(part); bytes += part.length;
    if (bytes > expected.bytes) throw new Error("CMS private payload exceeded its verified byte count.");
    if (destination) await destination.writeFile(part);
  }
  decodeUtf8(decoder);
  const sha256 = hash.digest("hex");
  if (bytes !== expected.bytes || sha256 !== expected.sha256) throw new Error("CMS private payload complete hash or byte count changed.");
  return { sha256, bytes };
}

async function recordFor(capability, binding) {
  const record = capabilities.get(capability);
  if (!record) throw new Error("CMS staged bytes require a verified private payload capability, Buffer or null.");
  if (!binding || binding.mappingId !== record.state.mappingId
      || await canonicalRoot(binding.nativeRoot) !== record.state.nativeRoot
      || await canonicalRoot(binding.journalRoot) !== record.state.journalRoot) {
    throw new Error("CMS private payload capability belongs to a different native mapping or roots.");
  }
  return record;
}

// This factory is a trusted native-writer API, never a request-path importer.
// Public/native/journal roots and an existing owned private parent are explicit;
// no default directory/profile/namespace or externally supplied file is adopted.
export async function createCmsPayloadSpool({ spoolParent, nativeRoot, journalRoot, publicRoots, mappingId } = {}) {
  if (!cmsUuid(mappingId) || !Array.isArray(publicRoots) || !publicRoots.length) {
    throw new Error("CMS private spool requires explicit mapping and public-root policy.");
  }
  const parent = await canonicalRoot(spoolParent);
  const native = await canonicalRoot(nativeRoot), journal = await canonicalRoot(journalRoot);
  const excluded = await Promise.all(publicRoots.map(canonicalRoot));
  if ([native, journal, ...excluded].some((root) => contains(root, parent) || contains(parent, root))
      || /(?:^|[\\/])(?:public|static|assets)(?:[\\/]|$)/iu.test(parent)) {
    throw new Error("CMS private spool must be disjoint from native, journal and public output roots.");
  }
  const parentStat = await lstat(parent, { bigint: true });
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
      || (process.platform !== "win32" && (parentStat.uid !== BigInt(process.getuid()) || (parentStat.mode & 0o022n) !== 0n))) {
    throw new Error("CMS private spool parent is not an owned protected directory.");
  }
  const directory = await mkdtemp(path.join(parent, "db-cms-payload-"));
  const directoryStat = await lstat(directory, { bigint: true });
  const state = {
    parent, directory, parentIdentity: identity(parentStat), directoryIdentity: identity(directoryStat),
    nativeRoot: native, journalRoot: journal, mappingId, closed: false, records: [],
    policyRoots: [nativeRoot, journalRoot, ...publicRoots]
  };
  await checkDirectory(state); await directorySync(parent); await directorySync(directory);
  return Object.freeze({
    async ingest(chunks, expected) {
      await checkDirectory(state);
      if (!expected || typeof expected !== "object" || Object.keys(expected).length !== 2
          || !Object.hasOwn(expected, "sha256") || !Object.hasOwn(expected, "bytes") || !HASH.test(expected.sha256)
          || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || Object.is(expected.bytes, -0)
          || !chunks || typeof chunks[Symbol.asyncIterator] !== "function") {
        throw new Error("CMS private payload requires complete declared integrity and a byte stream.");
      }
      expected = Object.freeze({ sha256: expected.sha256, bytes: expected.bytes });
      const file = path.join(directory, `${randomUUID()}.bin`);
      let handle, created;
      try {
        handle = await open(file, "wx", 0o600);
        created = await handle.stat({ bigint: true }); ownedRegular(created);
        const hash = createHash("sha256"), decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0;
        for await (const chunk of chunks) {
          if (!(chunk instanceof Uint8Array)) throw new Error("CMS private payload stream must contain byte chunks.");
          for (let offset = 0; offset < chunk.byteLength; offset += CHUNK_BYTES) {
            const part = chunk.subarray(offset, offset + CHUNK_BYTES);
            if (bytes > Number.MAX_SAFE_INTEGER - part.length || bytes + part.length > expected.bytes) {
              throw new Error("CMS private payload exceeded its declared byte count.");
            }
            decodeUtf8(decoder, part, true); hash.update(part); bytes += part.length;
            await handle.writeFile(part);
          }
        }
        decodeUtf8(decoder);
        if (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256) {
          throw new Error("CMS private payload complete hash or byte count does not match.");
        }
        await checkDirectory(state);
        const named = await lstat(file, { bigint: true }); ownedRegular(named);
        if (named.dev !== created.dev || named.ino !== created.ino || named.size !== BigInt(bytes)) {
          throw new Error("CMS private payload was swapped during ingestion.");
        }
        await handle.chmod(0o400); await handle.sync();
        await handle.close(); handle = undefined; await directorySync(directory);
        const sealed = await lstat(file, { bigint: true }); ownedRegular(sealed);
        const record = { state, file, identity: identity(sealed), sha256: expected.sha256, bytes: expected.bytes };
        handle = await checkedHandle(record);
        await scan(handle, record); await checkUnchanged(record, handle);
        await handle.close(); handle = undefined;
        const capability = Object.freeze({ kind: "cms-private-payload-file", sha256: record.sha256, bytes: record.bytes });
        capabilities.set(capability, record); state.records.push(record);
        return capability;
      } catch (error) {
        await handle?.close().catch(() => {});
        // Remove only this factory's original inode, never a replacement/link.
        const directoryStillOwned = await checkDirectory(state).then(() => true, () => false);
        if (created && directoryStillOwned) {
          const current = await lstat(file, { bigint: true }).catch(() => null);
          if (current?.isFile() && !current.isSymbolicLink() && current.nlink === 1n
              && current.dev === created.dev && current.ino === created.ino) {
            const own = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            try {
              const opened = await own.stat({ bigint: true });
              if (opened.dev !== created.dev || opened.ino !== created.ino) throw new Error("CMS private spool cleanup ownership changed.");
              await own.chmod(0o600);
            } finally { await own.close(); }
            await rm(file); await directorySync(directory);
          }
        }
        throw error;
      }
    },
    async dispose() {
      await checkDirectory(state);
      for (const record of state.records) {
        const handle = await checkedHandle(record);
        try { await checkUnchanged(record, handle); await handle.chmod(0o600); }
        finally { await handle.close(); }
        await rm(record.file);
        state.records = state.records.filter((candidate) => candidate !== record);
      }
      await directorySync(directory); await rmdir(directory); await directorySync(parent);
      state.closed = true;
    }
  });
}

export async function cmsPayloadFileInfo(capability, binding) {
  const record = await recordFor(capability, binding);
  const handle = await checkedHandle(record);
  try { await checkUnchanged(record, handle); }
  finally { await handle.close(); }
  return Object.freeze({ sha256: record.sha256, bytes: record.bytes });
}

export async function copyCmsPayloadFile(capability, destination, binding) {
  const record = await recordFor(capability, binding);
  const handle = await checkedHandle(record);
  try {
    const result = await scan(handle, record, destination);
    await checkUnchanged(record, handle);
    return result;
  } finally { await handle.close(); }
}
