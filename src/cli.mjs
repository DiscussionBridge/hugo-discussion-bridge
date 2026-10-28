#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readRegular } from "./native-io.mjs";
import { parseCmsJson, candidateId, wireVersion } from "./protocol-v4/cms-runtime.mjs";
import { prepare, preparePublicDiscussions, moveSourceUrl, retrySource } from "./adapter.mjs";
import { captureLocalRetryAction } from "./to-retry-action.mjs";
import { runHugoNativeCms, runHugoAttention } from "./cms-native.mjs";
import { readOperationalState, summarizeOperationalState } from "./operational-state.mjs";
import { PRODUCT_VERSION } from "./version.mjs";

const usage = `discussionbridge-hugo ${PRODUCT_VERSION} (${wireVersion}, unpublished development)
Commands:
  prepare --config FILE --manifest FILE --output FILE --state FILE
  retry-source --config FILE --manifest FILE --output FILE --state FILE --key PAGE --refused-mutation UUID
  sync-publications --config FILE
  check-attention --config FILE
  restore-baseline --config FILE --mapping UUID --transaction UUID --operation UUID
  deploy-restored-baseline --config FILE --mapping UUID --transaction UUID --operation UUID
  move-presentation --config FILE --mapping UUID --mapping-revision REVISION --new-url HTTPS_URL
  prepare-public --config FILE --manifest FILE --output FILE
  source-status --state FILE
  move-source --config FILE --manifest FILE --state FILE --key PAGE --new-url HTTPS_URL
  abort-source-move --config FILE --manifest FILE --state FILE --key PAGE --new-url HTTPS_URL
  version
Native commands are local structured argv in the protected configuration.`;
function options(argv) {
  const result = Object.create(null);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!/^--(?:config|manifest|output|state|key|mapping|mapping-revision|new-url|refused-mutation|transaction|operation)$/u.test(key) || argv[i + 1] === undefined || Object.hasOwn(result, key.slice(2))) throw new Error("Invalid Hugo command options.");
    result[key.slice(2)] = argv[i + 1];
  }
  return result;
}
async function configuration(file, connected) {
  const bytes = await readRegular(path.resolve(file)); if (bytes === null) throw new Error("Hugo configuration is unavailable.");
  const config = parseCmsJson(bytes, { maximumBytes: 262144 });
  if (Object.hasOwn(config, "connectionSecret")) throw new Error("Use the protected connectionSecretFile setting.");
  if (connected) {
    if (typeof config.connectionSecretFile !== "string" || !path.isAbsolute(config.connectionSecretFile)) throw new Error("An absolute protected connectionSecretFile is required.");
    const secret = await readRegular(config.connectionSecretFile); if (secret === null) throw new Error("Hugo connection secret file is unavailable.");
    config.connectionSecret = new TextDecoder("utf-8", { fatal: true }).decode(secret).replace(/\r?\n$/u, "");
  }
  return config;
}
export async function runCli(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const [command, ...args] = argv;
  if (!command || ["help", "--help"].includes(command)) { stdout.write(usage + "\n"); return 0; }
  if (command === "version") { stdout.write(JSON.stringify({ version: PRODUCT_VERSION, wire_version: wireVersion, candidate_id: candidateId, release_version: null }) + "\n"); return 0; }
  try {
    const value = options(args), required = {
      prepare: ["config", "manifest", "output", "state"], "sync-publications": ["config"], "prepare-public": ["config", "manifest", "output"],
      "check-attention": ["config"], "restore-baseline": ["config", "mapping", "transaction", "operation"],
      "deploy-restored-baseline": ["config", "mapping", "transaction", "operation"],
      "retry-source": ["config", "manifest", "output", "state", "key", "refused-mutation"],
      "source-status": ["state"], "move-source": ["config", "manifest", "state", "key", "new-url"],
      "abort-source-move": ["config", "manifest", "state", "key", "new-url"], "move-presentation": ["config", "mapping", "mapping-revision", "new-url"] }[command];
    if (!required || required.some((key) => !value[key]) || Object.keys(value).some((key) => !required.includes(key))) throw new Error("Invalid Hugo command options.");
    let result;
    if (command === "source-status") result = summarizeOperationalState(await readOperationalState(path.resolve(value.state)));
    else {
      const config = await configuration(value.config, command !== "prepare-public");
      if (command === "sync-publications") result = await runHugoNativeCms({ native: config.native, connectionConfig: config });
      else if (["check-attention", "restore-baseline", "deploy-restored-baseline"].includes(command)) result = await runHugoAttention({ native: config.native, connectionConfig: config,
        operation: command === "check-attention" ? "check" : command, mappingId: value.mapping, transactionId: value.transaction, operationId: value.operation });
      else if (command === "move-presentation") result = await runHugoNativeCms({ native: config.native, connectionConfig: config,
        presentationMove: { mappingId: value.mapping, expectedMappingRevision: value["mapping-revision"], newUrl: value["new-url"] } });
      else {
        const request = { config, manifestPath: path.resolve(value.manifest), ...(value.output ? { outputPath: path.resolve(value.output) } : {}), ...(value.state ? { statePath: path.resolve(value.state) } : {}) };
        if (command === "prepare") result = (await prepare(request)).status;
        else if (command === "retry-source") {
          const localAction = await captureLocalRetryAction({ configPath: path.resolve(value.config), statePath: request.statePath,
            pageKey: value.key, refusedMutationId: value["refused-mutation"] });
          result = await retrySource({ ...request, pageKey: value.key, refusedMutationId: value["refused-mutation"], localAction });
        }
        else if (command === "prepare-public") result = { prepared_pages: Object.keys(await preparePublicDiscussions(request)).length };
        else if (["move-source", "abort-source-move"].includes(command)) {
          const moved = await moveSourceUrl({ ...request, pageKey: value.key, newUrl: value["new-url"], abortMove: command === "abort-source-move" });
          result = { phase: moved.record ? "committed" : moved.move.state, move_id: moved.move_id ?? moved.move.move_id };
        }
      }
    }
    stdout.write(JSON.stringify(result) + "\n"); return 0;
  } catch (error) {
    // No raw request, secret, source HTML, command output or arbitrary cause is logged.
    const code = typeof error.code === "string" && /^[a-z_]+$/u.test(error.code) ? error.code : "local_operation_incomplete";
    stderr.write(`Hugo operation incomplete: ${code}. Inspect protected native state before retrying.\n`); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await runCli(process.argv.slice(2));
