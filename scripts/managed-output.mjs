import fs from "node:fs";
import path from "node:path";

export function lstatOrAbsent(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// Examine directory entries themselves, including dangling links, before any
// generated write. A missing leaf is not permission to follow a linked parent.
export function managedOutput(root, file, kind = "file") {
  const base = path.resolve(root);
  const target = path.resolve(file);
  const relative = path.relative(base, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Managed output escaped its component");
  const parts = relative ? relative.split(path.sep) : [];
  let current = base;
  let leaf = null;
  for (let index = 0; index <= parts.length; index++) {
    if (index) current = path.join(current, parts[index - 1]);
    const stat = lstatOrAbsent(current);
    const expected = index === parts.length ? kind : "directory";
    if (stat && (stat.isSymbolicLink() || (expected === "directory" ? !stat.isDirectory() : !stat.isFile()))) throw new Error(`Invalid or linked managed output: ${current}`);
    if (index === 0 && !stat) throw new Error("Managed output root is missing");
    if (index === parts.length) leaf = stat;
  }
  return leaf;
}
