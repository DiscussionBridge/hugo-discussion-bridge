import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";

const ownershipKeys = new Set(["discussionbridge_native_publication", "discussionbridge_resource_id", "discussionbridge_topic_id", "discussionbridge_source_revision", "discussionbridge_adapter_version"]);
const managedKeys = new Set(["title", "description", "summary", "date", "lastmod", "discussionbridge_source_author", "discussionbridge_source_created_at", "discussionbridge_source_updated_at", "discussionbridge_forum_name"]);
const metadataKeys = new Set([...ownershipKeys, ...managedKeys, "discussionbridge_source_edition", "discussionbridge_source_managed", "draft", "discussionbridge_withdrawn", "discussionbridge_withdrawal_draft", "discussionbridge_withdrawal_recovery"]);

function ownedFrontMatter(contents, item) {
  const opening = /^\uFEFF?\+\+\+\r?\n/u.exec(contents);
  if (!opening) throw new Error("Hugo publication has no owned TOML front matter.");
  const closing = /(?:^|\n)\+\+\+[ \t]*(?:\r?\n|$)/gu;
  closing.lastIndex = opening[0].length;
  const end = closing.exec(contents);
  if (!end) throw new Error("Hugo publication front matter is incomplete.");
  const headerEnd = end.index + (contents[end.index] === "\n" ? 1 : 0);
  const header = contents.slice(opening[0].length, headerEnd);
  const values = new Map();
  const ranges = new Map();
  let table = false;
  let tableStart = null;
  let multiline = null;
  let offset = 0;
  for (const segment of header.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const line = segment.replace(/\r?\n$/u, "");
    const lineOffset = offset;
    offset += segment.length;
    if (multiline) { if (line.includes(multiline)) multiline = null; continue; }
    const triple = line.match(/(?:"""|''')/u)?.[0];
    if (triple && line.split(triple).length === 2) { multiline = triple; continue; }
    if (/^[ \t]*\[/u.test(line)) { table = true; tableStart ??= lineOffset; }
    if (table) continue;
    const field = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/u.exec(line);
    if (!field || !metadataKeys.has(field[1])) continue;
    if (values.has(field[1])) throw new Error("Hugo publication ownership is ambiguous.");
    const scalar = /^(true|false|[0-9]+|"(?:[^"\\]|\\.)*"|'[^']*')[ \t]*(?:#.*)?$/u.exec(field[2]);
    if (!scalar) throw new Error("Hugo publication ownership metadata is invalid.");
    const raw = scalar[1];
    const value = raw.startsWith("'") ? raw.slice(1, -1) : JSON.parse(raw);
    values.set(field[1], value);
    const start = lineOffset + line.length - field[2].length;
    ranges.set(field[1], { start, end: start + raw.length });
  }
  if (values.get("discussionbridge_native_publication") !== true
      || typeof values.get("discussionbridge_resource_id") !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(values.get("discussionbridge_resource_id"))
      || !Number.isSafeInteger(values.get("discussionbridge_topic_id")) || values.get("discussionbridge_topic_id") < 1
      || (item && (values.get("discussionbridge_resource_id").toLowerCase() !== item.resourceId || values.get("discussionbridge_topic_id") !== item.topicId))) {
    throw new Error("Hugo publication identity collision.");
  }
  return { start: opening[0].length, end: headerEnd, header, ranges, values, tableStart };
}

export function nativePublicationIdentity(contents) {
  try { const { values } = ownedFrontMatter(contents); return { resourceId: values.get("discussionbridge_resource_id").toLowerCase(), topicId: values.get("discussionbridge_topic_id") }; }
  catch { return null; }
}

function updateHeader(parsed, fields, newline) {
  const replacements = []; const additions = [];
  for (const [key, value] of Object.entries(fields)) {
    const range = parsed.ranges.get(key);
    if (range) replacements.push({ ...range, value: JSON.stringify(value) });
    else additions.push(`${key} = ${JSON.stringify(value)}${newline}`);
  }
  let header = parsed.header;
  for (const change of replacements.sort((a, b) => b.start - a.start)) header = header.slice(0, change.start) + change.value + header.slice(change.end);
  const insertion = parsed.tableStart === null ? header.length : parsed.tableStart + replacements.filter((change) => change.start < parsed.tableStart).reduce((delta, change) => delta + change.value.length - (change.end - change.start), 0);
  return header.slice(0, insertion) + additions.join("") + header.slice(insertion);
}

async function unlinkedPath(file) {
  let current = path.parse(path.resolve(file)).root;
  for (const part of path.resolve(file).slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("Hugo publication path must not be linked."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

async function syncDirectory(directory) {
  // Node does not expose directory fsync on Windows. POSIX commits need the
  // directory entry persisted in addition to the temporary file's contents.
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function mkdirDurably(directory) {
  const firstCreated = await mkdir(directory, { recursive: true });
  if (!firstCreated || process.platform === "win32") return;
  let current = path.resolve(directory);
  for (;;) {
    await syncDirectory(current);
    if (current === path.resolve(firstCreated)) break;
    current = path.dirname(current);
  }
  await syncDirectory(path.dirname(firstCreated));
}

export async function writeNativePublication(file, generated, item) {
  await unlinkedPath(file);
  if (item.integrationDeclined && !item.withdrawn) return "not_selected";
  if (item.withdrawn || item.createSelected === false) { try { await readFile(file); } catch (error) { if (error.code === "ENOENT") return item.withdrawn ? "skipped" : "not_selected"; throw error; } }
  await mkdirDurably(path.dirname(file));
  const release = await lockfile.lock(file, { realpath: false, retries: 0 });
  let temp;
  try {
    await unlinkedPath(file);
    let prior;
    try { prior = await readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    let output = generated;
    if (prior !== undefined) {
      const parsed = ownedFrontMatter(prior, item);
      if (item.withdrawn) {
        if (parsed.values.get("discussionbridge_withdrawn") === true && parsed.values.get("discussionbridge_source_edition") === item.edition) return "unchanged";
        const recovery = Object.fromEntries([...parsed.values].filter(([key]) => managedKeys.has(key)));
        const withdrawnManaged = { ...recovery, title: "Source publication withdrawn", description: "Source publication withdrawn", summary: "Source publication withdrawn" };
        const fields = { ...withdrawnManaged, draft: true, discussionbridge_withdrawn: true, discussionbridge_withdrawal_draft: parsed.values.get("draft") === true, discussionbridge_withdrawal_recovery: JSON.stringify(recovery), discussionbridge_source_edition: item.edition, discussionbridge_source_managed: JSON.stringify(withdrawnManaged) };
        const header = updateHeader(parsed, fields, prior.includes("\r\n") ? "\r\n" : "\n");
        output = prior.slice(0, parsed.start) + header + prior.slice(parsed.end);
      } else {
      if (!parsed.ranges.has("discussionbridge_source_revision")) throw new Error("Hugo publication source revision is missing.");
      const changed = item.edition ? parsed.values.get("discussionbridge_source_edition") !== item.edition : parsed.values.get("discussionbridge_source_revision") !== item.revision;
      if (!changed) return "unchanged";
      const managed = item.managedFields ?? {};
      if (Object.keys(managed).some((key) => !managedKeys.has(key))) throw new Error("Hugo managed publication fields are invalid.");
      const saved = parsed.values.get("discussionbridge_source_managed");
      if (saved !== undefined) {
        const previous = JSON.parse(saved);
        if (!previous || Array.isArray(previous) || typeof previous !== "object") throw new Error("Hugo managed publication evidence is invalid.");
        for (const [key, value] of Object.entries(previous)) {
          if (!managedKeys.has(key) || parsed.values.get(key) !== value) throw new Error(`Hugo source-managed field ${key} was edited locally; publication needs attention.`);
        }
      }
      const fields = { ...managed, discussionbridge_source_revision: item.revision };
      if (parsed.values.get("discussionbridge_withdrawn") === true) Object.assign(fields, { draft: parsed.values.get("discussionbridge_withdrawal_draft") === true, discussionbridge_withdrawn: false });
      if (item.edition) fields.discussionbridge_source_edition = item.edition;
      if (Object.keys(managed).length) fields.discussionbridge_source_managed = JSON.stringify(managed);
      const header = updateHeader(parsed, fields, prior.includes("\r\n") ? "\r\n" : "\n");
      output = prior.slice(0, parsed.start) + header + prior.slice(parsed.end);
      if (output === prior) return "unchanged";
      }
    }
      else if (item.withdrawn) return "skipped";
      else if (item.createSelected === false) return "not_selected";
    temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    const handle = await open(temp, "wx");
    try { await handle.writeFile(output, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await unlinkedPath(file);
    if (prior === undefined) await link(temp, file); // Exclusive first claim, never replace an existing path.
    else {
      if (await readFile(file, "utf8") !== prior) throw new Error("Hugo publication changed during synchronization.");
      await rename(temp, file);
    }
    await syncDirectory(path.dirname(file));
    return prior === undefined ? "created" : item.withdrawn ? "withdrawn" : "updated";
  } finally {
    if (temp) await rm(temp, { force: true });
    await release();
  }
}
