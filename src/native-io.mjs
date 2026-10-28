import { createHash } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";

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


function nativePath(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.includes("\\")
      || relative.split("/").some((part) => !part || part === "." || part === ".." || /[\p{Cc}:]/u.test(part))) throw new Error("CMS native relative path is invalid.");
  const resolved = path.resolve(root, ...relative.split("/"));
  const inside = path.relative(root, resolved);
  if (!inside || inside.startsWith(`..${path.sep}`) || inside === ".." || path.isAbsolute(inside)) throw new Error("CMS native path escapes its root.");
  return resolved;
}


export { safeAncestors, syncDirectory, durableDirectory, readRegular, openRegular, fileFingerprint, nativePath };
