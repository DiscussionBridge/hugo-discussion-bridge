#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { prepare, syncNativePublications } from "./adapter.mjs";
import { readOperationalState, summarizeOperationalState } from "./operational-state.mjs";

const args = process.argv.slice(2);
const command = args.shift();
if (!new Set(["prepare", "sync-publications", "publication-status"]).has(command)) throw new Error("Usage: discussionbridge-hugo prepare|sync-publications|publication-status [options]");
const option = (name) => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}.`); return args[index + 1]; };
if (command === "publication-status") {
  process.stdout.write(`${JSON.stringify(summarizeOperationalState(await readOperationalState(option("--state"))))}\n`);
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
