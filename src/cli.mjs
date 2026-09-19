#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { migrateNativePublication, prepare, syncNativePublications } from "./adapter.mjs";
import { readOperationalState, summarizeOperationalState } from "./operational-state.mjs";

const args = process.argv.slice(2);
const command = args.shift();
if (!new Set(["new-id", "recover-existing-id", "prepare", "sync-publications", "publication-status", "migrate-publication"]).has(command)) throw new Error("Usage: discussionbridge-hugo new-id|recover-existing-id|prepare|sync-publications|publication-status|migrate-publication [options]");
const option = (name) => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}.`); return args[index + 1]; };
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
  serverUrl: process.env.DISCUSSIONBRIDGE_SERVER_URL,
  connectionId: process.env.DISCUSSIONBRIDGE_CONNECTION_ID,
  connectionSecret: (await readFile(secretFile, "utf8")).trim(),
  lane: process.env.DISCUSSIONBRIDGE_LANE
};
if (command === "prepare") {
  const result = await prepare({ manifestPath: option("--manifest"), outputPath: option("--output"), statePath: option("--state"), config });
  process.stdout.write(`Prepared ${result.records} DiscussionBridge records from ${result.pages} Hugo pages.\n`);
} else {
  const result = await syncNativePublications({ contentDir: option("--content-dir"), siteUrl: option("--site-url"), config });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.failed) process.exitCode = 1;
}
