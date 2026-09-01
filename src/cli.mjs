#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { prepare } from "./adapter.mjs";

const args = process.argv.slice(2);
if (args.shift() !== "prepare") throw new Error("Usage: discussionbridge-hugo prepare --manifest FILE --output FILE");
const option = (name) => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}.`); return args[index + 1]; };
const secretFile = process.env.DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE;
if (!secretFile) throw new Error("DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE is required.");
const result = await prepare({
  manifestPath: option("--manifest"), outputPath: option("--output"),
  config: {
    serverUrl: process.env.DISCUSSIONBRIDGE_SERVER_URL,
    connectionId: process.env.DISCUSSIONBRIDGE_CONNECTION_ID,
    connectionSecret: (await readFile(secretFile, "utf8")).trim(),
    lane: process.env.DISCUSSIONBRIDGE_LANE
  }
});
process.stdout.write(`Prepared ${result.records} DiscussionBridge records from ${result.pages} Hugo pages.\n`);
