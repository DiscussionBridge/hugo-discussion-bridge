import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { getCmsProcessIdentity } from "./native-lock.mjs";
import { nativeSemanticJson } from "./native-state.mjs";

const attention = () => new Error("Hugo CMS native command ownership or execution requires attention.");
export function validateCmsNativeCommand(command) {
  if (typeof command?.executable !== "string" || !command.executable || command.executable.includes("\0")
      || !Array.isArray(command.args) || command.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
      || !Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 600000) throw attention();
  return command;
}
export async function runCmsNativeCommand({ kind, transactionId, command, values, continuation, assertFence, signal }) {
  if (!["build", "deploy"].includes(kind)) throw attention();
  validateCmsNativeCommand(command);
  const args = command.args.map((arg) => arg.replace(/\{([a-z_]+)\}/gu, (_, key) => { if (!Object.hasOwn(values, key)) throw attention(); return values[key]; }));
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (key.startsWith("DISCUSSIONBRIDGE_")) delete environment[key];
  for (const [key, value] of Object.entries(command.environment ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== "string" || value.includes("\0") || key.startsWith("DISCUSSIONBRIDGE_CONNECTION")) throw attention();
    environment[key] = value;
  }
  const identity = createHash("sha256").update(nativeSemanticJson({ executable: command.executable, args, environment: command.environment ?? {}, cwd: values.site_root })).digest("hex");
  const name = `native/${transactionId}/${kind}.json`, prior = await continuation.nativeRecord(name);
  if (prior !== null) {
    if (prior.command_sha256 !== identity || prior.transaction_id !== transactionId || prior.kind !== kind) throw attention();
    // Process absence does not prove a previous build/deploy made no mutation.
    if (prior.phase !== "completed") throw attention();
    await assertFence();
    return { kind, completed_at: prior.completed_at };
  }
  await assertFence();
  const record = { transaction_id: transactionId, kind, command_sha256: identity, phase: "intent", owner_pid: null, process_identity: null, completed_at: null };
  await continuation.nativeRecord(name, record);
  const child = spawn(command.executable, args, { cwd: values.site_root, env: environment, stdio: "ignore", shell: false, windowsHide: true });
  let timer, hardStop, aborted = false, failed = false;
  const stop = () => { aborted = true; child.kill(); hardStop ??= setTimeout(() => child.kill("SIGKILL"), 2000); };
  signal?.addEventListener("abort", stop, { once: true }); if (signal?.aborted) stop();
  const completed = new Promise((resolve) => {
    child.once("error", () => { failed = true; });
    child.once("close", (code) => resolve(!failed && code === 0));
    timer = setTimeout(stop, command.timeoutMs);
  });
  try {
    const owner = child.pid ? await getCmsProcessIdentity(child.pid) : { state: "unknown" };
    if (owner.state === "present") { record.phase = "running"; record.owner_pid = child.pid; record.process_identity = owner.identity; await continuation.nativeRecord(name, record); }
    const success = await completed;
    if (!success || aborted) throw attention();
    await assertFence(); record.phase = "completed"; record.completed_at = new Date().toISOString(); await continuation.nativeRecord(name, record);
    return { kind, completed_at: record.completed_at };
  } catch (error) { if (child.exitCode === null) child.kill("SIGKILL"); await completed; throw error; }
  finally { clearTimeout(timer); clearTimeout(hardStop); signal?.removeEventListener("abort", stop); }
}
