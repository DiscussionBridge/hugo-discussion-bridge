import { readFile } from "node:fs/promises";
import { migrateNativePublication } from "../src/adapter.mjs";

const input = JSON.parse(await readFile(process.argv[2], "utf8"));
await migrateNativePublication(input);
