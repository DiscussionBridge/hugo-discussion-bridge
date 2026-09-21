#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { migrateNativePublication, prepare, syncNativePublications } from "./adapter.mjs";
import { ForumBridgeClient } from "./forum-bridge-client.mjs";
import { finalizeForumPublications, prepareForumPublications, prepareQueuedForumPublications } from "./forum-publication-sync.mjs";
import { readOperationalState, summarizeOperationalState } from "./operational-state.mjs";

const args = process.argv.slice(2);
const command = args.shift();
if (!new Set(["new-id", "recover-existing-id", "prepare", "sync-publications", "publication-status", "migrate-publication", "prepare-forum-publications", "prepare-publication-work", "finalize-forum-publications"]).has(command)) throw new Error("Usage: discussionbridge-hugo new-id|recover-existing-id|prepare|sync-publications|publication-status|migrate-publication|prepare-forum-publications|prepare-publication-work|finalize-forum-publications [options]");
const option = (name) => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}.`); return args[index + 1]; };
const optional = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
if (command === "new-id") {
  if (args.length) throw new Error("new-id accepts no options.");
  process.stdout.write(`hugo-page:${randomBytes(32).toString("hex")}\n`);
  process.exit(0);
}
if (command === "recover-existing-id") {
  const state = await readOperationalState(option("--state"));
  const rawUrl = option("--canonical-url");
  const canonicalUrl = new URL(rawUrl);
  if (canonicalUrl.protocol !== "https:" || canonicalUrl.username || canonicalUrl.password ||
      canonicalUrl.search || canonicalUrl.hash || canonicalUrl.href !== rawUrl) {
    throw new Error("--canonical-url must be the exact prior HTTPS canonical URL stored by the adapter.");
  }
  const matches = Object.values(state.operations).filter((operation) => operation.canonicalUrl === canonicalUrl.href);
  if (matches.length !== 1 || !/^hugo-page:[0-9a-f]{64}$/.test(matches[0].externalId)) {
    throw new Error("The Hugo publication state does not contain one exact existing identity for that canonical URL.");
  }
  process.stdout.write(`${matches[0].externalId}\n`);
  process.exit(0);
}
if (command === "publication-status") {
  process.stdout.write(`${JSON.stringify(summarizeOperationalState(await readOperationalState(option("--state"))))}\n`);
  process.exit(0);
}
if (command === "migrate-publication") {
  const result = await migrateNativePublication({
    contentDir: option("--content-dir"), siteUrl: option("--site-url"), resourceId: option("--resource-id"),
    oldUrl: option("--old-url"), newUrl: option("--new-url"), redirectsFile: option("--redirects-file"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}
const secretFile = process.env.DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE;
if (!secretFile) throw new Error("DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE is required.");
const config = {
  serverUrl: new URL(process.env.DISCUSSIONBRIDGE_SERVER_URL).origin,
  connectionId: process.env.DISCUSSIONBRIDGE_CONNECTION_ID,
  connectionSecret: (await readFile(secretFile, "utf8")).trim(),
  lane: process.env.DISCUSSIONBRIDGE_LANE
};
const sectionsFile = optional("--sections-file");
const sections = sectionsFile ? JSON.parse(await readFile(sectionsFile, "utf8")) : [];
if (command === "prepare-forum-publications" || command === "prepare-publication-work") {
  const operation = command === "prepare-forum-publications" ? prepareForumPublications : prepareQueuedForumPublications;
  const result = await operation({
    contentDir: option("--content-dir"), siteUrl: option("--site-url"), stateFile: option("--state"),
    config, bridge: new ForumBridgeClient(config), sections,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.failed) process.exitCode = 1;
} else if (command === "finalize-forum-publications") {
  const result = await finalizeForumPublications({ stateFile: option("--state"), bridge: new ForumBridgeClient(config) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.failed) process.exitCode = 1;
} else if (command === "prepare") {
  const result = await prepare({ manifestPath: option("--manifest"), outputPath: option("--output"), statePath: option("--state"), config });
  process.stdout.write(`Prepared ${result.records} DiscussionBridge records from ${result.pages} Hugo pages.\n`);
} else {
  const result = await syncNativePublications({ contentDir: option("--content-dir"), siteUrl: option("--site-url"), config });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.failed) process.exitCode = 1;
}
