import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCmsPrivateDirectory } from "./cms-journal.mjs";
import { runCmsNativeCommand } from "./native-command.mjs";
import { parseCmsJson } from "./protocol-v4/cms-runtime.mjs";

// This format is absent from the normal site's output configuration. Its
// temporary all-content configuration/output live beside protected state only.
const captureConfiguration = `[outputFormats.DiscussionBridgeSourceLifecycle]
mediaType = "application/json"
baseName = "discussionbridge-source-lifecycle"
isPlainText = true
[outputs]
home = ["DiscussionBridgeSourceLifecycle"]
page = []
section = []
taxonomy = []
term = []
[segments.discussionbridge-source-lifecycle]
[[segments.discussionbridge-source-lifecycle.includes]]
output = "DiscussionBridgeSourceLifecycle"
`;
export async function captureToLifecycle({ statePath, config, state, save, assertFence }) {
  if (config.toNative.lifecycleCommand === undefined) return null;
  if (state.toLifecycleCapture && state.toLifecycleCapture.value.phase !== "completed") throw Object.assign(new Error("Hugo native lifecycle capture needs reconciliation."), { code: "native_restore_required" });
  const transactionId = randomUUID(), output = path.join(path.dirname(path.resolve(statePath)), ".to-captures", transactionId);
  await createCmsPrivateDirectory(output);
  const captureConfig = path.join(output, "source-lifecycle.toml");
  await writeFile(captureConfig, captureConfiguration, { flag: "wx", mode: 0o600 });
  await runCmsNativeCommand({ kind: "build", transactionId, command: config.toNative.lifecycleCommand,
    values: { transaction_id: transactionId, site_root: config.toNative.siteRoot, public_root: output, capture_config: captureConfig, receipt_path: `${statePath}.lifecycle-receipt.json` },
    continuation: { async nativeRecord(name, value) {
      if (value === undefined) return state.toLifecycleCapture?.name === name ? state.toLifecycleCapture.value : null;
      state.toLifecycleCapture = { name, value }; await save();
    } }, assertFence });
  await assertFence();
  return parseCmsJson(await readFile(path.join(output, "discussionbridge-source-lifecycle.json")), { maximumBytes: Number.MAX_SAFE_INTEGER });
}
