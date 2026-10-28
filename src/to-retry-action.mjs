import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import path from "node:path";
import { getCmsProcessIdentity } from "./native-lock.mjs";
import { validateCms } from "./protocol-v4/cms-runtime.mjs";

const issued = new WeakSet();
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const unavailable = () => Object.assign(new Error("Hugo local operator Retry action needs reconciliation."), { code: "native_ownership_conflict" });

// Audit evidence from the actual local protected CLI process, never a caller's
// free-form actor label or an authority/repair attestation sent to the receiver.
export function validateLocalRetryRecord(action) {
  if (!exact(action, ["schema_version", "action_id", "command", "page_key", "state_path", "config_path", "refused_mutation_id", "invoked_at", "operator"])
      || action.schema_version !== "db-hugo-local-source-retry-action-1" || action.command !== "retry-source"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(action.page_key)
      || !path.isAbsolute(action.state_path) || !path.isAbsolute(action.config_path)) throw unavailable();
  validateCms("UUID", action.action_id); validateCms("UUID", action.refused_mutation_id); validateCms("Instant", action.invoked_at);
  const operator = action.operator;
  if (!exact(operator, ["username", "uid", "gid", "platform", "pid", "executable", "process_identity"])
      || typeof operator.username !== "string" || !operator.username || Buffer.byteLength(operator.username) > 4096 || /\p{Cc}/u.test(operator.username)
      || !Number.isSafeInteger(operator.uid) || operator.uid < -1 || !Number.isSafeInteger(operator.gid) || operator.gid < -1
      || !["win32", "linux"].includes(operator.platform) || !Number.isSafeInteger(operator.pid) || operator.pid < 1
      || !path.isAbsolute(operator.executable)) throw unavailable();
  const identity = operator.process_identity;
  const fields = operator.platform === "win32" ? ["platform", "pid", "start"] : ["platform", "pid", "start", "boot", "uid"];
  if (!exact(identity, fields) || identity.platform !== operator.platform || identity.pid !== operator.pid
      || typeof identity.start !== "string" || !/^[0-9]+$/u.test(identity.start)) throw unavailable();
  if (operator.platform === "linux") {
    validateCms("UUID", identity.boot);
    if (identity.uid !== operator.uid) throw unavailable();
  }
  return action;
}

export async function captureLocalRetryAction({ configPath, statePath, pageKey, refusedMutationId }) {
  validateCms("UUID", refusedMutationId);
  const principal = userInfo({ encoding: "utf8" }), observed = await getCmsProcessIdentity(process.pid);
  if (observed.state !== "present") throw unavailable();
  const action = validateLocalRetryRecord({ schema_version: "db-hugo-local-source-retry-action-1", action_id: randomUUID(),
    command: "retry-source", page_key: pageKey, state_path: path.resolve(statePath), config_path: path.resolve(configPath),
    refused_mutation_id: refusedMutationId, invoked_at: new Date().toISOString(),
    operator: { username: principal.username, uid: principal.uid, gid: principal.gid, platform: process.platform,
      pid: process.pid, executable: process.execPath, process_identity: structuredClone(observed.identity) } });
  // Keep an immutable private copy for the live action as well as the persisted
  // record. A mutation between local capture and the writer cannot change scope.
  const frozen = JSON.stringify(action);
  Object.freeze(action.operator.process_identity); Object.freeze(action.operator); Object.freeze(action);
  issued.add(action);
  if (JSON.stringify(action) !== frozen) throw unavailable();
  return action;
}

export function assertLocalRetryAction(action, { statePath, pageKey, refusedMutationId }) {
  if (!issued.has(action)) throw unavailable();
  validateLocalRetryRecord(action);
  if (action.state_path !== path.resolve(statePath) || action.page_key !== pageKey || action.refused_mutation_id !== refusedMutationId) throw unavailable();
  return structuredClone(action);
}
